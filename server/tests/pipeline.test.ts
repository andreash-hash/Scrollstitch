import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { generatePreviewImage, measureOverlap, nccThresholdFor } from "../video-processor";
import {
  generatePage,
  renderFrames,
  runPipeline,
  greyFromFile,
  greyFromPage,
  locateStrip,
  makeTempDir,
  cleanupTempDirs,
} from "./helpers";

const WIDTH = 540;
const FRAME_H = 960;

after(() => cleanupTempDirs());

describe("scroll stitching pipeline (e2e on synthetic recordings)", () => {
  test("smooth scrolling reconstructs the page without gaps or duplicates", async () => {
    const pageH = 3840;
    const page = generatePage(WIDTH, pageH, 42);
    const positions = [0, 576, 1152, 1728, 2304, 2880]; // 40% overlap per step
    const frames = await renderFrames({
      page,
      outDir: makeTempDir("smooth"),
      frameHeight: FRAME_H,
      frames: positions.map((position) => ({ position })),
      jpegQuality: 80,
    });

    const run = await runPipeline(frames);

    assert.equal(run.selection.gapCount, 0, "no gaps expected");
    assert.equal(run.selection.paths.length, 6, "all frames land in the 20–60% window");
    for (const seam of run.selection.seams.slice(1)) {
      assert.equal(seam.type, "overlap");
      assert.ok(
        Math.abs(seam.overlapPx - 384) <= 8,
        `seam overlap ${seam.overlapPx}px should be ≈384px`
      );
      assert.ok(
        seam.nccThreshold >= 0.84,
        `high-contrast content should use the full confidence threshold (got ${seam.nccThreshold})`
      );
    }

    // Height ≈ page height → no duplicated content and no holes
    assert.ok(
      Math.abs(run.stitch.height - pageH) <= 25,
      `stitched height ${run.stitch.height} should be ≈${pageH}`
    );

    // Content strips from all over the page must appear at the right position
    const stitched = await greyFromFile(run.outputPath);
    const pageGrey = await greyFromPage(page);
    for (const y of [200, 1000, 1900, 2800, 3500]) {
      const { bestY, bestNcc } = locateStrip(stitched, pageGrey, y);
      assert.ok(bestNcc >= 0.8, `strip at ${y}: best NCC ${bestNcc.toFixed(3)} too low`);
      assert.ok(
        Math.abs(bestY - y) <= 30,
        `strip at ${y} found at ${bestY} — drift too large`
      );
    }
  });

  test("sticky header and footer are detected, removed and kept once", async () => {
    const headerH = 120;
    const footerH = 96;
    const contentH = FRAME_H - headerH - footerH; // 744
    const positions = [0, 330, 660, 990, 1320, 1650, 1980];
    const pageH = 1980 + contentH; // 2724
    const page = generatePage(WIDTH, pageH, 77);

    const frames = await renderFrames({
      page,
      outDir: makeTempDir("sticky"),
      frameHeight: FRAME_H,
      frames: positions.map((position) => ({ position })),
      headerHeight: headerH,
      footerHeight: footerH,
      jpegQuality: 80,
    });

    const run = await runPipeline(frames);

    assert.ok(
      Math.abs(run.headerHeight - headerH) <= 24,
      `detected header ${run.headerHeight}px should be ≈${headerH}px`
    );
    assert.ok(
      Math.abs(run.footerHeight - footerH) <= 24,
      `detected footer ${run.footerHeight}px should be ≈${footerH}px`
    );
    assert.equal(run.selection.gapCount, 0);

    // Header + full covered page + footer, each sticky bar exactly once
    assert.ok(
      run.stitch.height >= pageH - 30 && run.stitch.height <= pageH + headerH + footerH + 40,
      `stitched height ${run.stitch.height} out of expected range`
    );

    const stitched = await greyFromFile(run.outputPath);
    const pageGrey = await greyFromPage(page);
    for (const y of [400, 1400, 2300]) {
      const { bestY, bestNcc } = locateStrip(stitched, pageGrey, y);
      assert.ok(bestNcc >= 0.75, `strip at ${y}: best NCC ${bestNcc.toFixed(3)} too low`);
      assert.ok(
        Math.abs(bestY - (y + run.headerHeight)) <= 45,
        `strip at ${y} found at ${bestY}, expected ≈${y + run.headerHeight}`
      );
    }
  });

  test("a scroll jump produces a gap seam and a client-visible warning", async () => {
    const positions = [0, 576, 1152, 2600, 3176, 3752]; // 1152→2600 skips content
    const pageH = 3752 + FRAME_H; // 4712
    const page = generatePage(WIDTH, pageH, 1234);

    const frames = await renderFrames({
      page,
      outDir: makeTempDir("gap"),
      frameHeight: FRAME_H,
      frames: positions.map((position) => ({ position })),
      jpegQuality: 80,
    });

    const run = await runPipeline(frames);

    assert.equal(run.selection.gapCount, 1, "exactly one gap expected");
    assert.equal(
      run.selection.seams.filter((s) => s.type === "gap").length,
      1
    );
    assert.ok(run.selection.warnings.length >= 1, "gap must produce a warning");
    assert.match(run.selection.warnings[0], /scroll jump/i);

    // Both segments stitched normally: 2112px each, butted at the gap
    assert.ok(
      Math.abs(run.stitch.height - 4224) <= 25,
      `stitched height ${run.stitch.height} should be ≈4224`
    );

    const stitched = await greyFromFile(run.outputPath);
    const pageGrey = await greyFromPage(page);
    const before = locateStrip(stitched, pageGrey, 800);
    assert.ok(before.bestNcc >= 0.8);
    assert.ok(Math.abs(before.bestY - 800) <= 35);
    // After the gap, content sits 488px higher (missing rows 2112..2600)
    const afterGap = locateStrip(stitched, pageGrey, 3000);
    assert.ok(afterGap.bestNcc >= 0.8);
    assert.ok(
      Math.abs(afterGap.bestY - (3000 - 488)) <= 35,
      `post-gap strip found at ${afterGap.bestY}, expected ≈${3000 - 488}`
    );
  });

  test("near-identical frames are dropped instead of duplicating content", async () => {
    const pageH = 3840;
    const page = generatePage(WIDTH, pageH, 555);
    // Exact duplicates and 2px micro-scrolls sprinkled into a normal scroll
    const positions = [0, 2, 576, 578, 576, 1152, 1152, 1728, 1730, 2304, 2880];
    const frames = await renderFrames({
      page,
      outDir: makeTempDir("dups"),
      frameHeight: FRAME_H,
      frames: positions.map((position) => ({ position })),
      jpegQuality: 80,
    });

    const run = await runPipeline(frames);

    assert.equal(run.selection.gapCount, 0);
    // The pipeline may drop micro-scroll frames at dedup or selection — either
    // way the stitched output must cover the page exactly once.
    assert.ok(
      Math.abs(run.stitch.height - pageH) <= 30,
      `stitched height ${run.stitch.height} should be ≈${pageH} (no duplicated content)`
    );
  });

  test("dark low-contrast screens stitch via the adaptive NCC threshold", async () => {
    const pageH = 3840;
    const page = generatePage(WIDTH, pageH, 909, "dark");
    const positions = [0, 576, 1152, 1728, 2304, 2880];
    const frames = await renderFrames({
      page,
      outDir: makeTempDir("dark"),
      frameHeight: FRAME_H,
      frames: positions.map((position) => ({ position })),
      jpegQuality: 80,
    });

    const run = await runPipeline(frames);

    assert.equal(
      run.uniqueCount,
      positions.length,
      "dedup must not collapse distinct dark frames"
    );
    assert.equal(run.selection.gapCount, 0, "adaptive threshold should stitch dark content");

    const overlapSeams = run.selection.seams.filter((s) => s.type === "overlap");
    assert.ok(overlapSeams.length >= positions.length - 1);
    for (const seam of overlapSeams) {
      assert.ok(
        seam.nccThreshold < 0.85 && seam.nccThreshold >= 0.75,
        `dark content should lower the threshold (got ${seam.nccThreshold})`
      );
    }

    assert.ok(
      Math.abs(run.stitch.height - pageH) <= 30,
      `stitched height ${run.stitch.height} should be ≈${pageH}`
    );

    const stitched = await greyFromFile(run.outputPath);
    const pageGrey = await greyFromPage(page);
    for (const y of [600, 2000, 3300]) {
      const { bestY, bestNcc } = locateStrip(stitched, pageGrey, y);
      assert.ok(bestNcc >= 0.5, `dark strip at ${y}: NCC ${bestNcc.toFixed(3)} too low`);
      assert.ok(Math.abs(bestY - y) <= 35, `dark strip at ${y} found at ${bestY}`);
    }
  });

  test("a keyboard appearing mid-scroll degrades gracefully with warnings", async () => {
    const pageH = 3012;
    const page = generatePage(WIDTH, pageH, 321);
    const specs = [
      { position: 0 },
      { position: 576 },
      { position: 1152 },
      { position: 1152, keyboard: true },
      { position: 1452, keyboard: true },
      { position: 1752, keyboard: true },
      { position: 2052, keyboard: true },
    ];
    const frames = await renderFrames({
      page,
      outDir: makeTempDir("keyboard"),
      frameHeight: FRAME_H,
      frames: specs,
      jpegQuality: 80,
    });

    const run = await runPipeline(frames);

    // The keyboard breaks overlap continuity — that must surface as explicit
    // gap warnings, never as a silent bad stitch or a crash.
    assert.ok(run.selection.gapCount >= 1, "keyboard transition should be flagged as gap");
    assert.ok(run.selection.warnings.length >= 1);
    assert.ok(run.stitch.height > FRAME_H, "output should still contain multiple segments");

    const stitched = await greyFromFile(run.outputPath);
    const pageGrey = await greyFromPage(page);
    // Pre-keyboard content is intact and correctly placed
    const early = locateStrip(stitched, pageGrey, 400);
    assert.ok(early.bestNcc >= 0.8);
    assert.ok(Math.abs(early.bestY - 400) <= 35);
    // Content scrolled while the keyboard was open is present somewhere
    const during = locateStrip(stitched, pageGrey, 1300);
    assert.ok(during.bestNcc >= 0.7, "keyboard-era content missing from output");
  });

  test("a single frame passes through unchanged", async () => {
    const page = generatePage(WIDTH, 1200, 7);
    const frames = await renderFrames({
      page,
      outDir: makeTempDir("single"),
      frameHeight: FRAME_H,
      frames: [{ position: 100 }],
      jpegQuality: 80,
    });

    const run = await runPipeline(frames);
    assert.equal(run.selection.paths.length, 1);
    assert.equal(run.selection.gapCount, 0);
    assert.equal(run.stitch.width, WIDTH);
    assert.equal(run.stitch.height, FRAME_H);
  });

  test("two overlapping frames stitch into one image", async () => {
    const pageH = 1536;
    const page = generatePage(WIDTH, pageH, 8);
    const frames = await renderFrames({
      page,
      outDir: makeTempDir("two"),
      frameHeight: FRAME_H,
      frames: [{ position: 0 }, { position: 576 }],
      jpegQuality: 80,
    });

    const run = await runPipeline(frames);
    assert.equal(run.selection.paths.length, 2);
    assert.equal(run.selection.gapCount, 0);
    assert.ok(
      Math.abs(run.stitch.height - pageH) <= 10,
      `stitched height ${run.stitch.height} should be ≈${pageH}`
    );
  });

  test("two non-overlapping frames butt together with a gap warning", async () => {
    const page = generatePage(WIDTH, 2960, 9);
    const frames = await renderFrames({
      page,
      outDir: makeTempDir("two-gap"),
      frameHeight: FRAME_H,
      frames: [{ position: 0 }, { position: 2000 }],
      jpegQuality: 80,
    });

    const run = await runPipeline(frames);
    assert.equal(run.selection.paths.length, 2);
    assert.equal(run.selection.gapCount, 1);
    assert.ok(run.selection.warnings.length >= 1);
    assert.equal(run.stitch.height, FRAME_H * 2, "gap seams butt frames without trimming");
  });

  test("corrupt frames are skipped with a warning, the rest still stitch", async () => {
    const pageH = 3840;
    const page = generatePage(WIDTH, pageH, 4242);
    const positions = [0, 576, 1152, 1728, 2304, 2880];
    const dir = makeTempDir("corrupt-mixed");
    const frames = await renderFrames({
      page,
      outDir: dir,
      frameHeight: FRAME_H,
      frames: positions.map((position) => ({ position })),
      jpegQuality: 80,
    });

    const corruptPath = path.join(dir, "frame_zz_corrupt.jpg");
    fs.writeFileSync(corruptPath, Buffer.from("definitely not a jpeg"));
    const withCorrupt = [...frames.slice(0, 3), corruptPath, ...frames.slice(3)];

    const run = await runPipeline(withCorrupt);
    assert.equal(run.validationWarnings.length, 1);
    assert.match(run.validationWarnings[0], /could not be decoded/);
    assert.ok(
      Math.abs(run.stitch.height - pageH) <= 25,
      `stitched height ${run.stitch.height} should be ≈${pageH}`
    );
  });

  test("85 frames stitch sequentially within a bounded memory footprint", async () => {
    const N = 85;
    const step = 576;
    const pageH = FRAME_H + (N - 1) * step;
    const page = generatePage(WIDTH, pageH, 31337);
    const frames = await renderFrames({
      page,
      outDir: makeTempDir("many"),
      frameHeight: FRAME_H,
      frames: Array.from({ length: N }, (_, i) => ({ position: i * step })),
      jpegQuality: 80,
    });

    let peakRss = 0;
    const iv = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage.rss());
    }, 50);
    let run;
    try {
      run = await runPipeline(frames);
    } finally {
      clearInterval(iv);
    }
    peakRss = Math.max(peakRss, process.memoryUsage.rss());

    assert.equal(run.selection.gapCount, 0);
    assert.ok(
      Math.abs(run.stitch.height - pageH) <= 60,
      `stitched height ${run.stitch.height} should be ≈${pageH}`
    );
    // Frames are decoded one at a time into a single canvas — reintroducing
    // hold-everything buffering shows up here long before production does.
    assert.ok(
      peakRss < 1.5 * 1024 * 1024 * 1024,
      `peak RSS ${(peakRss / 1e6).toFixed(0)} MB is unreasonable for 85 frames`
    );
  });

  test("overlaps far outside the common range are still found", async () => {
    // Both ends used to be blind spots: the matcher only searched 20–90% of the
    // frame, so a fast flick (tiny overlap) and dense sampling of a slow scroll
    // (near-total overlap) both looked like "no overlap at all".
    const page = generatePage(WIDTH, 4000, 4711);
    const dir = makeTempDir("range");

    for (const step of [890, 48, 20]) {
      const frames = await renderFrames({
        page,
        outDir: path.join(dir, `step_${step}`),
        frameHeight: FRAME_H,
        frames: [{ position: 0 }, { position: step }],
        jpegQuality: 80,
      });
      const expected = FRAME_H - step; // 70px (7%), 912px (95%), 940px (98%)
      const m = await measureOverlap(frames[0], frames[1]);
      assert.ok(
        m.matched,
        `overlap of ${expected}px (${Math.round((expected / FRAME_H) * 100)}%) was not detected (best NCC ${m.ncc.toFixed(3)})`
      );
      assert.ok(
        Math.abs(m.overlapPx - expected) <= 8,
        `measured ${m.overlapPx}px, expected ≈${expected}px`
      );
    }
  });

  test("small overlaps must clear a stricter confidence bar", async () => {
    // Few compared rows make a chance alignment cheap, so the threshold rises
    // as the overlap shrinks. Unrelated pages must not match at a tiny offset.
    const dir = makeTempDir("smallconf");
    const pageA = generatePage(WIDTH, 2000, 100);
    const pageB = generatePage(WIDTH, 2000, 200);
    const a = await renderFrames({
      page: pageA,
      outDir: path.join(dir, "a"),
      frameHeight: FRAME_H,
      frames: [{ position: 0 }],
      jpegQuality: 80,
    });
    const b = await renderFrames({
      page: pageB,
      outDir: path.join(dir, "b"),
      frameHeight: FRAME_H,
      frames: [{ position: 900 }],
      jpegQuality: 80,
    });

    const m = await measureOverlap(a[0], b[0]);
    assert.equal(m.matched, false, `unrelated frames matched at ${m.overlapPx}px`);

    // The bar rises as the overlap shrinks, and never below the base
    const base = 0.85;
    assert.equal(nccThresholdFor(base, 500, 1000), base, "half a frame uses the base threshold");
    assert.equal(nccThresholdFor(base, 250, 1000), base, "25% is the edge of the ramp");
    assert.ok(
      nccThresholdFor(base, 100, 1000) > base,
      "10% overlap must demand more than the base"
    );
    assert.ok(
      nccThresholdFor(base, 40, 1000) > nccThresholdFor(base, 100, 1000),
      "the requirement keeps rising as the overlap shrinks"
    );
    assert.ok(nccThresholdFor(base, 10, 1000) <= 0.98, "the requirement stays attainable");
  });

  test("a fast flick with only a sliver of overlap still stitches", async () => {
    const step = 845; // overlap 115px ≈ 12% of the frame
    const positions = [0, 845, 1690, 2535, 3380];
    const pageH = 3380 + FRAME_H;
    const page = generatePage(WIDTH, pageH, 8899);
    const frames = await renderFrames({
      page,
      outDir: makeTempDir("sliver"),
      frameHeight: FRAME_H,
      frames: positions.map((position) => ({ position })),
      jpegQuality: 80,
    });

    const run = await runPipeline(frames);
    assert.equal(run.selection.gapCount, 0, "a sliver of overlap is still an overlap");
    assert.ok(
      Math.abs(run.stitch.height - pageH) <= 25,
      `stitched height ${run.stitch.height} should be ≈${pageH}`
    );

    const stitched = await greyFromFile(run.outputPath);
    const pageGrey = await greyFromPage(page);
    for (const y of [400, 2000, 3800]) {
      const { bestY, bestNcc } = locateStrip(stitched, pageGrey, y);
      assert.ok(bestNcc >= 0.8, `strip at ${y}: NCC ${bestNcc.toFixed(3)} too low`);
      assert.ok(Math.abs(bestY - y) <= 30, `strip at ${y} found at ${bestY}`);
    }
  });

  test("a status bar with a live clock (undetectable sticky) still stitches", async () => {
    // The header changes every frame, so sticky detection cannot remove it —
    // the guard band in the overlap comparison must absorb it instead.
    const headerH = 64;
    const contentH = FRAME_H - headerH; // 896
    const step = 480; // overlap 480px = 50% of frame height — inside the keep window
    const positions = [0, 480, 960, 1440, 1920, 2400];
    const pageH = 2400 + contentH;
    const page = generatePage(WIDTH, pageH, 5150);

    const frames = await renderFrames({
      page,
      outDir: makeTempDir("statusbar"),
      frameHeight: FRAME_H,
      frames: positions.map((position) => ({ position })),
      headerHeight: headerH,
      dynamicHeader: true,
      jpegQuality: 80,
    });

    const run = await runPipeline(frames);

    assert.equal(
      run.selection.gapCount,
      0,
      "dynamic status bar must not break overlap detection"
    );
    // Every seam: overlap = frameH − step (header included in the geometry)
    for (const seam of run.selection.seams.slice(1)) {
      assert.equal(seam.type, "overlap");
      assert.ok(
        Math.abs(seam.overlapPx - (FRAME_H - step)) <= 10,
        `seam overlap ${seam.overlapPx}px should be ≈${FRAME_H - step}px`
      );
    }
    // Height = one header + the covered page span
    const expected = headerH + 2400 + contentH;
    assert.ok(
      Math.abs(run.stitch.height - expected) <= 30,
      `stitched height ${run.stitch.height} should be ≈${expected}`
    );

    // Content strips land at pageY + headerH — and mid-overlap seam cutting
    // must keep the per-frame header chrome out of the middle of the output
    const stitched = await greyFromFile(run.outputPath);
    const pageGrey = await greyFromPage(page);
    for (const y of [500, 1600, 3000]) {
      const { bestY, bestNcc } = locateStrip(stitched, pageGrey, y);
      assert.ok(bestNcc >= 0.75, `strip at ${y}: best NCC ${bestNcc.toFixed(3)} too low`);
      assert.ok(
        Math.abs(bestY - (y + headerH)) <= 45,
        `strip at ${y} found at ${bestY}, expected ≈${y + headerH}`
      );
    }
  });

  test("blank (all-black) decoder-glitch frames are skipped with a warning", async () => {
    const pageH = 3840;
    const page = generatePage(WIDTH, pageH, 6161);
    const positions = [0, 576, 1152, 1728, 2304, 2880];
    const dir = makeTempDir("blank-mixed");
    const frames = await renderFrames({
      page,
      outDir: dir,
      frameHeight: FRAME_H,
      frames: positions.map((position) => ({ position })),
      jpegQuality: 80,
    });

    const blankPath = path.join(dir, "frame_black.jpg");
    await sharp({
      create: { width: WIDTH, height: FRAME_H, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg({ quality: 80 })
      .toFile(blankPath);
    const withBlank = [...frames.slice(0, 3), blankPath, ...frames.slice(3)];

    const run = await runPipeline(withBlank);
    assert.equal(run.validationWarnings.length, 1);
    assert.match(run.validationWarnings[0], /blank/);
    // The remaining frames stitch as if the glitch frame never existed
    assert.equal(run.selection.gapCount, 0);
    assert.ok(
      Math.abs(run.stitch.height - pageH) <= 25,
      `stitched height ${run.stitch.height} should be ≈${pageH}`
    );
  });

  test("a scroll faster than the frame rate yields a leading 'too fast' warning", async () => {
    const frameH = FRAME_H;
    const positions = [0, 1200, 2400, 3600, 4800]; // every step > frame height
    const pageH = 4800 + frameH;
    const page = generatePage(WIDTH, pageH, 7272);
    const frames = await renderFrames({
      page,
      outDir: makeTempDir("flick"),
      frameHeight: frameH,
      frames: positions.map((position) => ({ position })),
      jpegQuality: 80,
    });

    const run = await runPipeline(frames);
    assert.equal(run.selection.gapCount, 4);
    assert.match(
      run.selection.warnings[0],
      /too fast/i,
      "gap-majority runs should lead with actionable guidance"
    );
  });

  test("very tall outputs get a downscaled preview image", async () => {
    const dir = makeTempDir("preview");
    const srcPath = path.join(dir, "tall.png");
    const page = generatePage(400, 6000, 88); // 2.4MP source
    await sharp(page.data, { raw: { width: 400, height: 6000, channels: 3 } })
      .png()
      .toFile(srcPath);

    // Over budget → scaled JPEG
    const scaledPath = path.join(dir, "preview.jpg");
    const scaled = await generatePreviewImage(srcPath, scaledPath, 600_000);
    assert.equal(scaled.scaled, true);
    assert.ok(scaled.width * scaled.height <= 620_000, "preview must respect the pixel budget");
    const meta = await sharp(scaledPath).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, scaled.width);

    // Under budget → untouched
    const small = await generatePreviewImage(srcPath, path.join(dir, "unused.jpg"), 10_000_000);
    assert.equal(small.scaled, false);
    assert.equal(small.width, 400);
  });

  test("a fully corrupt upload fails with a clear error", async () => {
    const dir = makeTempDir("corrupt-all");
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = path.join(dir, `bad_${i}.jpg`);
      fs.writeFileSync(p, Buffer.from(`garbage ${i}`));
      paths.push(p);
    }

    await assert.rejects(
      () => runPipeline(paths),
      /could(?: not)? be read as images/
    );
  });
});
