import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import sharp from "sharp";

const SIMILARITY_THRESHOLD = 0.97;
const OVERLAP_SEARCH_HEIGHT = 120;
const OVERLAP_MIN_HEIGHT = 20;

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

async function findOverlap(
  topImagePath: string,
  bottomImagePath: string
): Promise<number> {
  const topMeta = await sharp(topImagePath).metadata();
  const bottomMeta = await sharp(bottomImagePath).metadata();

  if (
    !topMeta.width ||
    !topMeta.height ||
    !bottomMeta.width ||
    !bottomMeta.height
  ) {
    return 0;
  }

  const width = Math.min(topMeta.width, bottomMeta.width);
  const searchHeight = Math.min(
    OVERLAP_SEARCH_HEIGHT,
    Math.floor(topMeta.height * 0.4)
  );
  const sampleWidth = Math.min(width, 200);

  const topBottom = await sharp(topImagePath)
    .extract({
      left: 0,
      top: topMeta.height - searchHeight,
      width: width,
      height: searchHeight,
    })
    .resize(sampleWidth, searchHeight, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();

  let bestOverlap = 0;
  let bestScore = 0;

  for (
    let overlap = OVERLAP_MIN_HEIGHT;
    overlap <= searchHeight;
    overlap += 4
  ) {
    const bottomTop = await sharp(bottomImagePath)
      .extract({
        left: 0,
        top: 0,
        width: width,
        height: overlap,
      })
      .resize(sampleWidth, overlap, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();

    const topSlice = topBottom.subarray(
      (searchHeight - overlap) * sampleWidth,
      searchHeight * sampleWidth
    );

    if (topSlice.length !== bottomTop.length) continue;

    let matches = 0;
    for (let i = 0; i < topSlice.length; i++) {
      if (Math.abs(topSlice[i] - bottomTop[i]) < 25) matches++;
    }
    const score = matches / topSlice.length;

    if (score > bestScore && score > 0.85) {
      bestScore = score;
      bestOverlap = overlap;
    }
  }

  return bestOverlap;
}

export async function stitchFrames(
  framePaths: string[],
  outputPath: string
): Promise<{ width: number; height: number }> {
  if (framePaths.length === 0) {
    throw new Error("No frames to stitch");
  }

  if (framePaths.length === 1) {
    await sharp(framePaths[0]).png().toFile(outputPath);
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
      top: currentY,
      left: 0,
    });

    currentY += (metadata[i].height || 0) - overlaps[i];
  }

  await sharp({
    create: {
      width: targetWidth,
      height: totalHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite(composites)
    .png()
    .toFile(outputPath);

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
