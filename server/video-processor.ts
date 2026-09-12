import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import sharp from "sharp";

// Per-frame work that is independent between frames (decoding a signature,
// probing a frame, writing a cropped copy) is run a few frames at a time.
// Each sharp call spends nearly all of its time in a native worker thread, so
// one in flight leaves the other cores idle; the cap keeps the number of live
// decode buffers bounded regardless of how many frames were uploaded.
const IO_CONCURRENCY = Math.max(1, Math.min(4, os.cpus().length));

// --- Server dedup ---
const SIMILARITY_THRESHOLD = 0.93;   // 16×16 perceptual hash (was 8×8 at 0.90)
const DEDUP_HASH_SIZE = 16;           // 16×16 = 256 pixels (was 8×8=64)

// --- Sticky detection ---
const HEADER_SAMPLE_FRAMES = 7;
const HEADER_ROW_MATCH_THRESHOLD = 0.96;
const HEADER_MIN_HEIGHT = 40;
const HEADER_MAX_RATIO = 0.50;        // search up to 50% of frame (was 15%)
const HEADER_PIXEL_TOLERANCE = 10;

// --- Overlap / NCC ---
// The search must span every overlap a real recording can produce: a fast
// flick leaves only a sliver of shared content, while dense sampling of a slow
// scroll leaves almost the whole frame shared. Anything outside this window is
// invisible to the matcher and silently becomes a "gap", so the bounds are
// wide and false matches are rejected by confidence instead (see
// nccThresholdFor: small overlaps carry fewer rows, so they must score higher).
const OVERLAP_MIN_FRACTION = 0.04;
const OVERLAP_MIN_ABS = 24;           // absolute floor in px
// Ceiling sits just under a whole frame: dense sampling of a slow scroll leaves
// almost everything shared, and a pair that lands above the ceiling would score
// noise and be called a gap. Matching at 98% is not a false positive — the
// selection step recognises it as a near-duplicate and skips the frame.
const OVERLAP_MAX_FRACTION = 0.99;    // search ceiling as fraction of frame height
// Below this fraction an overlap is "small": too few rows for a modest NCC to
// be trustworthy, so the confidence requirement ramps up to +SMALL_PENALTY.
const OVERLAP_SMALL_FRACTION = 0.25;
const OVERLAP_SMALL_PENALTY = 0.10;
const NCC_SAMPLE_WIDTH = 64;          // downsample X to this width before NCC
const NCC_COARSE_STEP = 8;            // px — coarse search step
const NCC_FINE_RANGE = 16;            // px — fine-search ± around coarse winner
const NCC_FINE_STEP = 1;              // px — fine-search resolution
// Banded scoring: the overlap is also scored in this many slices so a locally
// changed region (a loaded image, a playing video) cannot sink the whole match.
const NCC_MAX_BANDS = 9;
const NCC_MIN_BAND_ROWS = 12;         // below this a band is too noisy to score

// Undetected sticky chrome (an OS status bar with a live clock, a recording
// timer, a home indicator) defeats sticky DETECTION because its pixels change
// between sampled frames — yet it still sits at the same screen position in
// every frame, poisoning the edges of every overlap comparison and dragging
// true seams just below the confidence threshold. Excluding a guard band at
// both ends of the compared window makes the measurement immune to it.
const STICKY_GUARD_FRACTION = 0.08;  // of frame height, capped at 25% of the overlap

// Adaptive NCC confidence. A fixed 0.85 rejects valid matches on dark or
// low-contrast screens where JPEG noise dominates the (small) signal, so the
// threshold scales with the measured contrast (grayscale stddev) of the two
// search regions: full 0.85 at/above NCC_CONTRAST_HIGH, floor 0.75 at/below
// NCC_CONTRAST_LOW, linear in between.
const NCC_CONFIDENCE_MAX = 0.85;
const NCC_CONFIDENCE_MIN = 0.75;
const NCC_CONTRAST_LOW = 8;
const NCC_CONTRAST_HIGH = 40;

// --- Greedy frame selection ---
// Keep a frame when its overlap with the last kept frame is within the target
// window; skip near-duplicates and overly redundant frames, hoping a later
// frame gives a better seam. Skipped-but-measurable frames are remembered as a
// fallback so a too-greedy skip never turns into a gap.
const SELECT_TARGET_MAX_FRACTION = 0.60; // keep when overlap ≤ 60% of frame height
const SELECT_NEAR_DUP_FRACTION = 0.80;   // overlap > 80% → near-duplicate, skip
const SELECT_NEAR_DUP_SIMILARITY = 0.90; // perceptual similarity → near-duplicate, skip

// --- Output safety limits ---
const JPEG_MAX_DIMENSION = 65500;        // hard JPEG format limit
const MAX_OUTPUT_PIXELS = 200_000_000;   // ~600 MB RGB — refuse absurd outputs

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type ProgressCallback = (done: number, total: number) => void;

/**
 * Map `items` through `fn` with at most `limit` calls in flight, preserving
 * input order in the result.
 *
 * `onProgress` fires once per completion, so the counter it reports is
 * monotonic even though the work itself finishes out of order.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: ProgressCallback
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
      onProgress?.(++done, items.length);
    }
  };

  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

interface FrameSignature {
  /** Plain 16×16 greyscale thumbnail. */
  raw: Buffer;
  /** Contrast-normalised 16×16 thumbnail — separates dark/low-contrast frames
   * whose absolute pixel values all sit within the ±20 match tolerance. */
  norm: Buffer;
}

async function getFrameSignature(
  framePath: string,
  size: number = DEDUP_HASH_SIZE
): Promise<FrameSignature> {
  // One decode, not two: the normalised channel is derived from the already
  // downsampled thumbnail rather than from a second pass over the file. The
  // `greyscale()` on the re-fed buffer is not decoration — without it sharp
  // normalises into sRGB and hands back three channels.
  const raw = await sharp(framePath).resize(size, size, { fit: "fill" }).greyscale().raw().toBuffer();
  const norm = await sharp(raw, { raw: { width: size, height: size, channels: 1 } })
    .greyscale()
    .normalise()
    .raw()
    .toBuffer();
  return { raw, norm };
}

function bufferSimilarity(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return 0;
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) < 20) matches++;
  }
  return matches / a.length;
}

/**
 * Similarity of two frame signatures: the raw and the contrast-normalised
 * channel must BOTH agree for a high score (min). On dark screens the raw
 * channel saturates near 1.0 for any pair of frames, so the normalised
 * channel is what tells scrolled content apart; on static solid screens the
 * 16×16 cell averaging flattens sensor/JPEG noise, so both stay high and
 * duplicates are still caught.
 */
function sigSimilarity(a: FrameSignature, b: FrameSignature): number {
  return Math.min(bufferSimilarity(a.raw, b.raw), bufferSimilarity(a.norm, b.norm));
}

function greyStddev(buf: Buffer): number {
  const n = buf.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += buf[i];
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = buf[i] - mean;
    sq += d * d;
  }
  return Math.sqrt(sq / n);
}

// ---------------------------------------------------------------------------
// Frame validation — drop inputs sharp cannot decode
// ---------------------------------------------------------------------------

export async function validateFrames(
  framePaths: string[],
  onProgress?: ProgressCallback
): Promise<{ valid: string[]; warnings: string[] }> {
  const valid: string[] = [];
  const warnings: string[] = [];

  // Each frame is probed independently, so they run a few at a time; the
  // verdicts are collected in input order below so warnings stay in frame
  // order whatever order the probes finish in.
  const verdicts = await mapWithConcurrency(
    framePaths,
    IO_CONCURRENCY,
    async (framePath): Promise<string | null> => {
      try {
        // Tiny full decode: metadata() only reads the header and misses
        // truncated scan data, so force an actual decode of the pixels.
        const probe = await sharp(framePath)
          .resize(32, 32, { fit: "fill" })
          .greyscale()
          .raw()
          .toBuffer();

        // Uniform near-black frames are video-decoder glitches (iOS Safari can
        // paint the canvas before the seeked frame is decoded), not content —
        // they can never stitch and would force a gap on both sides. Legit dark
        // content keeps its structure and passes the spread test.
        let min = 255;
        let max = 0;
        for (let p = 0; p < probe.length; p++) {
          if (probe[p] < min) min = probe[p];
          if (probe[p] > max) max = probe[p];
        }
        return max - min < 5 && max < 12 ? "was blank (all black) and was skipped." : null;
      } catch {
        return "could not be decoded and was skipped.";
      }
    },
    onProgress
  );

  for (let i = 0; i < framePaths.length; i++) {
    const verdict = verdicts[i];
    if (verdict === null) {
      valid.push(framePaths[i]);
      continue;
    }
    const msg = `Frame ${i + 1} of ${framePaths.length} ${verdict}`;
    console.warn(`validateFrames: ${msg} (${path.basename(framePaths[i])})`);
    warnings.push(msg);
  }

  return { valid, warnings };
}

// ---------------------------------------------------------------------------
// Sticky detection (up to HEADER_MAX_RATIO of frame)
// ---------------------------------------------------------------------------

/**
 * Sticky height within one set of already-decoded strips.
 *
 * `strips` are `sampleWidth`-wide greyscale buffers of `maxCheckHeight` rows,
 * taken from the same screen position in every sampled frame.
 */
function stickyHeightFromStrips(
  strips: Buffer[],
  sampleWidth: number,
  maxCheckHeight: number,
  frameHeight: number,
  region: "top" | "bottom"
): number {
  let stickyHeight = 0;

  const checkRow = (row: number): boolean => {
    const rowStart = row * sampleWidth;
    const rowEnd = rowStart + sampleWidth;
    const refRow = strips[0].subarray(rowStart, rowEnd);
    for (let s = 1; s < strips.length; s++) {
      const cmpRow = strips[s].subarray(rowStart, rowEnd);
      let matches = 0;
      for (let p = 0; p < sampleWidth; p++) {
        if (Math.abs(refRow[p] - cmpRow[p]) < HEADER_PIXEL_TOLERANCE) matches++;
      }
      if (matches / sampleWidth < HEADER_ROW_MATCH_THRESHOLD) return false;
    }
    return true;
  };

  if (region === "top") {
    let consecutiveMisses = 0;
    for (let row = 0; row < maxCheckHeight; row++) {
      if (checkRow(row)) {
        stickyHeight = row + 1;
        consecutiveMisses = 0;
      } else {
        consecutiveMisses++;
        if (consecutiveMisses > 3) break;
      }
    }
  } else {
    let consecutiveMisses = 0;
    for (let row = maxCheckHeight - 1; row >= 0; row--) {
      if (checkRow(row)) {
        stickyHeight = maxCheckHeight - row;
        consecutiveMisses = 0;
      } else {
        consecutiveMisses++;
        if (consecutiveMisses > 3) break;
      }
    }
  }

  // Scale back to real pixel coordinates
  const realHeight = Math.round(stickyHeight * (frameHeight * HEADER_MAX_RATIO / maxCheckHeight));
  if (realHeight < HEADER_MIN_HEIGHT) return 0;
  return realHeight;
}

/**
 * Measure the sticky header and footer in one pass over the sampled frames.
 *
 * Header and footer used to be detected in separate passes, each decoding the
 * same sampled frames again. A frame is decoded once here instead, to a
 * full-height `sampleWidth`-wide greyscale buffer that both strips are sliced
 * out of — the vertical scale is 1:1, so a slice is pixel-for-pixel what a
 * region-limited extract produced.
 */
async function detectStickyRegions(
  framePaths: string[]
): Promise<{ headerHeight: number; footerHeight: number }> {
  const none = { headerHeight: 0, footerHeight: 0 };
  if (framePaths.length < 3) return none;

  const sampleCount = Math.min(framePaths.length, HEADER_SAMPLE_FRAMES);
  const indices: number[] = [];
  const step = Math.max(1, Math.floor((framePaths.length - 1) / (sampleCount - 1)));
  for (let i = 0; i < framePaths.length && indices.length < sampleCount; i += step) {
    indices.push(i);
  }
  if (!indices.includes(framePaths.length - 1) && framePaths.length > 1) {
    indices.push(framePaths.length - 1);
  }
  if (indices.length < 3) return none;

  const firstMeta = await sharp(framePaths[indices[0]]).metadata();
  const frameWidth = firstMeta.width || 0;
  const frameHeight = firstMeta.height || 0;
  if (!frameWidth || !frameHeight) return none;

  // Search up to HEADER_MAX_RATIO of frame height (was 15%, now 50%)
  const maxCheckHeight = Math.floor(frameHeight * HEADER_MAX_RATIO);
  const sampleWidth = Math.min(frameWidth, 300);

  const columns = await mapWithConcurrency(indices, IO_CONCURRENCY, (idx) =>
    sharp(framePaths[idx])
      .extract({ left: 0, top: 0, width: frameWidth, height: frameHeight })
      .resize(sampleWidth, frameHeight, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer()
  );

  const topStrips = columns.map((c) => c.subarray(0, maxCheckHeight * sampleWidth));
  const bottomStrips = columns.map((c) =>
    c.subarray((frameHeight - maxCheckHeight) * sampleWidth, frameHeight * sampleWidth)
  );

  return {
    headerHeight: stickyHeightFromStrips(topStrips, sampleWidth, maxCheckHeight, frameHeight, "top"),
    footerHeight: stickyHeightFromStrips(
      bottomStrips,
      sampleWidth,
      maxCheckHeight,
      frameHeight,
      "bottom"
    ),
  };
}

export async function detectAndRemoveStickyHeaders(
  framePaths: string[]
): Promise<{ paths: string[]; headerHeight: number; footerHeight: number }> {
  if (framePaths.length < 3) {
    return { paths: framePaths, headerHeight: 0, footerHeight: 0 };
  }

  const { headerHeight, footerHeight } = await detectStickyRegions(framePaths);

  console.log(`Sticky detection: header=${headerHeight}px, footer=${footerHeight}px`);

  if (headerHeight === 0 && footerHeight === 0) {
    return { paths: framePaths, headerHeight: 0, footerHeight: 0 };
  }

  const outputDir = path.join(os.tmpdir(), "scrollstitch-cropped");
  fs.mkdirSync(outputDir, { recursive: true });

  // Cropping is per-frame and independent — the slowest part of this stage is
  // the PNG re-encode, so the frames are cropped a few at a time.
  const croppedPaths = await mapWithConcurrency(
    framePaths,
    IO_CONCURRENCY,
    async (framePath, i) => {
      const meta = await sharp(framePath).metadata();
      const w = meta.width || 0;
      const h = meta.height || 0;

      const cropTop = i === 0 ? 0 : headerHeight;
      const cropBottom = i === framePaths.length - 1 ? 0 : footerHeight;
      const newHeight = h - cropTop - cropBottom;

      if (newHeight <= 0 || cropTop + cropBottom >= h) return framePath;
      if (cropTop === 0 && cropBottom === 0) return framePath;

      // PNG to avoid double-JPEG compression artifacts
      const outPath = path.join(outputDir, `cropped_${i}_${path.basename(framePath)}.png`);
      await sharp(framePath)
        .extract({ left: 0, top: cropTop, width: w, height: newHeight })
        .png()
        .toFile(outPath);
      return outPath;
    }
  );

  return { paths: croppedPaths, headerHeight, footerHeight };
}

// ---------------------------------------------------------------------------
// Server-side frame deduplication (16×16, threshold 0.93)
// ---------------------------------------------------------------------------

export async function deduplicateFrames(
  framePaths: string[],
  onProgress?: ProgressCallback
): Promise<string[]> {
  if (framePaths.length === 0) return [];
  if (framePaths.length === 1) return framePaths;

  // Every frame's signature is needed regardless of what the comparisons
  // decide, and none of them depends on another — so they are computed a few
  // at a time and the (cheap, order-dependent) comparison walk runs after.
  // A signature is 2×256 bytes, so holding them all costs nothing.
  const signatures = await mapWithConcurrency(
    framePaths,
    IO_CONCURRENCY,
    (framePath) => getFrameSignature(framePath),
    onProgress
  );

  const unique: string[] = [framePaths[0]];
  let prevSig = signatures[0];

  for (let i = 1; i < framePaths.length; i++) {
    const sim = sigSimilarity(prevSig, signatures[i]);
    if (sim < SIMILARITY_THRESHOLD) {
      unique.push(framePaths[i]);
      prevSig = signatures[i];
    }
  }

  return unique;
}

// ---------------------------------------------------------------------------
// NCC-based overlap detection — global maximum, no directional bias
// ---------------------------------------------------------------------------

/**
 * Compute Pearson NCC (normalized cross-correlation) between two pixel regions.
 *
 * topBuf: flat greyscale buffer, NCC_SAMPLE_WIDTH × maxSearch rows
 * botBuf: same dimensions
 * overlap: how many rows to compare
 *   - top region: rows [maxSearch - overlap, maxSearch)
 *   - bot region: rows [0, overlap)
 *
 * Returns a value in [-1, 1]; 1.0 = perfect match.
 */
/**
 * Raw co-moments over rows [lo, hi) of the compared window; rowOffset shifts
 * into topBuf.
 *
 * These are kept as sums rather than a finished correlation because they are
 * ADDITIVE: the bands below partition the global range exactly, so the global
 * score comes from adding the bands' stats instead of walking the pixels a
 * second time. Scoring one candidate overlap costs one pass instead of four.
 *
 * Pixels are bytes and the counts are bounded by the search window, so every
 * accumulator here stays an exact integer in a double (the largest, n·Σab, is
 * ~2e14 against a 2^53 ceiling). Nothing is rounded until the division.
 */
interface NccStats {
  n: number;
  sa: number;
  sb: number;
  sab: number;
  saa: number;
  sbb: number;
}

function nccStatsOverRows(
  topBuf: Buffer,
  botBuf: Buffer,
  rowOffset: number,
  lo: number,
  hi: number
): NccStats {
  const W = NCC_SAMPLE_WIDTH;
  let sa = 0;
  let sb = 0;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let r = lo; r < hi; r++) {
    const ti = (rowOffset + r) * W;
    const bi = r * W;
    for (let x = 0; x < W; x++) {
      const a = topBuf[ti + x];
      const b = botBuf[bi + x];
      sa += a;
      sb += b;
      sab += a * b;
      saa += a * a;
      sbb += b * b;
    }
  }
  return { n: Math.max(0, (hi - lo) * W), sa, sb, sab, saa, sbb };
}

function addStats(a: NccStats, b: NccStats): NccStats {
  return {
    n: a.n + b.n,
    sa: a.sa + b.sa,
    sb: a.sb + b.sb,
    sab: a.sab + b.sab,
    saa: a.saa + b.saa,
    sbb: a.sbb + b.sbb,
  };
}

/** Pearson correlation from raw co-moments. */
function pearsonFromStats(s: NccStats): number {
  if (s.n <= 0) return 0;
  const num = s.n * s.sab - s.sa * s.sb;
  const denA = s.n * s.saa - s.sa * s.sa;
  const denB = s.n * s.sbb - s.sb * s.sb;
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

/** Median of `values`, which is SORTED IN PLACE — the caller owns the array. */
function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/**
 * Score a candidate overlap.
 *
 * A single correlation over the whole overlap is fragile: real feeds change
 * *locally* between frames — an image finishes loading, a video plays, a
 * timestamp ticks — and one changed band drags the global score below the
 * threshold even though everything else lines up perfectly (observed on a real
 * recording: 0.75–0.80 for seams that were plainly correct).
 *
 * So the window is also scored band-by-band and the MEDIAN band taken: a
 * minority of changed bands cannot move it, while unrelated content leaves
 * every band at noise. The result is the better of the two measures, which
 * makes this strictly more permissive than the global score alone — and safely
 * so, since the median can only be high when most of the overlap agrees.
 */
function computeNCC(
  topBuf: Buffer,
  botBuf: Buffer,
  maxSearch: number,
  overlap: number,
  guard: number = 0
): number {
  // Skip `guard` rows at both ends of the compared window: the start of B's
  // region and the end of A's region are where undetected sticky chrome
  // (status bar, home indicator, tab bar) sits when detection missed it.
  const lo = guard;
  const hi = overlap - guard;
  const rows = hi - lo;
  if (rows <= 0) return 0;

  const rowOffset = maxSearch - overlap;
  const bands = Math.min(NCC_MAX_BANDS, Math.floor(rows / NCC_MIN_BAND_ROWS));

  if (bands < 3) {
    // Too few rows for a median to mean anything — the global score is all
    // there is, so walk the window once and be done.
    return pearsonFromStats(nccStatsOverRows(topBuf, botBuf, rowOffset, lo, hi));
  }

  // The band edges below tile [lo, hi) exactly — b=0 starts at lo and the last
  // band ends at hi — so summing their stats reconstructs the global window
  // without touching a pixel twice.
  const bandScores: number[] = [];
  let total: NccStats | null = null;
  for (let b = 0; b < bands; b++) {
    const bandLo = lo + Math.floor((rows * b) / bands);
    const bandHi = lo + Math.floor((rows * (b + 1)) / bands);
    const stats = nccStatsOverRows(topBuf, botBuf, rowOffset, bandLo, bandHi);
    bandScores.push(pearsonFromStats(stats));
    total = total ? addStats(total, stats) : stats;
  }

  return Math.max(pearsonFromStats(total!), median(bandScores));
}

function adaptiveNccThreshold(contrast: number): number {
  if (contrast >= NCC_CONTRAST_HIGH) return NCC_CONFIDENCE_MAX;
  if (contrast <= NCC_CONTRAST_LOW) return NCC_CONFIDENCE_MIN;
  const t = (contrast - NCC_CONTRAST_LOW) / (NCC_CONTRAST_HIGH - NCC_CONTRAST_LOW);
  return NCC_CONFIDENCE_MIN + t * (NCC_CONFIDENCE_MAX - NCC_CONFIDENCE_MIN);
}

/**
 * Confidence required for a candidate overlap of `overlapPx` rows.
 *
 * Base comes from contrast; on top of that, small overlaps must score higher:
 * they compare few rows, so a chance alignment of a couple of UI elements can
 * reach an NCC that would be impossible across half a screen of content.
 */
export function nccThresholdFor(base: number, overlapPx: number, frameHeight: number): number {
  const fraction = overlapPx / Math.max(1, frameHeight);
  if (fraction >= OVERLAP_SMALL_FRACTION) return base;
  const smallness = (OVERLAP_SMALL_FRACTION - fraction) / OVERLAP_SMALL_FRACTION;
  return Math.min(0.98, base + smallness * OVERLAP_SMALL_PENALTY);
}

export interface OverlapMeasurement {
  /** True when the best NCC cleared the (adaptive) confidence threshold. */
  matched: boolean;
  /** Best-scoring overlap in pixels; 0 when !matched. */
  overlapPx: number;
  /** Best NCC observed in the search, even when below the threshold. */
  ncc: number;
  /** Confidence threshold that was applied (adaptive, 0.75–0.85). */
  threshold: number;
  /** Mean grayscale stddev of the two search regions. */
  contrast: number;
  /** Shorter of the two frame heights — the basis for overlap fractions. */
  frameHeight: number;
}

/**
 * Decoded frames, kept across the comparisons of one job.
 *
 * A frame is compared many times over — as the candidate, then as the
 * reference for every candidate that follows, and again whenever a skipped
 * frame is reconsidered — and each comparison used to re-open and re-decode
 * both files. The cache holds each frame as a whole-height, NCC_SAMPLE_WIDTH
 * column of greyscale pixels (the vertical scale is 1:1, so the search window
 * is a slice of it, pixel for pixel).
 *
 * Entries are ~64 bytes per frame row — under 200 KB for a tall frame — and
 * the cache is created per call site, so nothing survives the job that made it
 * and a rewritten temp file can never be served from a stale entry.
 */
export class FrameBandCache {
  private readonly columns = new Map<string, { height: number; column: Buffer }>();
  private readonly metas = new Map<string, { width: number; height: number } | null>();

  constructor(private readonly maxEntries: number = 4) {}

  /** Header-only read of a frame's dimensions, remembered for the job. */
  async size(framePath: string): Promise<{ width: number; height: number } | null> {
    const known = this.metas.get(framePath);
    if (known !== undefined) return known;
    let value: { width: number; height: number } | null = null;
    try {
      const meta = await sharp(framePath).metadata();
      if (meta.width && meta.height) value = { width: meta.width, height: meta.height };
    } catch {
      value = null; // unreadable — the caller reports "no overlap"
    }
    this.metas.set(framePath, value);
    return value;
  }

  /** Whole-height greyscale column of a frame, squeezed to NCC_SAMPLE_WIDTH. */
  async column(
    framePath: string,
    frameWidth: number
  ): Promise<{ height: number; column: Buffer } | null> {
    const key = `${framePath}|${frameWidth}`;
    const hit = this.columns.get(key);
    if (hit) {
      // Refresh recency: Map preserves insertion order, so re-inserting moves
      // the entry to the end and the eviction below takes the oldest.
      this.columns.delete(key);
      this.columns.set(key, hit);
      return hit;
    }

    const meta = await this.size(framePath);
    if (!meta) return null;

    const column = await sharp(framePath)
      .extract({ left: 0, top: 0, width: frameWidth, height: meta.height })
      .resize(NCC_SAMPLE_WIDTH, meta.height, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();

    const entry = { height: meta.height, column };
    this.columns.set(key, entry);
    while (this.columns.size > this.maxEntries) {
      const oldest = this.columns.keys().next().value;
      if (oldest === undefined) break;
      this.columns.delete(oldest);
    }
    return entry;
  }
}

export async function measureOverlap(
  topImagePath: string,
  bottomImagePath: string,
  cache: FrameBandCache = new FrameBandCache()
): Promise<OverlapMeasurement> {
  const none = (frameHeight: number): OverlapMeasurement => ({
    matched: false,
    overlapPx: 0,
    ncc: 0,
    threshold: NCC_CONFIDENCE_MAX,
    contrast: 0,
    frameHeight,
  });

  const topMeta = await cache.size(topImagePath);
  const botMeta = await cache.size(bottomImagePath);

  if (!topMeta || !botMeta) {
    return none(0);
  }

  const frameH = Math.min(topMeta.height, botMeta.height);
  const frameW = Math.min(topMeta.width, botMeta.width);

  const minOverlap = Math.max(OVERLAP_MIN_ABS, Math.floor(frameH * OVERLAP_MIN_FRACTION));
  const maxSearch = Math.floor(frameH * OVERLAP_MAX_FRACTION);

  if (minOverlap >= maxSearch) {
    console.log(`  overlap: skipped (frame too short: ${frameH}px)`);
    return none(frameH);
  }

  // Search regions, sliced out of the cached columns:
  // topBuf: bottom maxSearch rows of Frame A, width→NCC_SAMPLE_WIDTH
  // botBuf: top    maxSearch rows of Frame B, width→NCC_SAMPLE_WIDTH
  const topColumn = await cache.column(topImagePath, frameW);
  const botColumn = await cache.column(bottomImagePath, frameW);
  if (!topColumn || !botColumn) return none(frameH);

  const W = NCC_SAMPLE_WIDTH;
  const topBuf = topColumn.column.subarray((topColumn.height - maxSearch) * W, topColumn.height * W);
  const botBuf = botColumn.column.subarray(0, maxSearch * W);

  const contrast = (greyStddev(topBuf) + greyStddev(botBuf)) / 2;
  const baseThreshold = adaptiveNccThreshold(contrast);

  const stickyGuard = Math.round(frameH * STICKY_GUARD_FRACTION);
  const guardFor = (ov: number) => Math.min(stickyGuard, Math.floor(ov / 4));

  // Candidates are ranked by MARGIN (ncc − required threshold), not raw NCC:
  // the requirement varies with overlap size, so a barely-passing large overlap
  // must not beat a decisively-passing small one, or vice versa.
  let bestOverlap = 0;
  let bestNCC = -1;
  let bestMargin = -Infinity;

  const consider = (ov: number) => {
    const ncc = computeNCC(topBuf, botBuf, maxSearch, ov, guardFor(ov));
    const margin = ncc - nccThresholdFor(baseThreshold, ov, frameH);
    if (margin > bestMargin) {
      bestMargin = margin;
      bestNCC = ncc;
      bestOverlap = ov;
    }
  };

  // Coarse pass — iterate from minOverlap to maxSearch in NCC_COARSE_STEP steps.
  // No "prefer smallest" or "prefer largest" bias.
  for (let ov = minOverlap; ov <= maxSearch; ov += NCC_COARSE_STEP) {
    consider(ov);
  }

  // Fine pass — 1px resolution within ±NCC_FINE_RANGE of the coarse winner.
  // Run it BEFORE the confidence check: the true peak can sit up to
  // NCC_COARSE_STEP/2 px off the coarse grid, where JPEG noise already costs
  // enough correlation to fail the threshold even for a genuine overlap.
  const lo = Math.max(minOverlap, bestOverlap - NCC_FINE_RANGE);
  const hi = Math.min(maxSearch, bestOverlap + NCC_FINE_RANGE);
  for (let ov = lo; ov <= hi; ov += NCC_FINE_STEP) {
    consider(ov);
  }

  const threshold = nccThresholdFor(baseThreshold, bestOverlap, frameH);
  const pct = ((bestOverlap / frameH) * 100).toFixed(0);

  if (bestNCC < threshold) {
    console.log(
      `  overlap: none (best NCC=${bestNCC.toFixed(3)} at ${bestOverlap}px/${pct}% < threshold=${threshold.toFixed(3)}, contrast=${contrast.toFixed(1)}, searched ${minOverlap}–${maxSearch}px)`
    );
    return { matched: false, overlapPx: 0, ncc: bestNCC, threshold, contrast, frameHeight: frameH };
  }

  console.log(
    `  overlap: ${bestOverlap}px/${pct}% (NCC=${bestNCC.toFixed(3)}, threshold=${threshold.toFixed(3)}, contrast=${contrast.toFixed(1)})`
  );
  return { matched: true, overlapPx: bestOverlap, ncc: bestNCC, threshold, contrast, frameHeight: frameH };
}

// ---------------------------------------------------------------------------
// Greedy frame selection
// ---------------------------------------------------------------------------

export type SeamType = "start" | "overlap" | "gap";

export interface Seam {
  /** Joint between paths[index-1] and paths[index]; seams[0] is the "start" marker. */
  type: SeamType;
  overlapPx: number;
  ncc: number;
  nccThreshold: number;
  contrast: number;
}

export interface FrameSelection {
  paths: string[];
  /** Parallel to paths: seams[i] joins paths[i-1] → paths[i]. */
  seams: Seam[];
  warnings: string[];
  gapCount: number;
  skippedNearDuplicates: number;
  skippedRedundant: number;
}

const START_SEAM: Seam = { type: "start", overlapPx: 0, ncc: 0, nccThreshold: 0, contrast: 0 };

function seamFromMeasurement(m: OverlapMeasurement): Seam {
  return {
    type: m.matched ? "overlap" : "gap",
    overlapPx: m.overlapPx,
    ncc: m.ncc,
    nccThreshold: m.threshold,
    contrast: m.contrast,
  };
}

/**
 * Walk the frames chronologically and greedily pick the subset to stitch.
 *
 * Against the last KEPT frame, each candidate is:
 *  - skipped when it is a near-duplicate (perceptual similarity ≥ 0.90, or a
 *    measured overlap > 80% of frame height);
 *  - skipped-but-remembered when the overlap is measurable yet above the
 *    60% target window (redundant — a later frame will give a better seam);
 *  - kept when the overlap lands inside the target window (~20–60%);
 *  - and when NO measurable overlap exists (scroll jump), the last remembered
 *    skipped frame is promoted first to bridge the seam; if none exists the
 *    candidate is kept anyway with the seam marked "gap" and a warning that is
 *    surfaced to the client.
 *
 * Frames are processed strictly sequentially: only one 16×16 signature and two
 * downsampled NCC buffers are alive at any time, so 80+ frames are fine.
 */
export async function selectFrames(
  framePaths: string[],
  onProgress?: ProgressCallback
): Promise<FrameSelection> {
  const empty: FrameSelection = {
    paths: [],
    seams: [],
    warnings: [],
    gapCount: 0,
    skippedNearDuplicates: 0,
    skippedRedundant: 0,
  };
  if (framePaths.length === 0) return empty;

  const selection: FrameSelection = {
    ...empty,
    paths: [framePaths[0]],
    seams: [{ ...START_SEAM }],
  };
  if (framePaths.length === 1) return selection;

  // One cache for the whole walk: the reference frame is compared against
  // every candidate that follows it, so without this each of those comparisons
  // decodes the reference again.
  const cache = new FrameBandCache();

  let refPath = framePaths[0];
  let refSig: FrameSignature | null = null;
  try {
    refSig = await getFrameSignature(refPath);
  } catch {
    refSig = null; // frame decodes (validated upstream) — signature is best-effort
  }

  // Last frame skipped as redundant/near-duplicate that still had a measured
  // overlap against the current reference. Promoted when a gap would occur so
  // greedy skipping never manufactures a gap, and at end-of-stream so the
  // bottom of the scroll is never dropped.
  let fallback: { path: string; seam: Seam; sig: FrameSignature | null } | null = null;

  const keep = (p: string, seam: Seam, sig: FrameSignature | null) => {
    selection.paths.push(p);
    selection.seams.push(seam);
    if (seam.type === "gap") selection.gapCount++;
    refPath = p;
    refSig = sig;
    fallback = null;
  };

  const total = framePaths.length - 1;
  let i = 1;
  while (i < framePaths.length) {
    const candidate = framePaths[i];

    let sig: FrameSignature | null = null;
    try {
      sig = await getFrameSignature(candidate);
    } catch {
      sig = null;
    }

    // Near-identical to the reference (e.g. paused scroll, blinking cursor,
    // sub-minimum scroll step): skip without measuring. These are useless as
    // fallbacks too — they contain nothing the reference does not.
    if (sig && refSig && sigSimilarity(refSig, sig) >= SELECT_NEAR_DUP_SIMILARITY) {
      selection.skippedNearDuplicates++;
      console.log(`  select: frame ${i} skipped (near-duplicate of last kept)`);
      onProgress?.(i, total);
      i++;
      continue;
    }

    const m = await measureOverlap(refPath, candidate, cache);

    if (m.matched) {
      const fraction = m.overlapPx / Math.max(1, m.frameHeight);
      if (fraction > SELECT_NEAR_DUP_FRACTION) {
        selection.skippedNearDuplicates++;
        fallback = { path: candidate, seam: seamFromMeasurement(m), sig };
        console.log(
          `  select: frame ${i} skipped (overlap ${(fraction * 100).toFixed(0)}% > ${SELECT_NEAR_DUP_FRACTION * 100}%, near-duplicate)`
        );
      } else if (fraction > SELECT_TARGET_MAX_FRACTION) {
        selection.skippedRedundant++;
        fallback = { path: candidate, seam: seamFromMeasurement(m), sig };
        console.log(
          `  select: frame ${i} skipped (overlap ${(fraction * 100).toFixed(0)}% above target window, waiting for a better seam)`
        );
      } else {
        keep(candidate, seamFromMeasurement(m), sig);
        console.log(
          `  select: frame ${i} kept (overlap=${m.overlapPx}px ${(fraction * 100).toFixed(0)}%, NCC=${m.ncc.toFixed(3)}, threshold=${m.threshold.toFixed(3)})`
        );
      }
      onProgress?.(i, total);
      i++;
      continue;
    }

    // No measurable overlap against the reference.
    if (fallback) {
      // Bridge with the remembered frame, then re-evaluate this candidate
      // against the new reference (same i — no infinite loop, since promoting
      // clears the fallback and the retry either matches or gap-keeps).
      console.log(`  select: promoting skipped frame to bridge a potential gap`);
      keep(fallback.path, fallback.seam, fallback.sig);
      continue;
    }

    // User-facing text stays plain: the NCC/threshold numbers are diagnostics
    // for the log, not something to explain on a result screen.
    const warning =
      `Scroll jump around frame ${i + 1} of ${framePaths.length} — ` +
      `the scroll moved too fast here, so some content may be missing at this join.`;
    console.warn(
      `  select: GAP at frame ${i + 1}/${framePaths.length} ` +
        `(best NCC ${Math.max(0, m.ncc).toFixed(3)} < threshold ${m.threshold.toFixed(3)})`
    );
    selection.warnings.push(warning);
    keep(candidate, seamFromMeasurement(m), sig);
    onProgress?.(i, total);
    i++;
  }

  // End of stream: if measurable frames were skipped after the last keep, the
  // bottom of the scroll only exists in them. Promote the newest one — the
  // stitcher cuts at the measured overlap, so this never duplicates content.
  if (fallback !== null) {
    const f: { path: string; seam: Seam; sig: FrameSignature | null } = fallback;
    console.log(`  select: promoting final skipped frame to preserve the end of the scroll`);
    keep(f.path, f.seam, f.sig);
  }

  if (framePaths.length > 1 && selection.paths.length === 1) {
    selection.warnings.push(
      "All frames were near-duplicates of the first frame — the result is a single frame. " +
        "Make sure the recording actually scrolls."
    );
  }

  // When gaps dominate, the individual seam warnings are noise — the real
  // story is that the scroll outran the frame rate. Lead with that.
  const seamCount = selection.paths.length - 1;
  if (seamCount > 0 && selection.gapCount >= Math.max(3, Math.ceil(seamCount / 2))) {
    selection.warnings.unshift(
      `Most frames did not overlap (${selection.gapCount} of ${seamCount} seams) — ` +
        `the scrolling was probably too fast for stitching. ` +
        `Re-record with a slower, steadier scroll.`
    );
  }

  console.log(
    `Selection: ${framePaths.length} → ${selection.paths.length} frames ` +
      `(${selection.skippedNearDuplicates} near-duplicates, ${selection.skippedRedundant} redundant, ${selection.gapCount} gaps)`
  );

  return selection;
}

// ---------------------------------------------------------------------------
// Frame stitching — sequential decode into one preallocated canvas
// ---------------------------------------------------------------------------

export interface StitchResult {
  width: number;
  height: number;
  /** Actual encoded format — may fall back to png when jpeg cannot fit. */
  format: "png" | "jpeg";
}

/** Decode one frame to raw RGB at the target width, normalizing channel count. */
async function decodeFrameRgb(
  framePath: string,
  targetWidth: number
): Promise<{ data: Buffer; width: number; height: number }> {
  const meta = await sharp(framePath).metadata();
  const srcWidth = meta.width || 0;
  const srcHeight = meta.height || 0;
  if (!srcWidth || !srcHeight) {
    throw new Error(`Frame could not be decoded: ${path.basename(framePath)}`);
  }

  let pipeline = sharp(framePath);
  if (srcWidth !== targetWidth) {
    pipeline = pipeline.resize(targetWidth, srcHeight, { fit: "fill" });
  }
  const { data, info } = await pipeline
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels === 3) {
    return { data, width: info.width, height: info.height };
  }

  // Defensive: expand grayscale (or collapse other channel counts) to RGB.
  const px = info.width * info.height;
  const rgb = Buffer.allocUnsafe(px * 3);
  for (let p = 0; p < px; p++) {
    const src = p * info.channels;
    const v0 = data[src];
    rgb[p * 3] = v0;
    rgb[p * 3 + 1] = info.channels >= 2 ? data[src + 1] : v0;
    rgb[p * 3 + 2] = info.channels >= 3 ? data[src + 2] : v0;
  }
  return { data: rgb, width: info.width, height: info.height };
}

/**
 * Stitch frames using a precomputed seam plan (from selectFrames). When no
 * plan is given, overlaps are measured pairwise here (unmatched pairs become
 * butt-joined "gap" seams).
 *
 * Memory: frames are decoded ONE at a time and copied into a single
 * preallocated RGB canvas — no per-frame buffers are retained, so 80+ frames
 * stay within a bounded footprint (canvas + one decoded frame).
 */
export async function stitchFrames(
  framePaths: string[],
  outputPath: string,
  quality: "png" | "jpeg" = "png",
  seams: Seam[] | null = null,
  onProgress?: ProgressCallback
): Promise<StitchResult> {
  if (framePaths.length === 0) {
    throw new Error("No frames to stitch");
  }

  if (framePaths.length === 1) {
    const meta = await sharp(framePaths[0]).metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    const format: "png" | "jpeg" =
      quality === "jpeg" && height <= JPEG_MAX_DIMENSION && width <= JPEG_MAX_DIMENSION
        ? "jpeg"
        : "png";
    const single = sharp(framePaths[0]);
    if (format === "jpeg") {
      await single.jpeg({ quality: 90 }).toFile(outputPath);
    } else {
      await single.png().toFile(outputPath);
    }
    onProgress?.(1, 1);
    return { width, height, format };
  }

  // Metadata reads are header-only — cheap even for many frames.
  const metas = await mapWithConcurrency(framePaths, IO_CONCURRENCY, (p) =>
    sharp(p).metadata()
  );
  const heights: number[] = [];
  const widths: number[] = [];
  for (let i = 0; i < framePaths.length; i++) {
    const meta = metas[i];
    if (!meta.width || !meta.height) {
      throw new Error(`Frame could not be decoded: ${path.basename(framePaths[i])}`);
    }
    widths.push(meta.width);
    heights.push(meta.height);
  }

  const targetWidth = widths[0];

  let seamPlan: Seam[];
  if (seams) {
    if (seams.length !== framePaths.length) {
      throw new Error(
        `Seam plan length ${seams.length} does not match frame count ${framePaths.length}`
      );
    }
    seamPlan = seams;
  } else {
    seamPlan = [{ ...START_SEAM }];
    const cache = new FrameBandCache();
    for (let i = 1; i < framePaths.length; i++) {
      const m = await measureOverlap(framePaths[i - 1], framePaths[i], cache);
      seamPlan.push(seamFromMeasurement(m));
    }
  }

  let totalHeight = 0;
  for (let i = 0; i < framePaths.length; i++) {
    const overlap = Math.min(seamPlan[i].overlapPx, heights[i] - 1);
    totalHeight += heights[i] - (i === 0 ? 0 : Math.max(0, overlap));
  }

  if (totalHeight <= 0) {
    throw new Error("Stitch plan produced an empty image");
  }
  if (targetWidth * totalHeight > MAX_OUTPUT_PIXELS) {
    throw new Error(
      `Stitched image would be too large (${targetWidth}×${totalHeight}px). ` +
        `Try a shorter recording or split it into parts.`
    );
  }

  let format: "png" | "jpeg" = quality;
  if (format === "jpeg" && (totalHeight > JPEG_MAX_DIMENSION || targetWidth > JPEG_MAX_DIMENSION)) {
    console.log(
      `stitch: output ${targetWidth}×${totalHeight}px exceeds the JPEG limit — falling back to PNG`
    );
    format = "png";
  }

  const rowBytes = targetWidth * 3;
  const canvas = Buffer.alloc(rowBytes * totalHeight); // zero-filled → black
  let currentY = 0;

  for (let i = 0; i < framePaths.length; i++) {
    const { data, height } = await decodeFrameRgb(framePaths[i], targetWidth);
    const overlap = i === 0 ? 0 : Math.max(0, Math.min(seamPlan[i].overlapPx, currentY, height - 1));
    const top = currentY - overlap;
    // Cut the seam in the MIDDLE of the overlap zone: the first half keeps the
    // previous frame's pixels, the second half takes this frame's. The content
    // is identical either way, but sticky chrome that escaped detection sits at
    // the very edges (this frame's top, the previous frame's bottom) — cutting
    // mid-overlap keeps both out of the output.
    const cut = overlap > 0 ? Math.floor(overlap / 2) : 0;
    data.copy(canvas, (top + cut) * rowBytes, cut * rowBytes);
    currentY = top + height;
    onProgress?.(i + 1, framePaths.length);
  }

  const pipeline = sharp(canvas, {
    raw: { width: targetWidth, height: totalHeight, channels: 3 },
    limitInputPixels: false,
  });

  if (format === "jpeg") {
    await pipeline.jpeg({ quality: 90 }).toFile(outputPath);
  } else {
    await pipeline.png().toFile(outputPath);
  }

  return { width: targetWidth, height: totalHeight, format };
}

// ---------------------------------------------------------------------------
// Display preview — iOS refuses to decode very large images (tall stitches
// easily exceed 50 megapixels and render as black), so results above the
// pixel budget get a downscaled JPEG copy for on-screen use.
// ---------------------------------------------------------------------------

const PREVIEW_MAX_PIXELS = 12_000_000;

export async function generatePreviewImage(
  imagePath: string,
  outputPath: string,
  maxPixels: number = PREVIEW_MAX_PIXELS
): Promise<{ scaled: boolean; width: number; height: number }> {
  const meta = await sharp(imagePath).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  const pixels = width * height;

  if (!pixels || pixels <= maxPixels) {
    return { scaled: false, width, height };
  }

  // Stay under the pixel budget and the JPEG height limit
  const factor = Math.min(Math.sqrt(maxPixels / pixels), (JPEG_MAX_DIMENSION - 100) / height);
  const previewWidth = Math.max(1, Math.round(width * factor));
  const previewHeight = Math.max(1, Math.round(height * factor));

  await sharp(imagePath, { limitInputPixels: false })
    .resize(previewWidth, previewHeight, { fit: "fill" })
    .jpeg({ quality: 75 })
    .toFile(outputPath);

  console.log(
    `preview: ${width}×${height} (${(pixels / 1e6).toFixed(0)}MP) → ${previewWidth}×${previewHeight}`
  );
  return { scaled: true, width: previewWidth, height: previewHeight };
}

// ---------------------------------------------------------------------------
// PDF generation
// ---------------------------------------------------------------------------

export async function generatePdf(
  imagePath: string,
  outputPath: string
): Promise<void> {
  const PDFDocument = (await import("pdfkit")).default;
  const meta = await sharp(imagePath).metadata();
  const imgWidth = meta.width || 400;
  const imgHeight = meta.height || 800;

  const pageWidth = 595;
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  const scaledHeight = (imgHeight / imgWidth) * contentWidth;

  const maxPageHeight = 14400;
  const pageHeight = Math.min(scaledHeight + margin * 2, maxPageHeight);

  const doc = new PDFDocument({
    size: [pageWidth, pageHeight],
    margin: margin,
  });

  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);
  doc.image(imagePath, margin, margin, { width: contentWidth });
  doc.end();

  await new Promise<void>((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}
