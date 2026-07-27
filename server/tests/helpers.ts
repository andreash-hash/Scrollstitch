import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import sharp from "sharp";
import {
  validateFrames,
  deduplicateFrames,
  detectAndRemoveStickyHeaders,
  selectFrames,
  stitchFrames,
  type FrameSelection,
  type StitchResult,
} from "../video-processor";

// ---------------------------------------------------------------------------
// Deterministic pseudo-randomness
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Synthetic page generation
// ---------------------------------------------------------------------------

export interface SyntheticPage {
  data: Buffer; // raw RGB, width × height × 3
  width: number;
  height: number;
}

/**
 * Generate a tall, non-periodic page with enough vertical structure for NCC
 * to lock onto: horizontal bands of varying height/color, contrasting
 * rectangles inside each band, and low-amplitude per-pixel noise.
 *
 * "dark" mode keeps every value in a narrow low range (≈6–48) to emulate a
 * dark-theme, low-contrast screen, while guaranteeing ≥12 grey levels of
 * horizontal structure so rows from different scroll positions stay distinct.
 */
export function generatePage(
  width: number,
  height: number,
  seed: number,
  mode: "normal" | "dark" = "normal"
): SyntheticPage {
  const rand = mulberry32(seed);
  const data = Buffer.alloc(width * height * 3);
  const dark = mode === "dark";

  const baseColor = (): [number, number, number] =>
    dark
      ? [6 + rand() * 16, 6 + rand() * 16, 6 + rand() * 16].map(Math.round) as [number, number, number]
      : [30 + rand() * 200, 30 + rand() * 200, 30 + rand() * 200].map(Math.round) as [number, number, number];

  let y = 0;
  while (y < height) {
    const bandH = Math.min(height - y, 24 + Math.floor(rand() * 72));
    const [br, bg, bb] = baseColor();

    for (let row = y; row < y + bandH; row++) {
      for (let x = 0; x < width; x++) {
        const idx = (row * width + x) * 3;
        data[idx] = br;
        data[idx + 1] = bg;
        data[idx + 2] = bb;
      }
    }

    // Contrasting rectangles: in dark mode force a ≥14 grey-level offset from
    // the band base so per-row structure survives the ±10 sticky tolerance.
    const rectCount = 3 + Math.floor(rand() * 4);
    for (let r = 0; r < rectCount; r++) {
      const rw = Math.floor(width * (0.15 + rand() * 0.45));
      const rx = Math.floor(rand() * (width - rw));
      const rh = Math.max(6, Math.floor(bandH * (0.2 + rand() * 0.6)));
      const ry = y + Math.floor(rand() * Math.max(1, bandH - rh));
      const [rr, rg, rb] = dark
        ? ([14 + br + rand() * 20, 14 + bg + rand() * 20, 14 + bb + rand() * 20].map((v) =>
            Math.min(60, Math.round(v))
          ) as [number, number, number])
        : baseColor();
      for (let row = ry; row < Math.min(height, ry + rh); row++) {
        for (let x = rx; x < rx + rw; x++) {
          const idx = (row * width + x) * 3;
          data[idx] = rr;
          data[idx + 1] = rg;
          data[idx + 2] = rb;
        }
      }
    }

    y += bandH;
  }

  // Luminance noise, baked into the page (so all frames slice the same pixels)
  const amp = dark ? 3 : 6;
  for (let p = 0; p < width * height; p++) {
    const d = Math.round((rand() * 2 - 1) * amp);
    const idx = p * 3;
    data[idx] = Math.max(0, Math.min(255, data[idx] + d));
    data[idx + 1] = Math.max(0, Math.min(255, data[idx + 1] + d));
    data[idx + 2] = Math.max(0, Math.min(255, data[idx + 2] + d));
  }

  return { data, width, height };
}

// ---------------------------------------------------------------------------
// Frame rendering (sticky header/footer, keyboard overlay, JPEG noise)
// ---------------------------------------------------------------------------

export interface FrameSpec {
  /** Page y-offset of the top of the frame's content region. */
  position: number;
  /** Overlay a synthetic keyboard over the bottom ~45% of the frame. */
  keyboard?: boolean;
}

export interface RenderOptions {
  page: SyntheticPage;
  outDir: string;
  frameHeight: number;
  frames: FrameSpec[];
  headerHeight?: number;
  footerHeight?: number;
  /** Regenerate the header per frame (a status bar with a live clock/timer) —
   * pixels change every frame, so sticky detection cannot catch it. */
  dynamicHeader?: boolean;
  /** JPEG quality (1–100); 0 or undefined writes lossless PNG frames. */
  jpegQuality?: number;
  seed?: number;
}

/**
 * Cut the page into frames the way the client would see them: a sticky
 * header/footer drawn identically over every frame, the content slice from
 * the requested scroll position in between, optional keyboard overlay, and
 * JPEG re-encoding for realistic compression noise.
 */
export async function renderFrames(opts: RenderOptions): Promise<string[]> {
  const {
    page,
    outDir,
    frameHeight,
    frames,
    headerHeight = 0,
    footerHeight = 0,
    dynamicHeader = false,
    jpegQuality = 80,
    seed = 999,
  } = opts;
  fs.mkdirSync(outDir, { recursive: true });

  const { width } = page;
  const rowBytes = width * 3;
  const contentH = frameHeight - headerHeight - footerHeight;
  if (contentH <= 0) throw new Error("header+footer taller than frame");

  const header = headerHeight > 0 ? generatePage(width, headerHeight, seed + 1000).data : null;
  const footer = footerHeight > 0 ? generatePage(width, footerHeight, seed + 2000).data : null;
  const kbH = Math.round(frameHeight * 0.45);
  const keyboard = generatePage(width, kbH, seed + 3000).data;

  const paths: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    const spec = frames[i];
    const pos = Math.max(0, Math.min(page.height - contentH, Math.round(spec.position)));
    const frame = Buffer.alloc(frameHeight * rowBytes);

    const frameHeader =
      headerHeight > 0 && dynamicHeader
        ? generatePage(width, headerHeight, seed + 4000 + i).data
        : header;
    if (frameHeader) frameHeader.copy(frame, 0);
    page.data.copy(
      frame,
      headerHeight * rowBytes,
      pos * rowBytes,
      (pos + contentH) * rowBytes
    );
    if (footer) footer.copy(frame, (frameHeight - footerHeight) * rowBytes);
    if (spec.keyboard) keyboard.copy(frame, (frameHeight - kbH) * rowBytes);

    const ext = jpegQuality > 0 ? "jpg" : "png";
    const outPath = path.join(outDir, `frame_${String(i).padStart(3, "0")}.${ext}`);
    let pipeline = sharp(frame, {
      raw: { width, height: frameHeight, channels: 3 },
    });
    pipeline = jpegQuality > 0 ? pipeline.jpeg({ quality: jpegQuality }) : pipeline.png();
    await pipeline.toFile(outPath);
    paths.push(outPath);
  }

  return paths;
}

// ---------------------------------------------------------------------------
// Full server pipeline
// ---------------------------------------------------------------------------

export interface PipelineRun {
  validationWarnings: string[];
  uniqueCount: number;
  headerHeight: number;
  footerHeight: number;
  selection: FrameSelection;
  stitch: StitchResult;
  outputPath: string;
}

/** Run the whole server pipeline the same way the /api/process-frames job does. */
export async function runPipeline(
  framePaths: string[],
  quality: "png" | "jpeg" = "png"
): Promise<PipelineRun> {
  const { valid, warnings: validationWarnings } = await validateFrames(framePaths);
  if (valid.length === 0) {
    throw new Error("None of the uploaded frames could be read as images.");
  }

  const unique = await deduplicateFrames(valid);
  const { paths: cleaned, headerHeight, footerHeight } =
    await detectAndRemoveStickyHeaders(unique);
  const selection = await selectFrames(cleaned);

  const outDir = makeTempDir("stitch-out");
  const outputPath = path.join(outDir, `stitched.${quality === "jpeg" ? "jpg" : "png"}`);
  const stitch = await stitchFrames(
    selection.paths,
    outputPath,
    quality,
    selection.seams
  );

  // Mirror the route's cleanup of per-job cropped intermediates
  for (const p of cleaned) {
    if (!framePaths.includes(p)) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
  }

  return {
    validationWarnings,
    uniqueCount: unique.length,
    headerHeight,
    footerHeight,
    selection,
    stitch,
    outputPath,
  };
}

// ---------------------------------------------------------------------------
// Verification: locate strips of the original page inside the stitched image
// ---------------------------------------------------------------------------

export interface GreyImage {
  data: Buffer;
  width: number;
  height: number;
}

const VERIFY_WIDTH = 64;

/** Load an image file as grayscale, width squeezed to 64, height untouched. */
export async function greyFromFile(imagePath: string): Promise<GreyImage> {
  const meta = await sharp(imagePath).metadata();
  const height = meta.height || 0;
  const data = await sharp(imagePath)
    .resize(VERIFY_WIDTH, height, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
  return { data, width: VERIFY_WIDTH, height };
}

export async function greyFromPage(page: SyntheticPage): Promise<GreyImage> {
  const data = await sharp(page.data, {
    raw: { width: page.width, height: page.height, channels: 3 },
  })
    .resize(VERIFY_WIDTH, page.height, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
  return { data, width: VERIFY_WIDTH, height: page.height };
}

function nccRows(a: Buffer, b: Buffer): number {
  const n = a.length;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den > 0 ? num / den : 0;
}

/**
 * Slide a horizontal strip taken from the page (rows [pageY, pageY+stripH))
 * over the stitched image and return the best-matching y plus its NCC score.
 */
export function locateStrip(
  stitched: GreyImage,
  pageGrey: GreyImage,
  pageY: number,
  stripH = 24
): { bestY: number; bestNcc: number } {
  const W = stitched.width;
  const strip = pageGrey.data.subarray(pageY * W, (pageY + stripH) * W);

  let bestY = -1;
  let bestNcc = -Infinity;
  for (let y = 0; y + stripH <= stitched.height; y++) {
    const window = stitched.data.subarray(y * W, (y + stripH) * W);
    const score = nccRows(strip, window);
    if (score > bestNcc) {
      bestNcc = score;
      bestY = y;
    }
  }
  return { bestY, bestNcc };
}

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

export function makeTempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `scrollstitch-test-${label}-`));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}
