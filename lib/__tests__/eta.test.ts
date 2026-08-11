import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  initialTotalMs,
  reviseTotalMs,
  nextShownMs,
  allowedDropMs,
  formatEta,
  ETA_PRIOR_MS_PER_FRAME,
} from "../eta";

/**
 * Replay a job the way the client experiences it: progress samples paired with
 * the wall-clock time at which they arrive.
 *
 * The shape that matters is the one from the bug report — the bar sprints
 * through extraction and upload, then the server's overlap search takes most of
 * the actual time.
 */
function replay(
  samples: { atMs: number; progress: number }[],
  estimatedFrames: number,
  tickMs = 500
): { atMs: number; shownMs: number }[] {
  const prior = initialTotalMs(estimatedFrames);
  let total = prior;
  let shown: number | null = null;
  const out: { atMs: number; shownMs: number }[] = [];
  const endMs = samples[samples.length - 1].atMs;
  let lastProgress = -1;

  for (let t = 0; t <= endMs; t += tickMs) {
    // Latest progress reported at or before now.
    let progress = 0;
    for (const s of samples) if (s.atMs <= t) progress = s.progress;
    if (progress > 0.02 && progress < 0.99) {
      total = reviseTotalMs(total, t, progress, prior);
    }
    const advanced = progress > lastProgress;
    lastProgress = progress;
    shown = nextShownMs(shown, total - t, allowedDropMs(tickMs, advanced));
    out.push({ atMs: t, shownMs: shown });
  }
  return out;
}

/** The reported trace: 25s of client work, then ~82s of server work. */
const REAL_RUN = [
  { atMs: 0, progress: 0 },
  { atMs: 6_000, progress: 0.18 },
  { atMs: 14_000, progress: 0.28 },
  { atMs: 25_000, progress: 0.34 },
  { atMs: 45_000, progress: 0.48 },
  { atMs: 70_000, progress: 0.66 },
  { atMs: 95_000, progress: 0.85 },
  { atMs: 107_000, progress: 1 },
];
const REAL_FRAMES = 300;

describe("time remaining", () => {
  test("never increases once it has been shown", () => {
    const series = replay(REAL_RUN, REAL_FRAMES);
    for (let i = 1; i < series.length; i++) {
      assert.ok(
        series[i].shownMs <= series[i - 1].shownMs + 1e-9,
        `estimate rose at ${series[i].atMs}ms: ` +
          `${series[i - 1].shownMs.toFixed(0)} -> ${series[i].shownMs.toFixed(0)}`
      );
    }
  });

  test("the first estimate is not wildly short of the real duration", () => {
    const series = replay(REAL_RUN, REAL_FRAMES);
    const firstShownTotal = series[0].shownMs; // at t=0, shown == total
    const actual = 107_000;
    // The old model's opening bid was ~52s against a 107s job. Anything that
    // undershoots by that much is the bug, not an estimate.
    assert.ok(
      firstShownTotal >= actual * 0.8,
      `opened at ${(firstShownTotal / 1000).toFixed(0)}s for a ${actual / 1000}s job`
    );
  });

  test("keeps counting down while progress is flat", () => {
    // The server goes quiet between 70s and 95s; the number must keep moving.
    const series = replay(REAL_RUN, REAL_FRAMES);
    const at72 = series.find((s) => s.atMs === 72_000)!;
    const at90 = series.find((s) => s.atMs === 90_000)!;
    assert.ok(
      at90.shownMs < at72.shownMs,
      "estimate froze while the server reported no progress"
    );
  });

  test("converges towards zero by the time the job ends", () => {
    const series = replay(REAL_RUN, REAL_FRAMES);
    const last = series[series.length - 1];
    assert.ok(
      last.shownMs < 25_000,
      `still claiming ${(last.shownMs / 1000).toFixed(0)}s remaining at the end`
    );
  });

  test("a job that runs long lands on zero rather than going negative", () => {
    const overrun = [
      { atMs: 0, progress: 0 },
      { atMs: 10_000, progress: 0.3 },
      { atMs: 200_000, progress: 0.95 },
    ];
    const series = replay(overrun, 60);
    for (const s of series) assert.ok(s.shownMs >= 0, "estimate went negative");
    assert.equal(series[series.length - 1].shownMs, 0);
  });

  test("the naive model is the thing being fixed", () => {
    // Guards the premise: plain elapsed/progress really does open far too low
    // on this trace, so the extra machinery is earning its place.
    const naiveAt = (t: number) => {
      let progress = 0;
      for (const s of REAL_RUN) if (s.atMs <= t) progress = s.progress;
      return progress > 0 ? t / progress - t : Infinity;
    };
    assert.ok(
      naiveAt(6_000) < 60_000,
      "expected the naive model to open under a minute on a 107s job"
    );
    const series = replay(REAL_RUN, REAL_FRAMES);
    const oursAt6s = series.find((s) => s.atMs === 6_000)!.shownMs;
    assert.ok(
      oursAt6s > naiveAt(6_000),
      "the new model should be more conservative early than the naive one"
    );
  });

  test("short jobs still get a sensible floor", () => {
    assert.equal(initialTotalMs(1), 8000);
    assert.equal(initialTotalMs(100), 100 * ETA_PRIOR_MS_PER_FRAME);
  });

  test("formats in coarse steps so the digits do not flicker", () => {
    assert.equal(formatEta(1_000), "~5s remaining");
    assert.equal(formatEta(12_400), "~15s remaining");
    assert.equal(formatEta(60_000), "~1m remaining");
    assert.equal(formatEta(95_000), "~1m 40s remaining");
    // Coarse means stable: nearby values collapse to the same label.
    assert.equal(formatEta(41_000), formatEta(43_000));
  });
});
