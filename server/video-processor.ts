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
const NCC_SAMPLE_WIDTH = 64;          // downsample X to this width before NCC
const NCC_COARSE_STEP = 8;            // px — coarse search step
const NCC_FINE_RANGE = 16;            // px — fine-search ± around coarse winner
const NCC_FINE_STEP = 1;              // px — fine-search resolution
const NCC_CONFIDENCE = 0.85;          // minimum NCC to accept an overlap

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getFrameSignature(
  framePath: string,
  size: number = DEDUP_HASH_SIZE
): Promise<Buffer> {
  const { data } = await sharp(framePath)
    .resize(size, size, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

function bufferSimilarity(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return 0;
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) < 20) matches++;
  }
  return matches / a.length;
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
  framePaths: string[]
): Promise<string[]> {
  if (framePaths.length === 0) return [];
  if (framePaths.length === 1) return framePaths;

  const unique: string[] = [framePaths[0]];
  let prevSig = await getFrameSignature(framePaths[0]);

  for (let i = 1; i < framePaths.length; i++) {
    const sig = await getFrameSignature(framePaths[i]);
    const sim = bufferSimilarity(prevSig, sig);
    if (sim < SIMILARITY_THRESHOLD) {
      unique.push(framePaths[i]);
      prevSig = sig;
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
function computeNCC(
  topBuf: Buffer,
  botBuf: Buffer,
  maxSearch: number,
  overlap: number
): number {
  const W = NCC_SAMPLE_WIDTH;
  const n = overlap * W;
  if (n === 0) return 0;

  const rowOffset = maxSearch - overlap;

  // Pass 1: compute means
  let sumA = 0;
  let sumB = 0;
  for (let r = 0; r < overlap; r++) {
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
  for (let r = 0; r < overlap; r++) {
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

async function findOverlap(
  topImagePath: string,
  bottomImagePath: string
): Promise<number> {
  const [topMeta, botMeta] = await Promise.all([
    sharp(topImagePath).metadata(),
    sharp(bottomImagePath).metadata(),
  ]);

  if (!topMeta.width || !topMeta.height || !botMeta.width || !botMeta.height) {
    return 0;
  }

  const frameH = Math.min(topMeta.height, botMeta.height);
  const frameW = Math.min(topMeta.width, botMeta.width);

  // Minimum overlap: 20% of the shorter frame (eliminates false 20–50px matches)
  const minOverlap = Math.max(OVERLAP_MIN_ABS, Math.floor(frameH * OVERLAP_MIN_FRACTION));
  // Maximum search: 90% of the shorter frame
  const maxSearch = Math.floor(frameH * 0.90);

  if (minOverlap >= maxSearch) {
    console.log(`  overlap: skipped (frame too short: ${frameH}px)`);
    return 0;
  }

  // Extract and downsample both search regions in parallel.
  // topBuf: bottom maxSearch rows of Frame A, width→NCC_SAMPLE_WIDTH
  // botBuf: top    maxSearch rows of Frame B, width→NCC_SAMPLE_WIDTH
  const [topBuf, botBuf] = await Promise.all([
    sharp(topImagePath)
      .extract({ left: 0, top: topMeta.height - maxSearch, width: frameW, height: maxSearch })
      .resize(NCC_SAMPLE_WIDTH, maxSearch, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer(),
    sharp(bottomImagePath)
      .extract({ left: 0, top: 0, width: frameW, height: maxSearch })
      .resize(NCC_SAMPLE_WIDTH, maxSearch, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer(),
  ]);

  // Coarse pass — iterate from minOverlap to maxSearch in NCC_COARSE_STEP steps.
  // Track GLOBAL maximum NCC; no "prefer smallest" or "prefer largest" bias.
  let bestOverlap = 0;
  let bestNCC = -1;

  for (let ov = minOverlap; ov <= maxSearch; ov += NCC_COARSE_STEP) {
    const ncc = computeNCC(topBuf, botBuf, maxSearch, ov);
    if (ncc > bestNCC) {
      bestNCC = ncc;
      bestOverlap = ov;
    }
  }

  // Reject if best NCC is below confidence threshold
  if (bestNCC < NCC_CONFIDENCE) {
    console.log(`  overlap: 0px (bestNCC=${bestNCC.toFixed(3)} < ${NCC_CONFIDENCE}, no confident match)`);
    return 0;
  }

  // Fine pass — 1px resolution within ±NCC_FINE_RANGE of the coarse winner
  const lo = Math.max(minOverlap, bestOverlap - NCC_FINE_RANGE);
  const hi = Math.min(maxSearch, bestOverlap + NCC_FINE_RANGE);
  for (let ov = lo; ov <= hi; ov += NCC_FINE_STEP) {
    const ncc = computeNCC(topBuf, botBuf, maxSearch, ov);
    if (ncc > bestNCC) {
      bestNCC = ncc;
      bestOverlap = ov;
    }
  }

  console.log(`  overlap: ${bestOverlap}px (NCC=${bestNCC.toFixed(3)}, min=${minOverlap}px, max=${maxSearch}px)`);
  return bestOverlap;
}

// ---------------------------------------------------------------------------
// Frame stitching
// ---------------------------------------------------------------------------

export async function stitchFrames(
  framePaths: string[],
  outputPath: string,
  quality: "png" | "jpeg" = "png"
): Promise<{ width: number; height: number }> {
  if (framePaths.length === 0) {
    throw new Error("No frames to stitch");
  }

  if (framePaths.length === 1) {
    const single = sharp(framePaths[0]);
    if (quality === "jpeg") {
      await single.jpeg({ quality: 90 }).toFile(outputPath);
    } else {
      await single.png().toFile(outputPath);
    }
    const meta = await sharp(framePaths[0]).metadata();
    return { width: meta.width || 0, height: meta.height || 0 };
  }

  const metadata = await Promise.all(
    framePaths.map((f) => sharp(f).metadata())
  );

  const targetWidth = metadata[0].width || 0;

  const overlaps: number[] = [0];
  for (let i = 1; i < framePaths.length; i++) {
    const overlap = await findOverlap(framePaths[i - 1], framePaths[i]);
    overlaps.push(overlap);
  }

  let totalHeight = 0;
  for (let i = 0; i < framePaths.length; i++) {
    const h = metadata[i].height || 0;
    totalHeight += h - overlaps[i];
  }

  const composites: { input: Buffer; top: number; left: number }[] = [];
  let currentY = 0;

  for (let i = 0; i < framePaths.length; i++) {
    const frameWidth = metadata[i].width || 0;
    let inputBuffer: Buffer;

    if (frameWidth !== targetWidth) {
      inputBuffer = await sharp(framePaths[i])
        .resize(targetWidth, metadata[i].height || 0, { fit: "fill" })
        .toBuffer();
    } else {
      inputBuffer = await sharp(framePaths[i]).toBuffer();
    }

    composites.push({
      input: inputBuffer,
      top: currentY - overlaps[i],
      left: 0,
    });

    currentY += (metadata[i].height || 0) - overlaps[i];
  }

  const pipeline = sharp({
    create: {
      width: targetWidth,
      height: totalHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  }).composite(composites);

  if (quality === "jpeg") {
    await pipeline.jpeg({ quality: 90 }).toFile(outputPath);
  } else {
    await pipeline.png().toFile(outputPath);
  }

  return { width: targetWidth, height: totalHeight };
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
