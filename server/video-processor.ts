import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import sharp from "sharp";

const SIMILARITY_THRESHOLD = 0.97;
const OVERLAP_SAMPLE_WIDTH = 64;   // px — narrow enough to be fast, wide enough to be accurate
const OVERLAP_MIN_HEIGHT = 20;
const OVERLAP_STEP = 8;            // px — coarse pass step
const OVERLAP_REFINE_STEP = 2;     // px — fine-pass step around the best candidate
const OVERLAP_SCORE_THRESHOLD = 0.85;
const HEADER_SAMPLE_FRAMES = 7;
const HEADER_ROW_MATCH_THRESHOLD = 0.96;
const HEADER_MIN_HEIGHT = 40;
const HEADER_MAX_RATIO = 0.15;
const HEADER_PIXEL_TOLERANCE = 10;

async function getFrameSignature(
  framePath: string,
  sampleHeight: number = 8,
  sampleWidth: number = 8
): Promise<Buffer> {
  const { data } = await sharp(framePath)
    .resize(sampleWidth, sampleHeight, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

function bufferSimilarity(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return 0;
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = Math.abs(a[i] - b[i]);
    if (diff < 20) matches++;
  }
  return matches / a.length;
}

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
      if (matches / sampleWidth < HEADER_ROW_MATCH_THRESHOLD) {
        return false;
      }
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

  const scaleFactor = frameHeight * HEADER_MAX_RATIO / maxCheckHeight;
  const realHeight = Math.round(stickyHeight * scaleFactor);

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

    const outPath = path.join(outputDir, `cropped_${i}_${path.basename(framePaths[i])}`);
    await sharp(framePaths[i])
      .extract({ left: 0, top: cropTop, width: w, height: newHeight })
      .toFile(outPath);
    croppedPaths.push(outPath);
  }

  return { paths: croppedPaths, headerHeight, footerHeight };
}

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

// Score how well `overlap` rows match between the bottom of topBuf and top of botBuf.
// Both buffers are (OVERLAP_SAMPLE_WIDTH × maxSearch) grayscale raw pixels.
// Samples every 3rd pixel for speed.
function scoreOverlap(
  topBuf: Buffer,
  botBuf: Buffer,
  maxSearch: number,
  overlap: number
): number {
  const w = OVERLAP_SAMPLE_WIDTH;
  const topOffset = (maxSearch - overlap) * w;
  const len = overlap * w;
  let matches = 0;
  let total = 0;
  for (let i = 0; i < len; i += 3) {
    total++;
    if (Math.abs(topBuf[topOffset + i] - botBuf[i]) < 25) matches++;
  }
  return total > 0 ? matches / total : 0;
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

  // Search up to 85 % of the shorter frame so we catch even very slow scrolling.
  const maxSearch = Math.max(OVERLAP_MIN_HEIGHT, Math.floor(frameH * 0.85));

  // Load BOTH regions with exactly 2 sharp calls. All candidate comparisons
  // happen in memory, so there are no more O(n) sharp calls inside the loop.
  const [topBuf, botBuf] = await Promise.all([
    sharp(topImagePath)
      .extract({ left: 0, top: topMeta.height - maxSearch, width: frameW, height: maxSearch })
      .resize(OVERLAP_SAMPLE_WIDTH, maxSearch, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer(),
    sharp(bottomImagePath)
      .extract({ left: 0, top: 0, width: frameW, height: maxSearch })
      .resize(OVERLAP_SAMPLE_WIDTH, maxSearch, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer(),
  ]);

  // Coarse pass — step OVERLAP_STEP px
  let bestOverlap = 0;
  let bestScore = 0;

  for (let ov = OVERLAP_MIN_HEIGHT; ov <= maxSearch; ov += OVERLAP_STEP) {
    const score = scoreOverlap(topBuf, botBuf, maxSearch, ov);
    if (score > bestScore) {
      bestScore = score;
      bestOverlap = ov;
    }
  }

  if (bestScore < OVERLAP_SCORE_THRESHOLD) return 0;

  // Fine pass — search ±OVERLAP_STEP around the coarse winner at OVERLAP_REFINE_STEP
  const lo = Math.max(OVERLAP_MIN_HEIGHT, bestOverlap - OVERLAP_STEP);
  const hi = Math.min(maxSearch, bestOverlap + OVERLAP_STEP);
  for (let ov = lo; ov <= hi; ov += OVERLAP_REFINE_STEP) {
    const score = scoreOverlap(topBuf, botBuf, maxSearch, ov);
    if (score > bestScore) {
      bestScore = score;
      bestOverlap = ov;
    }
  }

  console.log(`  overlap: ${bestOverlap}px (score ${bestScore.toFixed(3)}, searched 0-${maxSearch}px)`);
  return bestScore >= OVERLAP_SCORE_THRESHOLD ? bestOverlap : 0;
}

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

    // Place frame so its overlapping rows sit ON TOP of the previous frame's
    // identical bottom rows. The unique new content lands at currentY onward.
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
