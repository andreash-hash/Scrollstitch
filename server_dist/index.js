// server/index.ts
import express from "express";

// server/routes.ts
import { createServer } from "node:http";
import * as fs2 from "fs";
import * as path2 from "path";
import * as os2 from "os";
import multer from "multer";

// server/video-processor.ts
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import sharp from "sharp";
var SIMILARITY_THRESHOLD = 0.93;
var DEDUP_HASH_SIZE = 16;
var HEADER_SAMPLE_FRAMES = 7;
var HEADER_ROW_MATCH_THRESHOLD = 0.96;
var HEADER_MIN_HEIGHT = 40;
var HEADER_MAX_RATIO = 0.5;
var HEADER_PIXEL_TOLERANCE = 10;
var OVERLAP_MIN_FRACTION = 0.2;
var OVERLAP_MIN_ABS = 40;
var NCC_SAMPLE_WIDTH = 64;
var NCC_COARSE_STEP = 8;
var NCC_FINE_RANGE = 16;
var NCC_FINE_STEP = 1;
var NCC_CONFIDENCE = 0.85;
async function getFrameSignature(framePath, size = DEDUP_HASH_SIZE) {
  const { data } = await sharp(framePath).resize(size, size, { fit: "fill" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return data;
}
function bufferSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) < 20) matches++;
  }
  return matches / a.length;
}
async function detectStickyRegion(framePaths, region) {
  if (framePaths.length < 3) return 0;
  const sampleCount = Math.min(framePaths.length, HEADER_SAMPLE_FRAMES);
  const indices = [];
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
  const strips = [];
  for (const idx of indices) {
    const extractTop = region === "top" ? 0 : frameHeight - maxCheckHeight;
    const strip = await sharp(framePaths[idx]).extract({ left: 0, top: extractTop, width: frameWidth, height: maxCheckHeight }).resize(sampleWidth, maxCheckHeight, { fit: "fill" }).greyscale().raw().toBuffer();
    strips.push(strip);
  }
  let stickyHeight = 0;
  const checkRow = (row) => {
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
  const realHeight = Math.round(stickyHeight * (frameHeight * HEADER_MAX_RATIO / maxCheckHeight));
  if (realHeight < HEADER_MIN_HEIGHT) return 0;
  return realHeight;
}
async function detectAndRemoveStickyHeaders(framePaths) {
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
  const croppedPaths = [];
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
    const outPath = path.join(outputDir, `cropped_${i}_${path.basename(framePaths[i])}.png`);
    await sharp(framePaths[i]).extract({ left: 0, top: cropTop, width: w, height: newHeight }).png().toFile(outPath);
    croppedPaths.push(outPath);
  }
  return { paths: croppedPaths, headerHeight, footerHeight };
}
async function deduplicateFrames(framePaths) {
  if (framePaths.length === 0) return [];
  if (framePaths.length === 1) return framePaths;
  const unique = [framePaths[0]];
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
function computeNCC(topBuf, botBuf, maxSearch, overlap) {
  const W = NCC_SAMPLE_WIDTH;
  const n = overlap * W;
  if (n === 0) return 0;
  const rowOffset = maxSearch - overlap;
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
async function findOverlap(topImagePath, bottomImagePath) {
  const [topMeta, botMeta] = await Promise.all([
    sharp(topImagePath).metadata(),
    sharp(bottomImagePath).metadata()
  ]);
  if (!topMeta.width || !topMeta.height || !botMeta.width || !botMeta.height) {
    return 0;
  }
  const frameH = Math.min(topMeta.height, botMeta.height);
  const frameW = Math.min(topMeta.width, botMeta.width);
  const minOverlap = Math.max(OVERLAP_MIN_ABS, Math.floor(frameH * OVERLAP_MIN_FRACTION));
  const maxSearch = Math.floor(frameH * 0.9);
  if (minOverlap >= maxSearch) {
    console.log(`  overlap: skipped (frame too short: ${frameH}px)`);
    return 0;
  }
  const [topBuf, botBuf] = await Promise.all([
    sharp(topImagePath).extract({ left: 0, top: topMeta.height - maxSearch, width: frameW, height: maxSearch }).resize(NCC_SAMPLE_WIDTH, maxSearch, { fit: "fill" }).greyscale().raw().toBuffer(),
    sharp(bottomImagePath).extract({ left: 0, top: 0, width: frameW, height: maxSearch }).resize(NCC_SAMPLE_WIDTH, maxSearch, { fit: "fill" }).greyscale().raw().toBuffer()
  ]);
  let bestOverlap = 0;
  let bestNCC = -1;
  for (let ov = minOverlap; ov <= maxSearch; ov += NCC_COARSE_STEP) {
    const ncc = computeNCC(topBuf, botBuf, maxSearch, ov);
    if (ncc > bestNCC) {
      bestNCC = ncc;
      bestOverlap = ov;
    }
  }
  if (bestNCC < NCC_CONFIDENCE) {
    console.log(`  overlap: 0px (bestNCC=${bestNCC.toFixed(3)} < ${NCC_CONFIDENCE}, no confident match)`);
    return 0;
  }
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
async function stitchFrames(framePaths, outputPath, quality = "png") {
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
  const overlaps = [0];
  for (let i = 1; i < framePaths.length; i++) {
    const overlap = await findOverlap(framePaths[i - 1], framePaths[i]);
    overlaps.push(overlap);
  }
  let totalHeight = 0;
  for (let i = 0; i < framePaths.length; i++) {
    const h = metadata[i].height || 0;
    totalHeight += h - overlaps[i];
  }
  const composites = [];
  let currentY = 0;
  for (let i = 0; i < framePaths.length; i++) {
    const frameWidth = metadata[i].width || 0;
    let inputBuffer;
    if (frameWidth !== targetWidth) {
      inputBuffer = await sharp(framePaths[i]).resize(targetWidth, metadata[i].height || 0, { fit: "fill" }).toBuffer();
    } else {
      inputBuffer = await sharp(framePaths[i]).toBuffer();
    }
    composites.push({
      input: inputBuffer,
      top: currentY - overlaps[i],
      left: 0
    });
    currentY += (metadata[i].height || 0) - overlaps[i];
  }
  const pipeline = sharp({
    create: {
      width: targetWidth,
      height: totalHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 }
    }
  }).composite(composites);
  if (quality === "jpeg") {
    await pipeline.jpeg({ quality: 90 }).toFile(outputPath);
  } else {
    await pipeline.png().toFile(outputPath);
  }
  return { width: targetWidth, height: totalHeight };
}
async function generatePdf(imagePath, outputPath) {
  const PDFDocument = (await import("pdfkit")).default;
  const meta = await sharp(imagePath).metadata();
  const imgWidth = meta.width || 400;
  const imgHeight = meta.height || 800;
  const pageWidth = 595;
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  const scaledHeight = imgHeight / imgWidth * contentWidth;
  const maxPageHeight = 14400;
  const pageHeight = Math.min(scaledHeight + margin * 2, maxPageHeight);
  const doc = new PDFDocument({
    size: [pageWidth, pageHeight],
    margin
  });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);
  doc.image(imagePath, margin, margin, { width: contentWidth });
  doc.end();
  await new Promise((resolve3, reject) => {
    stream.on("finish", resolve3);
    stream.on("error", reject);
  });
}

// server/routes.ts
var privacyPolicyHtml = fs2.readFileSync(
  path2.resolve(process.cwd(), "server", "templates", "privacy-policy.html"),
  "utf-8"
);
var uploadDir = path2.join(os2.tmpdir(), "scrollsnap-uploads");
fs2.mkdirSync(uploadDir, { recursive: true });
var upload = multer({
  dest: uploadDir,
  limits: { fileSize: 100 * 1024 * 1024 }
});
var jobProgress = /* @__PURE__ */ new Map();
function updateJob(id, update) {
  const existing = jobProgress.get(id);
  if (existing) {
    Object.assign(existing, update);
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobProgress.entries()) {
    if (now - job.createdAt > 30 * 60 * 1e3) {
      jobProgress.delete(id);
    }
  }
}, 5 * 60 * 1e3);
async function registerRoutes(app2) {
  app2.get("/privacy", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(privacyPolicyHtml);
  });
  app2.post(
    "/api/process-frames",
    upload.array("frames", 500),
    async (req, res) => {
      const jobId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
      try {
        const files = req.files;
        if (!files || files.length === 0) {
          return res.status(400).json({ error: "No frames provided" });
        }
        console.log(`Received ${files.length} frames for job ${jobId}`);
        jobProgress.set(jobId, { stage: "Processing", progress: 0, createdAt: Date.now() });
        res.json({ jobId, frameCount: files.length });
        (async () => {
          try {
            const framePaths = files.map((f) => f.path);
            updateJob(jobId, { stage: "Removing duplicates", progress: 0.2 });
            const uniqueFrames = await deduplicateFrames(framePaths);
            console.log(
              `Deduplicated: ${framePaths.length} -> ${uniqueFrames.length} frames`
            );
            updateJob(jobId, { stage: "Removing sticky headers", progress: 0.4 });
            const { paths: cleanedFrames, headerHeight, footerHeight } = await detectAndRemoveStickyHeaders(uniqueFrames);
            if (headerHeight > 0 || footerHeight > 0) {
              console.log(`Removed sticky: header=${headerHeight}px, footer=${footerHeight}px`);
            }
            const quality = req.query.quality === "jpeg" ? "jpeg" : "png";
            const outputDir = path2.join(os2.tmpdir(), "scrollsnap-output");
            fs2.mkdirSync(outputDir, { recursive: true });
            const imgExt = quality === "jpeg" ? "jpg" : "png";
            const outputImagePath = path2.join(outputDir, `${jobId}.${imgExt}`);
            updateJob(jobId, { stage: "Stitching frames", progress: 0.55 });
            const dimensions = await stitchFrames(
              cleanedFrames,
              outputImagePath,
              quality
            );
            const outputPdfPath = path2.join(outputDir, `${jobId}.pdf`);
            updateJob(jobId, { stage: "Generating PDF", progress: 0.8 });
            await generatePdf(outputImagePath, outputPdfPath);
            updateJob(jobId, {
              stage: "Complete",
              progress: 1,
              result: {
                imageUrl: `/api/output/${jobId}.${imgExt}`,
                pdfUrl: `/api/output/${jobId}.pdf`,
                frameCount: framePaths.length,
                uniqueFrames: uniqueFrames.length,
                dimensions
              }
            });
            for (const f of files) {
              try {
                fs2.unlinkSync(f.path);
              } catch {
              }
            }
          } catch (err) {
            console.error("Processing error:", err);
            updateJob(jobId, { stage: "Error", progress: 0, error: err.message });
          }
        })();
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
  );
  app2.get("/api/progress/:jobId", (req, res) => {
    const job = jobProgress.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json(job);
  });
  app2.get("/api/output/:filename", (req, res) => {
    const outputDir = path2.join(os2.tmpdir(), "scrollsnap-output");
    const filename = path2.basename(req.params.filename);
    const filePath = path2.join(outputDir, filename);
    if (!fs2.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }
    const ext = path2.extname(filePath).toLowerCase();
    const contentType = ext === ".pdf" ? "application/pdf" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${filename}"`
    );
    fs2.createReadStream(filePath).pipe(res);
  });
  app2.get("/api/output-base64/:filename", (req, res) => {
    const outputDir = path2.join(os2.tmpdir(), "scrollsnap-output");
    const filename = path2.basename(req.params.filename);
    const filePath = path2.join(outputDir, filename);
    if (!fs2.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }
    const data = fs2.readFileSync(filePath);
    const base64 = data.toString("base64");
    const ext = path2.extname(filePath).toLowerCase();
    const mimeType = ext === ".pdf" ? "application/pdf" : "image/png";
    res.json({ base64, mimeType, filename });
  });
  app2.get("/api/crop/:filename", async (req, res) => {
    try {
      const sharp2 = (await import("sharp")).default;
      const outputDir = path2.join(os2.tmpdir(), "scrollsnap-output");
      const filename = path2.basename(req.params.filename);
      const filePath = path2.join(outputDir, filename);
      if (!fs2.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found" });
      }
      const cropTop = Math.max(0, parseInt(req.query.top) || 0);
      const cropBottom = Math.max(0, parseInt(req.query.bottom) || 0);
      if (cropTop === 0 && cropBottom === 0) {
        return res.status(400).json({ error: "No crop values provided" });
      }
      const meta = await sharp2(filePath).metadata();
      const origWidth = meta.width ?? 0;
      const origHeight = meta.height ?? 0;
      const newHeight = Math.max(10, origHeight - cropTop - cropBottom);
      const ext = path2.extname(filename).toLowerCase();
      const baseName = path2.basename(filename, ext);
      const croppedFilename = `${baseName}_crop${ext}`;
      const croppedPath = path2.join(outputDir, croppedFilename);
      await sharp2(filePath).extract({ left: 0, top: cropTop, width: origWidth, height: newHeight }).toFile(croppedPath);
      const pdfFilename = `${baseName}_crop.pdf`;
      const pdfPath = path2.join(outputDir, pdfFilename);
      await generatePdf(croppedPath, pdfPath);
      res.json({
        imageUrl: `/api/output/${croppedFilename}`,
        pdfUrl: `/api/output/${pdfFilename}`,
        dimensions: { width: origWidth, height: newHeight }
      });
    } catch (err) {
      console.error("Crop error:", err);
      res.status(500).json({ error: err.message });
    }
  });
  const httpServer = createServer(app2);
  return httpServer;
}

// server/index.ts
import * as fs3 from "fs";
import * as path3 from "path";
var app = express();
var log = console.log;
function setupCors(app2) {
  app2.use((req, res, next) => {
    const origins = /* @__PURE__ */ new Set();
    if (process.env.REPLIT_DEV_DOMAIN) {
      origins.add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
    }
    if (process.env.REPLIT_DOMAINS) {
      process.env.REPLIT_DOMAINS.split(",").forEach((d) => {
        origins.add(`https://${d.trim()}`);
      });
    }
    const origin = req.header("origin");
    const isLocalhost = origin?.startsWith("http://localhost:") || origin?.startsWith("http://127.0.0.1:");
    if (origin && (origins.has(origin) || isLocalhost)) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS"
      );
      res.header("Access-Control-Allow-Headers", "Content-Type");
      res.header("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });
}
function setupBodyParsing(app2) {
  app2.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      }
    })
  );
  app2.use(express.urlencoded({ extended: false, limit: "500mb" }));
}
function setupRequestLogging(app2) {
  app2.use((req, res, next) => {
    const start = Date.now();
    const path4 = req.path;
    let capturedJsonResponse = void 0;
    const originalResJson = res.json;
    res.json = function(bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };
    res.on("finish", () => {
      if (!path4.startsWith("/api")) return;
      const duration = Date.now() - start;
      let logLine = `${req.method} ${path4} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "\u2026";
      }
      log(logLine);
    });
    next();
  });
}
function getAppName() {
  try {
    const appJsonPath = path3.resolve(process.cwd(), "app.json");
    const appJsonContent = fs3.readFileSync(appJsonPath, "utf-8");
    const appJson = JSON.parse(appJsonContent);
    return appJson.expo?.name || "App Landing Page";
  } catch {
    return "App Landing Page";
  }
}
function serveExpoManifest(platform, res) {
  const manifestPath = path3.resolve(
    process.cwd(),
    "static-build",
    platform,
    "manifest.json"
  );
  if (!fs3.existsSync(manifestPath)) {
    return res.status(404).json({ error: `Manifest not found for platform: ${platform}` });
  }
  res.setHeader("expo-protocol-version", "1");
  res.setHeader("expo-sfv-version", "0");
  res.setHeader("content-type", "application/json");
  const manifest = fs3.readFileSync(manifestPath, "utf-8");
  res.send(manifest);
}
function serveLandingPage({
  req,
  res,
  landingPageTemplate,
  appName
}) {
  const forwardedProto = req.header("x-forwarded-proto");
  const protocol = forwardedProto || req.protocol || "https";
  const forwardedHost = req.header("x-forwarded-host");
  const host = forwardedHost || req.get("host");
  const baseUrl = `${protocol}://${host}`;
  const expsUrl = `${host}`;
  log(`baseUrl`, baseUrl);
  log(`expsUrl`, expsUrl);
  const html = landingPageTemplate.replace(/BASE_URL_PLACEHOLDER/g, baseUrl).replace(/EXPS_URL_PLACEHOLDER/g, expsUrl).replace(/APP_NAME_PLACEHOLDER/g, appName);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}
function configureExpoAndLanding(app2) {
  const templatePath = path3.resolve(
    process.cwd(),
    "server",
    "templates",
    "landing-page.html"
  );
  const landingPageTemplate = fs3.readFileSync(templatePath, "utf-8");
  const appName = getAppName();
  log("Serving static Expo files with dynamic manifest routing");
  app2.use((req, res, next) => {
    if (req.path.startsWith("/api")) {
      return next();
    }
    if (req.path !== "/" && req.path !== "/manifest") {
      return next();
    }
    const platform = req.header("expo-platform");
    if (platform && (platform === "ios" || platform === "android")) {
      return serveExpoManifest(platform, res);
    }
    if (req.path === "/") {
      return serveLandingPage({
        req,
        res,
        landingPageTemplate,
        appName
      });
    }
    next();
  });
  app2.use("/assets", express.static(path3.resolve(process.cwd(), "assets")));
  app2.use(express.static(path3.resolve(process.cwd(), "static-build")));
  log("Expo routing: Checking expo-platform header on / and /manifest");
}
function setupErrorHandler(app2) {
  app2.use((err, _req, res, next) => {
    const error = err;
    const status = error.status || error.statusCode || 500;
    const message = error.message || "Internal Server Error";
    console.error("Internal Server Error:", err);
    if (res.headersSent) {
      return next(err);
    }
    return res.status(status).json({ message });
  });
}
(async () => {
  setupCors(app);
  setupBodyParsing(app);
  setupRequestLogging(app);
  configureExpoAndLanding(app);
  const server = await registerRoutes(app);
  setupErrorHandler(app);
  const port = parseInt(process.env.PORT || "5000", 10);
  server.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true
    },
    () => {
      log(`express server serving on port ${port}`);
    }
  );
})();
