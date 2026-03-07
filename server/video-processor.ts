import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

const FRAME_RATE = 5;
const SIMILARITY_THRESHOLD = 0.97;
const OVERLAP_SEARCH_HEIGHT = 120;
const OVERLAP_MIN_HEIGHT = 20;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scrollsnap-"));
}

function cleanupDir(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

export async function extractFrames(
  videoPath: string,
  tempDir: string
): Promise<string[]> {
  const framesDir = path.join(tempDir, "frames");
  fs.mkdirSync(framesDir, { recursive: true });

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  const stat = fs.statSync(videoPath);
  console.log(`Video file size: ${stat.size} bytes`);

  const outputPattern = path.join(framesDir, "frame_%05d.jpg");

  try {
    const { stdout, stderr } = await execFileAsync(
      "ffmpeg",
      [
        "-i", videoPath,
        "-vf", `fps=${FRAME_RATE}`,
        "-q:v", "2",
        "-f", "image2",
        outputPattern,
        "-y",
      ],
      { timeout: 120000, maxBuffer: 50 * 1024 * 1024 }
    );
    if (stderr) {
      console.log("ffmpeg stderr:", stderr.slice(-500));
    }
  } catch (err: any) {
    console.error("ffmpeg error:", err.stderr?.slice(-500) || err.message);
    const partialFiles = fs
      .readdirSync(framesDir)
      .filter((f) => f.endsWith(".jpg"));
    if (partialFiles.length > 0) {
      console.log(`ffmpeg errored but produced ${partialFiles.length} frames, continuing`);
    } else {
      throw new Error(`Frame extraction failed: ${err.message?.slice(0, 200)}`);
    }
  }

  const files = fs
    .readdirSync(framesDir)
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => path.join(framesDir, f));

  console.log(`Extracted ${files.length} frames`);
  return files;
}

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

  if (!topMeta.width || !topMeta.height || !bottomMeta.width || !bottomMeta.height) {
    return 0;
  }

  const width = Math.min(topMeta.width, bottomMeta.width);
  const searchHeight = Math.min(OVERLAP_SEARCH_HEIGHT, Math.floor(topMeta.height * 0.4));

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

  const canvas = sharp({
    create: {
      width: targetWidth,
      height: totalHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  });

  const composites: { input: string; top: number; left: number }[] = [];
  let currentY = 0;

  for (let i = 0; i < framePaths.length; i++) {
    const frameWidth = metadata[i].width || 0;
    let inputPath = framePaths[i];

    if (frameWidth !== targetWidth) {
      const resizedPath = framePaths[i].replace(/\.(jpg|png)$/, "_resized.$1");
      await sharp(framePaths[i])
        .resize(targetWidth, metadata[i].height || 0, { fit: "fill" })
        .toFile(resizedPath);
      inputPath = resizedPath;
    }

    composites.push({
      input: inputPath,
      top: currentY,
      left: 0,
    });

    currentY += (metadata[i].height || 0) - overlaps[i];
  }

  await canvas.composite(composites).png({ quality: 90 }).toFile(outputPath);

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

  doc.image(imagePath, margin, margin, {
    width: contentWidth,
  });

  doc.end();

  await new Promise<void>((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

export interface ProcessingResult {
  imageUrl: string;
  pdfUrl: string;
  frameCount: number;
  uniqueFrames: number;
  dimensions: { width: number; height: number };
}

export async function processVideo(
  videoPath: string,
  jobId: string,
  onProgress: (stage: string, progress: number) => void
): Promise<ProcessingResult> {
  const tempDir = createTempDir();
  const outputDir = path.join(os.tmpdir(), "scrollsnap-output");
  fs.mkdirSync(outputDir, { recursive: true });

  try {
    onProgress("Extracting frames", 0.1);
    const frames = await extractFrames(videoPath, tempDir);
    onProgress("Extracting frames", 0.3);

    if (frames.length === 0) {
      throw new Error("No frames could be extracted from the video");
    }

    onProgress("Removing duplicates", 0.4);
    const uniqueFrames = await deduplicateFrames(frames);
    onProgress("Removing duplicates", 0.5);

    const outputImagePath = path.join(outputDir, `${jobId}.png`);
    onProgress("Stitching frames", 0.6);
    const dimensions = await stitchFrames(uniqueFrames, outputImagePath);
    onProgress("Stitching frames", 0.8);

    const outputPdfPath = path.join(outputDir, `${jobId}.pdf`);
    onProgress("Generating PDF", 0.9);
    await generatePdf(outputImagePath, outputPdfPath);
    onProgress("Complete", 1.0);

    return {
      imageUrl: `/api/output/${jobId}.png`,
      pdfUrl: `/api/output/${jobId}.pdf`,
      frameCount: frames.length,
      uniqueFrames: uniqueFrames.length,
      dimensions,
    };
  } finally {
    cleanupDir(tempDir);
  }
}
