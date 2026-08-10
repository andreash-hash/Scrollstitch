// server/index.ts
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

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
var OVERLAP_MIN_FRACTION = 0.04;
var OVERLAP_MIN_ABS = 24;
var OVERLAP_MAX_FRACTION = 0.99;
var OVERLAP_SMALL_FRACTION = 0.25;
var OVERLAP_SMALL_PENALTY = 0.1;
var NCC_SAMPLE_WIDTH = 64;
var NCC_COARSE_STEP = 8;
var NCC_FINE_RANGE = 16;
var NCC_FINE_STEP = 1;
var NCC_MAX_BANDS = 9;
var NCC_MIN_BAND_ROWS = 12;
var STICKY_GUARD_FRACTION = 0.08;
var NCC_CONFIDENCE_MAX = 0.85;
var NCC_CONFIDENCE_MIN = 0.75;
var NCC_CONTRAST_LOW = 8;
var NCC_CONTRAST_HIGH = 40;
var SELECT_TARGET_MAX_FRACTION = 0.6;
var SELECT_NEAR_DUP_FRACTION = 0.8;
var SELECT_NEAR_DUP_SIMILARITY = 0.9;
var JPEG_MAX_DIMENSION = 65500;
var MAX_OUTPUT_PIXELS = 2e8;
async function getFrameSignature(framePath, size = DEDUP_HASH_SIZE) {
  const base = sharp(framePath).resize(size, size, { fit: "fill" }).greyscale();
  const raw = await base.clone().raw().toBuffer();
  const norm = await base.clone().normalise().raw().toBuffer();
  return { raw, norm };
}
function bufferSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) < 20) matches++;
  }
  return matches / a.length;
}
function sigSimilarity(a, b) {
  return Math.min(bufferSimilarity(a.raw, b.raw), bufferSimilarity(a.norm, b.norm));
}
function greyStddev(buf) {
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
async function validateFrames(framePaths, onProgress) {
  const valid = [];
  const warnings = [];
  for (let i = 0; i < framePaths.length; i++) {
    try {
      const probe = await sharp(framePaths[i]).resize(32, 32, { fit: "fill" }).greyscale().raw().toBuffer();
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
  const outputDir2 = path.join(os.tmpdir(), "scrollstitch-cropped");
  fs.mkdirSync(outputDir2, { recursive: true });
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
    const outPath = path.join(outputDir2, `cropped_${i}_${path.basename(framePaths[i])}.png`);
    await sharp(framePaths[i]).extract({ left: 0, top: cropTop, width: w, height: newHeight }).png().toFile(outPath);
    croppedPaths.push(outPath);
  }
  return { paths: croppedPaths, headerHeight, footerHeight };
}
async function deduplicateFrames(framePaths, onProgress) {
  if (framePaths.length === 0) return [];
  if (framePaths.length === 1) return framePaths;
  const unique = [framePaths[0]];
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
function nccOverRows(topBuf, botBuf, rowOffset, lo, hi) {
  const W = NCC_SAMPLE_WIDTH;
  const n = (hi - lo) * W;
  if (n <= 0) return 0;
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
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function computeNCC(topBuf, botBuf, maxSearch, overlap, guard = 0) {
  const lo = guard;
  const hi = overlap - guard;
  const rows = hi - lo;
  if (rows <= 0) return 0;
  const rowOffset = maxSearch - overlap;
  const global = nccOverRows(topBuf, botBuf, rowOffset, lo, hi);
  const bands = Math.min(NCC_MAX_BANDS, Math.floor(rows / NCC_MIN_BAND_ROWS));
  if (bands < 3) return global;
  const bandScores = [];
  for (let b = 0; b < bands; b++) {
    const bandLo = lo + Math.floor(rows * b / bands);
    const bandHi = lo + Math.floor(rows * (b + 1) / bands);
    bandScores.push(nccOverRows(topBuf, botBuf, rowOffset, bandLo, bandHi));
  }
  return Math.max(global, median(bandScores));
}
function adaptiveNccThreshold(contrast) {
  if (contrast >= NCC_CONTRAST_HIGH) return NCC_CONFIDENCE_MAX;
  if (contrast <= NCC_CONTRAST_LOW) return NCC_CONFIDENCE_MIN;
  const t = (contrast - NCC_CONTRAST_LOW) / (NCC_CONTRAST_HIGH - NCC_CONTRAST_LOW);
  return NCC_CONFIDENCE_MIN + t * (NCC_CONFIDENCE_MAX - NCC_CONFIDENCE_MIN);
}
function nccThresholdFor(base, overlapPx, frameHeight) {
  const fraction = overlapPx / Math.max(1, frameHeight);
  if (fraction >= OVERLAP_SMALL_FRACTION) return base;
  const smallness = (OVERLAP_SMALL_FRACTION - fraction) / OVERLAP_SMALL_FRACTION;
  return Math.min(0.98, base + smallness * OVERLAP_SMALL_PENALTY);
}
async function measureOverlap(topImagePath, bottomImagePath) {
  const none = (frameHeight) => ({
    matched: false,
    overlapPx: 0,
    ncc: 0,
    threshold: NCC_CONFIDENCE_MAX,
    contrast: 0,
    frameHeight
  });
  const topMeta = await sharp(topImagePath).metadata();
  const botMeta = await sharp(bottomImagePath).metadata();
  if (!topMeta.width || !topMeta.height || !botMeta.width || !botMeta.height) {
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
  const topBuf = await sharp(topImagePath).extract({ left: 0, top: topMeta.height - maxSearch, width: frameW, height: maxSearch }).resize(NCC_SAMPLE_WIDTH, maxSearch, { fit: "fill" }).greyscale().raw().toBuffer();
  const botBuf = await sharp(bottomImagePath).extract({ left: 0, top: 0, width: frameW, height: maxSearch }).resize(NCC_SAMPLE_WIDTH, maxSearch, { fit: "fill" }).greyscale().raw().toBuffer();
  const contrast = (greyStddev(topBuf) + greyStddev(botBuf)) / 2;
  const baseThreshold = adaptiveNccThreshold(contrast);
  const stickyGuard = Math.round(frameH * STICKY_GUARD_FRACTION);
  const guardFor = (ov) => Math.min(stickyGuard, Math.floor(ov / 4));
  let bestOverlap = 0;
  let bestNCC = -1;
  let bestMargin = -Infinity;
  const consider = (ov) => {
    const ncc = computeNCC(topBuf, botBuf, maxSearch, ov, guardFor(ov));
    const margin = ncc - nccThresholdFor(baseThreshold, ov, frameH);
    if (margin > bestMargin) {
      bestMargin = margin;
      bestNCC = ncc;
      bestOverlap = ov;
    }
  };
  for (let ov = minOverlap; ov <= maxSearch; ov += NCC_COARSE_STEP) {
    consider(ov);
  }
  const lo = Math.max(minOverlap, bestOverlap - NCC_FINE_RANGE);
  const hi = Math.min(maxSearch, bestOverlap + NCC_FINE_RANGE);
  for (let ov = lo; ov <= hi; ov += NCC_FINE_STEP) {
    consider(ov);
  }
  const threshold = nccThresholdFor(baseThreshold, bestOverlap, frameH);
  const pct = (bestOverlap / frameH * 100).toFixed(0);
  if (bestNCC < threshold) {
    console.log(
      `  overlap: none (best NCC=${bestNCC.toFixed(3)} at ${bestOverlap}px/${pct}% < threshold=${threshold.toFixed(3)}, contrast=${contrast.toFixed(1)}, searched ${minOverlap}\u2013${maxSearch}px)`
    );
    return { matched: false, overlapPx: 0, ncc: bestNCC, threshold, contrast, frameHeight: frameH };
  }
  console.log(
    `  overlap: ${bestOverlap}px/${pct}% (NCC=${bestNCC.toFixed(3)}, threshold=${threshold.toFixed(3)}, contrast=${contrast.toFixed(1)})`
  );
  return { matched: true, overlapPx: bestOverlap, ncc: bestNCC, threshold, contrast, frameHeight: frameH };
}
var START_SEAM = { type: "start", overlapPx: 0, ncc: 0, nccThreshold: 0, contrast: 0 };
function seamFromMeasurement(m) {
  return {
    type: m.matched ? "overlap" : "gap",
    overlapPx: m.overlapPx,
    ncc: m.ncc,
    nccThreshold: m.threshold,
    contrast: m.contrast
  };
}
async function selectFrames(framePaths, onProgress) {
  const empty = {
    paths: [],
    seams: [],
    warnings: [],
    gapCount: 0,
    skippedNearDuplicates: 0,
    skippedRedundant: 0
  };
  if (framePaths.length === 0) return empty;
  const selection = {
    ...empty,
    paths: [framePaths[0]],
    seams: [{ ...START_SEAM }]
  };
  if (framePaths.length === 1) return selection;
  let refPath = framePaths[0];
  let refSig = null;
  try {
    refSig = await getFrameSignature(refPath);
  } catch {
    refSig = null;
  }
  let fallback = null;
  const keep = (p, seam, sig) => {
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
    let sig = null;
    try {
      sig = await getFrameSignature(candidate);
    } catch {
      sig = null;
    }
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
    if (fallback) {
      console.log(`  select: promoting skipped frame to bridge a potential gap`);
      keep(fallback.path, fallback.seam, fallback.sig);
      continue;
    }
    const warning = `Scroll jump around frame ${i + 1} of ${framePaths.length} \u2014 the scroll moved too fast here, so some content may be missing at this join.`;
    console.warn(
      `  select: GAP at frame ${i + 1}/${framePaths.length} (best NCC ${Math.max(0, m.ncc).toFixed(3)} < threshold ${m.threshold.toFixed(3)})`
    );
    selection.warnings.push(warning);
    keep(candidate, seamFromMeasurement(m), sig);
    onProgress?.(i, total);
    i++;
  }
  if (fallback !== null) {
    const f = fallback;
    console.log(`  select: promoting final skipped frame to preserve the end of the scroll`);
    keep(f.path, f.seam, f.sig);
  }
  if (framePaths.length > 1 && selection.paths.length === 1) {
    selection.warnings.push(
      "All frames were near-duplicates of the first frame \u2014 the result is a single frame. Make sure the recording actually scrolls."
    );
  }
  const seamCount = selection.paths.length - 1;
  if (seamCount > 0 && selection.gapCount >= Math.max(3, Math.ceil(seamCount / 2))) {
    selection.warnings.unshift(
      `Most frames did not overlap (${selection.gapCount} of ${seamCount} seams) \u2014 the scrolling was probably too fast for stitching. Re-record with a slower, steadier scroll.`
    );
  }
  console.log(
    `Selection: ${framePaths.length} \u2192 ${selection.paths.length} frames (${selection.skippedNearDuplicates} near-duplicates, ${selection.skippedRedundant} redundant, ${selection.gapCount} gaps)`
  );
  return selection;
}
async function decodeFrameRgb(framePath, targetWidth) {
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
  const { data, info } = await pipeline.removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  if (info.channels === 3) {
    return { data, width: info.width, height: info.height };
  }
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
async function stitchFrames(framePaths, outputPath, quality = "png", seams = null, onProgress) {
  if (framePaths.length === 0) {
    throw new Error("No frames to stitch");
  }
  if (framePaths.length === 1) {
    const meta = await sharp(framePaths[0]).metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    const format2 = quality === "jpeg" && height <= JPEG_MAX_DIMENSION && width <= JPEG_MAX_DIMENSION ? "jpeg" : "png";
    const single = sharp(framePaths[0]);
    if (format2 === "jpeg") {
      await single.jpeg({ quality: 90 }).toFile(outputPath);
    } else {
      await single.png().toFile(outputPath);
    }
    onProgress?.(1, 1);
    return { width, height, format: format2 };
  }
  const heights = [];
  const widths = [];
  for (const p of framePaths) {
    const meta = await sharp(p).metadata();
    if (!meta.width || !meta.height) {
      throw new Error(`Frame could not be decoded: ${path.basename(p)}`);
    }
    widths.push(meta.width);
    heights.push(meta.height);
  }
  const targetWidth = widths[0];
  let seamPlan;
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
      `Stitched image would be too large (${targetWidth}\xD7${totalHeight}px). Try a shorter recording or split it into parts.`
    );
  }
  let format = quality;
  if (format === "jpeg" && (totalHeight > JPEG_MAX_DIMENSION || targetWidth > JPEG_MAX_DIMENSION)) {
    console.log(
      `stitch: output ${targetWidth}\xD7${totalHeight}px exceeds the JPEG limit \u2014 falling back to PNG`
    );
    format = "png";
  }
  const rowBytes = targetWidth * 3;
  const canvas = Buffer.alloc(rowBytes * totalHeight);
  let currentY = 0;
  for (let i = 0; i < framePaths.length; i++) {
    const { data, height } = await decodeFrameRgb(framePaths[i], targetWidth);
    const overlap = i === 0 ? 0 : Math.max(0, Math.min(seamPlan[i].overlapPx, currentY, height - 1));
    const top = currentY - overlap;
    const cut = overlap > 0 ? Math.floor(overlap / 2) : 0;
    data.copy(canvas, (top + cut) * rowBytes, cut * rowBytes);
    currentY = top + height;
    onProgress?.(i + 1, framePaths.length);
  }
  const pipeline = sharp(canvas, {
    raw: { width: targetWidth, height: totalHeight, channels: 3 },
    limitInputPixels: false
  });
  if (format === "jpeg") {
    await pipeline.jpeg({ quality: 90 }).toFile(outputPath);
  } else {
    await pipeline.png().toFile(outputPath);
  }
  return { width: targetWidth, height: totalHeight, format };
}
var PREVIEW_MAX_PIXELS = 12e6;
async function generatePreviewImage(imagePath, outputPath, maxPixels = PREVIEW_MAX_PIXELS) {
  const meta = await sharp(imagePath).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  const pixels = width * height;
  if (!pixels || pixels <= maxPixels) {
    return { scaled: false, width, height };
  }
  const factor = Math.min(Math.sqrt(maxPixels / pixels), (JPEG_MAX_DIMENSION - 100) / height);
  const previewWidth = Math.max(1, Math.round(width * factor));
  const previewHeight = Math.max(1, Math.round(height * factor));
  await sharp(imagePath, { limitInputPixels: false }).resize(previewWidth, previewHeight, { fit: "fill" }).jpeg({ quality: 75 }).toFile(outputPath);
  console.log(
    `preview: ${width}\xD7${height} (${(pixels / 1e6).toFixed(0)}MP) \u2192 ${previewWidth}\xD7${previewHeight}`
  );
  return { scaled: true, width: previewWidth, height: previewHeight };
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
var BUILD_INFO = (() => {
  let name = "unknown";
  let version = "unknown";
  try {
    const appJson = JSON.parse(
      fs2.readFileSync(path2.resolve(process.cwd(), "app.json"), "utf-8")
    );
    name = appJson.expo?.name ?? "unknown";
    version = appJson.expo?.version ?? "unknown";
  } catch {
  }
  let commit = "unknown";
  try {
    const gitDir = path2.resolve(process.cwd(), ".git");
    const head = fs2.readFileSync(path2.join(gitDir, "HEAD"), "utf-8").trim();
    if (head.startsWith("ref: ")) {
      const ref = head.slice(5).trim();
      try {
        commit = fs2.readFileSync(path2.join(gitDir, ref), "utf-8").trim();
      } catch {
        const packed = fs2.readFileSync(path2.join(gitDir, "packed-refs"), "utf-8");
        const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
        if (line) commit = line.split(" ")[0];
      }
    } else {
      commit = head;
    }
  } catch {
  }
  return {
    name,
    version,
    commit: commit === "unknown" ? commit : commit.slice(0, 7),
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    privacyPolicyMentions: /ScrollSnap/i.test(privacyPolicyHtml) ? "ScrollSnap" : "current"
  };
})();
var uploadDir = path2.join(os2.tmpdir(), "scrollstitch-uploads");
fs2.mkdirSync(uploadDir, { recursive: true });
var upload = multer({
  dest: uploadDir,
  limits: { fileSize: 100 * 1024 * 1024 }
});
var sessionsDir = path2.join(os2.tmpdir(), "scrollstitch-sessions");
fs2.mkdirSync(sessionsDir, { recursive: true });
function sanitiseSessionId(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
}
var chunkStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const id = sanitiseSessionId(req.query.sessionId);
    if (!id) return cb(new Error("Missing sessionId"), "");
    const dir = path2.join(sessionsDir, id);
    fs2.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, _file, cb) => {
    const chunk = String(req.query.chunkIndex ?? "0").replace(/\D/g, "").padStart(5, "0");
    const seq = String(chunkSeq++).padStart(5, "0");
    cb(null, `${chunk}_${seq}`);
  }
});
var chunkSeq = 0;
var chunkUpload = multer({
  storage: chunkStorage,
  limits: { fileSize: 100 * 1024 * 1024 }
});
setInterval(() => {
  try {
    for (const entry of fs2.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path2.join(sessionsDir, entry.name);
      try {
        if (Date.now() - fs2.statSync(dir).mtimeMs > 60 * 60 * 1e3) {
          fs2.rmSync(dir, { recursive: true, force: true });
        }
      } catch {
      }
    }
  } catch {
  }
}, 15 * 60 * 1e3).unref();
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
}, 5 * 60 * 1e3).unref();
function firstString(value) {
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" ? value : "";
}
var outputDir = path2.join(os2.tmpdir(), "scrollstitch-output");
var STAGE_SPANS = {
  validate: [0, 0.05],
  dedup: [0.05, 0.2],
  sticky: [0.2, 0.3],
  select: [0.3, 0.55],
  stitch: [0.55, 0.85],
  pdf: [0.85, 0.98]
};
async function registerRoutes(app2) {
  app2.get("/api/health", (_req, res) => {
    res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()), ...BUILD_INFO });
  });
  app2.get("/privacy", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(privacyPolicyHtml);
  });
  app2.post(
    "/api/upload-chunk",
    chunkUpload.array("frames", 500),
    (req, res) => {
      if (!sanitiseSessionId(req.query.sessionId)) {
        return res.status(400).json({ error: "Missing or invalid sessionId" });
      }
      const files = req.files ?? [];
      res.json({ received: files.length });
    }
  );
  app2.post(
    "/api/process-frames",
    // A session-based request carries no body: skip multer entirely so it does
    // not reject the empty multipart payload.
    (req, res, next) => {
      if (firstString(req.query.sessionId)) {
        req.files = [];
        return next();
      }
      upload.array("frames", 500)(req, res, next);
    },
    async (req, res) => {
      const jobId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
      try {
        const sessionId = sanitiseSessionId(req.query.sessionId);
        let framePaths;
        let sessionDir = null;
        if (sessionId) {
          sessionDir = path2.join(sessionsDir, sessionId);
          let staged = [];
          try {
            staged = fs2.readdirSync(sessionDir).sort();
          } catch {
          }
          if (staged.length === 0) {
            return res.status(400).json({
              error: "The uploaded frames could not be found. They may have expired \u2014 please try again."
            });
          }
          framePaths = staged.map((f) => path2.join(sessionDir, f));
        } else {
          const files = req.files ?? [];
          if (files.length === 0) {
            return res.status(400).json({
              error: "No frames were received. Record a scrolling screen video and try again."
            });
          }
          framePaths = files.map((f) => f.path);
        }
        console.log(
          `Received ${framePaths.length} frames for job ${jobId}` + (sessionId ? ` (session ${sessionId})` : "")
        );
        const quality = firstString(req.query.quality) === "jpeg" ? "jpeg" : "png";
        jobProgress.set(jobId, { stage: "Processing", progress: 0, createdAt: Date.now() });
        res.json({ jobId, frameCount: framePaths.length });
        (async () => {
          const tempOutputs = [];
          try {
            const warnings = [];
            const stageProgress = (stage, span) => (done, total) => {
              const t = total > 0 ? done / total : 1;
              updateJob(jobId, {
                stage,
                progress: span[0] + t * (span[1] - span[0]),
                detail: `${done}/${total}`
              });
            };
            updateJob(jobId, { stage: "Validating frames", progress: 0 });
            const { valid: validFrames, warnings: validationWarnings } = await validateFrames(framePaths, stageProgress("Validating frames", STAGE_SPANS.validate));
            warnings.push(...validationWarnings);
            if (validFrames.length === 0) {
              throw new Error(
                "None of the uploaded frames could be read as images. The recording may be corrupt \u2014 please try recording again."
              );
            }
            if (validFrames.length < framePaths.length) {
              console.warn(
                `Job ${jobId}: ${framePaths.length - validFrames.length} corrupt frame(s) skipped`
              );
            }
            updateJob(jobId, { stage: "Removing duplicates", progress: STAGE_SPANS.dedup[0], detail: void 0 });
            const uniqueFrames = await deduplicateFrames(
              validFrames,
              stageProgress("Removing duplicates", STAGE_SPANS.dedup)
            );
            console.log(
              `Deduplicated: ${validFrames.length} -> ${uniqueFrames.length} frames`
            );
            updateJob(jobId, { stage: "Removing sticky headers", progress: STAGE_SPANS.sticky[0], detail: void 0 });
            const { paths: cleanedFrames, headerHeight, footerHeight } = await detectAndRemoveStickyHeaders(uniqueFrames);
            if (headerHeight > 0 || footerHeight > 0) {
              console.log(`Removed sticky: header=${headerHeight}px, footer=${footerHeight}px`);
            }
            tempOutputs.push(...cleanedFrames.filter((p) => !framePaths.includes(p)));
            updateJob(jobId, { stage: "Selecting frames", progress: STAGE_SPANS.select[0], detail: void 0 });
            const selection = await selectFrames(
              cleanedFrames,
              stageProgress("Selecting frames", STAGE_SPANS.select)
            );
            warnings.push(...selection.warnings);
            if (selection.paths.length === 0) {
              throw new Error(
                "No stitchable frames were found in the recording. Please try again."
              );
            }
            console.log(
              `Selected ${selection.paths.length}/${cleanedFrames.length} frames, ${selection.gapCount} gap(s)`
            );
            fs2.mkdirSync(outputDir, { recursive: true });
            updateJob(jobId, { stage: "Stitching frames", progress: STAGE_SPANS.stitch[0], detail: void 0 });
            const tmpStitchPath = path2.join(outputDir, `${jobId}.stitch.tmp`);
            tempOutputs.push(tmpStitchPath);
            const stitchResult = await stitchFrames(
              selection.paths,
              tmpStitchPath,
              quality,
              selection.seams,
              stageProgress("Stitching frames", STAGE_SPANS.stitch)
            );
            const imgExt = stitchResult.format === "jpeg" ? "jpg" : "png";
            const outputImagePath = path2.join(outputDir, `${jobId}.${imgExt}`);
            fs2.renameSync(tmpStitchPath, outputImagePath);
            if (quality === "jpeg" && stitchResult.format === "png") {
              warnings.push(
                "The stitched image is too tall for JPEG \u2014 it was saved as PNG instead."
              );
            }
            let previewUrl = `/api/output/${jobId}.${imgExt}`;
            const previewPath = path2.join(outputDir, `${jobId}_preview.jpg`);
            const preview = await generatePreviewImage(outputImagePath, previewPath);
            if (preview.scaled) {
              previewUrl = `/api/output/${jobId}_preview.jpg`;
            }
            const outputPdfPath = path2.join(outputDir, `${jobId}.pdf`);
            updateJob(jobId, { stage: "Generating PDF", progress: STAGE_SPANS.pdf[0], detail: void 0 });
            await generatePdf(outputImagePath, outputPdfPath);
            const seamSummary = selection.seams.map((s, i) => ({
              index: i,
              type: s.type,
              overlapPx: s.overlapPx,
              ncc: Math.round(s.ncc * 1e3) / 1e3,
              nccThreshold: Math.round(s.nccThreshold * 1e3) / 1e3
            }));
            updateJob(jobId, {
              stage: "Complete",
              progress: 1,
              detail: void 0,
              result: {
                imageUrl: `/api/output/${jobId}.${imgExt}`,
                previewUrl,
                pdfUrl: `/api/output/${jobId}.pdf`,
                frameCount: framePaths.length,
                uniqueFrames: uniqueFrames.length,
                selectedFrames: selection.paths.length,
                gapCount: selection.gapCount,
                warnings,
                seams: seamSummary,
                dimensions: { width: stitchResult.width, height: stitchResult.height }
              }
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : "Processing failed unexpectedly.";
            console.error(`Processing error (job ${jobId}):`, err);
            updateJob(jobId, { stage: "Error", progress: 0, error: message });
          } finally {
            for (const f of [...framePaths, ...tempOutputs]) {
              try {
                fs2.unlinkSync(f);
              } catch {
              }
            }
            if (sessionDir) {
              try {
                fs2.rmSync(sessionDir, { recursive: true, force: true });
              } catch {
              }
            }
          }
        })();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed.";
        return res.status(500).json({ error: message });
      }
    }
  );
  app2.get("/api/progress/:jobId", (req, res) => {
    const job = jobProgress.get(firstString(req.params.jobId));
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json(job);
  });
  app2.get("/api/output/:filename", (req, res) => {
    const filename = path2.basename(firstString(req.params.filename));
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
    const filename = path2.basename(firstString(req.params.filename));
    const filePath = path2.join(outputDir, filename);
    if (!fs2.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }
    const data = fs2.readFileSync(filePath);
    const base64 = data.toString("base64");
    const ext = path2.extname(filePath).toLowerCase();
    const mimeType = ext === ".pdf" ? "application/pdf" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
    res.json({ base64, mimeType, filename });
  });
  app2.get("/api/crop/:filename", async (req, res) => {
    try {
      const sharp2 = (await import("sharp")).default;
      const filename = path2.basename(firstString(req.params.filename));
      const filePath = path2.join(outputDir, filename);
      if (!fs2.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found" });
      }
      const cropTop = Math.max(0, parseInt(firstString(req.query.top), 10) || 0);
      const cropBottom = Math.max(0, parseInt(firstString(req.query.bottom), 10) || 0);
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
      let previewUrl = `/api/output/${croppedFilename}`;
      const previewFilename = `${baseName}_crop_preview.jpg`;
      const preview = await generatePreviewImage(
        croppedPath,
        path2.join(outputDir, previewFilename)
      );
      if (preview.scaled) {
        previewUrl = `/api/output/${previewFilename}`;
      }
      const pdfFilename = `${baseName}_crop.pdf`;
      const pdfPath = path2.join(outputDir, pdfFilename);
      await generatePdf(croppedPath, pdfPath);
      res.json({
        imageUrl: `/api/output/${croppedFilename}`,
        previewUrl,
        pdfUrl: `/api/output/${pdfFilename}`,
        dimensions: { width: origWidth, height: newHeight }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Crop failed.";
      console.error("Crop error:", err);
      res.status(500).json({ error: message });
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
  const isDev = process.env.NODE_ENV === "development";
  if (isDev) {
    const metroProxy = createProxyMiddleware({
      target: "http://localhost:8081",
      changeOrigin: false,
      ws: true
    });
    app2.use((req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      const platform = req.header("expo-platform");
      if (platform === "ios" || platform === "android") {
        return metroProxy(req, res, next);
      }
      const isMetroPath = req.path.startsWith("/node_modules/") || req.path.startsWith("/_expo/") || req.path.startsWith("/assets/") || req.path.startsWith("/__metro") || req.path.startsWith("/debugger") || req.path.endsWith(".bundle") || req.path.endsWith(".map");
      if (isMetroPath) return metroProxy(req, res, next);
      next();
    });
    log("Dev mode: proxying Expo/Metro requests to localhost:8081");
    return;
  }
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
