import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import sharp from "sharp";

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
// Minimum overlap is 20% of the shorter frame height.
// This eliminates false 20–50px matches on periodic UI chrome.
const OVERLAP_MIN_FRACTION = 0.20;
const OVERLAP_MIN_ABS = 40;           // absolute floor in px
const OVERLAP_MAX_FRACTION = 0.90;    // search ceiling as fraction of frame height
const NCC_SAMPLE_WIDTH = 64;          // downsample X to this width before NCC
const NCC_COARSE_STEP = 8;            // px — coarse search step
const NCC_FINE_RANGE = 16;            // px — fine-search ± around coarse winner
const NCC_FINE_STEP = 1;              // px — fine-search resolution

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
  const base = sharp(framePath).resize(size, size, { fit: "fill" }).greyscale();
  const raw = await base.clone().raw().toBuffer();
  const norm = await base.clone().normalise().raw().toBuffer();
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

  for (let i = 0; i < framePaths.length; i++) {
    try {
      // Tiny full decode: metadata() only reads the header and misses
      // truncated scan data, so force an actual decode of the pixels.
      const probe = await sharp(framePaths[i])
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
      if (max - min < 5 && max < 12) {
        const msg = `Frame ${i + 1} of ${framePaths.length} was blank (all black) and was skipped.`;
        console.warn(`validateFrames: ${msg} (${path.basename(framePaths[i])})`);
        warnings.push(msg);
      } else {
        valid.push(framePaths[i]);
      }
    } catch {
      const msg = `Frame ${i + 1} of ${framePaths.length} could not be decoded and was skipped.`;
      console.warn(`validateFrames: ${msg} (${path.basename(framePaths[i])})`);
      warnings.push(msg);
    }
    onProgress?.(i + 1, framePaths.length);
  }

  return { valid, warnings };
}

// ---------------------------------------------------------------------------
// Sticky detection (up to HEADER_MAX_RATIO of frame)
// ---------------------------------------------------------------------------

async function detectStickyRegion(
  framePaths: string[],
  region: "top" | "bottom"
): Promise<number> {
  if (framePaths.length < 3) return 0;

  const sampleCount = Math.min(framePaths.length, HEADER_SAMPLE_FRAMES);
  const indices: number[] = [];
  const step = Math.max(1, Math.floor((framePaths.length - 1) / (sampleCount - 1)));
  for (let i = 0; i < framePaths.length && indices.length < sampleCount; i += step) {
    indices.push(i);
  }
  if (!indices.includes(framePaths.length - 1) && framePaths.length > 1) {
    indices.push(framePaths.length - 1);
  }
  if (indices.length < 3) return 0;

  const firstMeta = await sharp(framePaths[indices[0]]).metadata();
  const frameWidth = firstMeta.width || 0;
  const frameHeight = firstMeta.height || 0;
  if (!frameWidth || !frameHeight) return 0;

  // Search up to HEADER_MAX_RATIO of frame height (was 15%, now 50%)
  const maxCheckHeight = Math.floor(frameHeight * HEADER_MAX_RATIO);
  const sampleWidth = Math.min(frameWidth, 300);

  const strips: Buffer[] = [];
  for (const idx of indices) {
    const extractTop = region === "top" ? 0 : frameHeight - maxCheckHeight;
    const strip = await sharp(framePaths[idx])
      .extract({ left: 0, top: extractTop, width: frameWidth, height: maxCheckHeight })
      .resize(sampleWidth, maxCheckHeight, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();
    strips.push(strip);
  }

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

export async function detectAndRemoveStickyHeaders(
  framePaths: string[]
): Promise<{ paths: string[]; headerHeight: number; footerHeight: number }> {
  if (framePaths.length < 3) {
    return { paths: framePaths, headerHeight: 0, footerHeight: 0 };
  }

  const headerHeight = await detectStickyRegion(framePaths, "top");
  const footerHeight = await detectStickyRegion(framePaths, "bottom");

  console.log(`Sticky detection: header=${headerHeight}px, footer=${footerHeight}px`);

  if (headerHeight === 0 && footerHeight === 0) {
    return { paths: framePaths, headerHeight: 0, footerHeight: 0 };
  }

  const outputDir = path.join(os.tmpdir(), "scrollsnap-cropped");
  fs.mkdirSync(outputDir, { recursive: true });

  const croppedPaths: string[] = [];

  for (let i = 0; i < framePaths.length; i++) {
    const meta = await sharp(framePaths[i]).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;

    const cropTop = i === 0 ? 0 : headerHeight;
    const cropBottom = i === framePaths.length - 1 ? 0 : footerHeight;
    const newHeight = h - cropTop - cropBottom;

    if (newHeight <= 0 || cropTop + cropBottom >= h) {
      croppedPaths.push(framePaths[i]);
      continue;
    }

    if (cropTop === 0 && cropBottom === 0) {
      croppedPaths.push(framePaths[i]);
      continue;
    }

    // PNG to avoid double-JPEG compression artifacts
    const outPath = path.join(outputDir, `cropped_${i}_${path.basename(framePaths[i])}.png`);
    await sharp(framePaths[i])
      .extract({ left: 0, top: cropTop, width: w, height: newHeight })
      .png()
      .toFile(outPath);
    croppedPaths.push(outPath);
  }

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

  const unique: string[] = [framePaths[0]];
  let prevSig = await getFrameSignature(framePaths[0]);
  onProgress?.(1, framePaths.length);

  for (let i = 1; i < framePaths.length; i++) {
    const sig = await getFrameSignature(framePaths[i]);
    const sim = sigSimilarity(prevSig, sig);
    if (sim < SIMILARITY_THRESHOLD) {
      unique.push(framePaths[i]);
      prevSig = sig;
    }
    onProgress?.(i + 1, framePaths.length);
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
function computeNCC(
  topBuf: Buffer,
  botBuf: Buffer,
  maxSearch: number,
  overlap: number,
  guard: number = 0
): number {
  const W = NCC_SAMPLE_WIDTH;
  // Skip `guard` rows at both ends of the compared window: the start of B's
  // region and the end of A's region are where undetected sticky chrome
  // (status bar, home indicator, tab bar) sits when detection missed it.
  const lo = guard;
  const hi = overlap - guard;
  const n = (hi - lo) * W;
  if (n <= 0) return 0;

  const rowOffset = maxSearch - overlap;

  // Pass 1: compute means
  let sumA = 0;
  let sumB = 0;
  for (let r = lo; r < hi; r++) {
    const ti = (rowOffset + r) * W;
    const bi = r * W;
    for (let x = 0; x < W; x++) {
      sumA += topBuf[ti + x];
      sumB += botBuf[bi + x];
    }
  }
  const meanA = sumA / n;
  const meanB = sumB / n;

  // Pass 2: compute NCC numerator and denominators
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let r = lo; r < hi; r++) {
    const ti = (rowOffset + r) * W;
    const bi = r * W;
    for (let x = 0; x < W; x++) {
      const a = topBuf[ti + x] - meanA;
      const b = botBuf[bi + x] - meanB;
      num += a * b;
      denA += a * a;
      denB += b * b;
    }
  }

  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

function adaptiveNccThreshold(contrast: number): number {
  if (contrast >= NCC_CONTRAST_HIGH) return NCC_CONFIDENCE_MAX;
  if (contrast <= NCC_CONTRAST_LOW) return NCC_CONFIDENCE_MIN;
  const t = (contrast - NCC_CONTRAST_LOW) / (NCC_CONTRAST_HIGH - NCC_CONTRAST_LOW);
  return NCC_CONFIDENCE_MIN + t * (NCC_CONFIDENCE_MAX - NCC_CONFIDENCE_MIN);
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

export async function measureOverlap(
  topImagePath: string,
  bottomImagePath: string
): Promise<OverlapMeasurement> {
  const none = (frameHeight: number): OverlapMeasurement => ({
    matched: false,
    overlapPx: 0,
    ncc: 0,
    threshold: NCC_CONFIDENCE_MAX,
    contrast: 0,
    frameHeight,
  });

  const topMeta = await sharp(topImagePath).metadata();
  const botMeta = await sharp(bottomImagePath).metadata();

  if (!topMeta.width || !topMeta.height || !botMeta.width || !botMeta.height) {
    return none(0);
  }

  const frameH = Math.min(topMeta.height, botMeta.height);
  const frameW = Math.min(topMeta.width, botMeta.width);

  // Minimum overlap: 20% of the shorter frame (eliminates false 20–50px matches)
  const minOverlap = Math.max(OVERLAP_MIN_ABS, Math.floor(frameH * OVERLAP_MIN_FRACTION));
  const maxSearch = Math.floor(frameH * OVERLAP_MAX_FRACTION);

  if (minOverlap >= maxSearch) {
    console.log(`  overlap: skipped (frame too short: ${frameH}px)`);
    return none(frameH);
  }

  // Extract and downsample both search regions sequentially — only two small
  // greyscale buffers (NCC_SAMPLE_WIDTH × maxSearch) live at any time.
  // topBuf: bottom maxSearch rows of Frame A, width→NCC_SAMPLE_WIDTH
  // botBuf: top    maxSearch rows of Frame B, width→NCC_SAMPLE_WIDTH
  const topBuf = await sharp(topImagePath)
    .extract({ left: 0, top: topMeta.height - maxSearch, width: frameW, height: maxSearch })
    .resize(NCC_SAMPLE_WIDTH, maxSearch, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
  const botBuf = await sharp(bottomImagePath)
    .extract({ left: 0, top: 0, width: frameW, height: maxSearch })
    .resize(NCC_SAMPLE_WIDTH, maxSearch, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();

  const contrast = (greyStddev(topBuf) + greyStddev(botBuf)) / 2;
  const threshold = adaptiveNccThreshold(contrast);

  const stickyGuard = Math.round(frameH * STICKY_GUARD_FRACTION);
  const guardFor = (ov: number) => Math.min(stickyGuard, Math.floor(ov / 4));

  // Coarse pass — iterate from minOverlap to maxSearch in NCC_COARSE_STEP steps.
  // Track GLOBAL maximum NCC; no "prefer smallest" or "prefer largest" bias.
  let bestOverlap = 0;
  let bestNCC = -1;

  for (let ov = minOverlap; ov <= maxSearch; ov += NCC_COARSE_STEP) {
    const ncc = computeNCC(topBuf, botBuf, maxSearch, ov, guardFor(ov));
    if (ncc > bestNCC) {
      bestNCC = ncc;
      bestOverlap = ov;
    }
  }

  // Fine pass — 1px resolution within ±NCC_FINE_RANGE of the coarse winner.
  // Run it BEFORE the confidence check: the true peak can sit up to
  // NCC_COARSE_STEP/2 px off the coarse grid, where JPEG noise already costs
  // enough correlation to fail the threshold even for a genuine overlap.
  const lo = Math.max(minOverlap, bestOverlap - NCC_FINE_RANGE);
  const hi = Math.min(maxSearch, bestOverlap + NCC_FINE_RANGE);
  for (let ov = lo; ov <= hi; ov += NCC_FINE_STEP) {
    const ncc = computeNCC(topBuf, botBuf, maxSearch, ov, guardFor(ov));
    if (ncc > bestNCC) {
      bestNCC = ncc;
      bestOverlap = ov;
    }
  }

  if (bestNCC < threshold) {
    console.log(
      `  overlap: none (best NCC=${bestNCC.toFixed(3)} < threshold=${threshold.toFixed(3)}, contrast=${contrast.toFixed(1)})`
    );
    return { matched: false, overlapPx: 0, ncc: bestNCC, threshold, contrast, frameHeight: frameH };
  }

  console.log(
    `  overlap: ${bestOverlap}px (NCC=${bestNCC.toFixed(3)}, threshold=${threshold.toFixed(3)}, contrast=${contrast.toFixed(1)}, min=${minOverlap}px, max=${maxSearch}px)`
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

    const m = await measureOverlap(refPath, candidate);

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

    const warning =
      `Scroll jump detected at frame ${i + 1} of ${framePaths.length}: ` +
      `no reliable overlap with the previous frame (best match ${(Math.max(0, m.ncc) * 100).toFixed(0)}%, ` +
      `needed ${(m.threshold * 100).toFixed(0)}%). Content may be missing at this seam.`;
    console.warn(`  select: GAP — ${warning}`);
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
  const heights: number[] = [];
  const widths: number[] = [];
  for (const p of framePaths) {
    const meta = await sharp(p).metadata();
    if (!meta.width || !meta.height) {
      throw new Error(`Frame could not be decoded: ${path.basename(p)}`);
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
    for (let i = 1; i < framePaths.length; i++) {
      const m = await measureOverlap(framePaths[i - 1], framePaths[i]);
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
