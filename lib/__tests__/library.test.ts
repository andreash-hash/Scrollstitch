import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pruneRecords,
  libraryBytes,
  formatBytes,
  MAX_STITCHES,
  type StitchRecord,
} from "../library-retention";

const MB = 1024 * 1024;

function record(overrides: Partial<StitchRecord> & { id: string }): StitchRecord {
  return {
    createdAt: 0,
    imageFile: `${overrides.id}.png`,
    previewFile: null,
    width: 1170,
    height: 12000,
    bytes: 10 * MB,
    frameCount: 40,
    selectedFrames: 20,
    gapCount: 0,
    warnings: [],
    ...overrides,
  };
}

/** `count` stitches, one per day, oldest first. */
function series(count: number, bytes = 10 * MB): StitchRecord[] {
  return Array.from({ length: count }, (_, i) =>
    record({ id: `s${i}`, createdAt: (i + 1) * 86_400_000, bytes })
  );
}

describe("stitch library retention", () => {
  test("keeps everything while under both limits", () => {
    const { keep, drop } = pruneRecords(series(5));
    assert.equal(keep.length, 5);
    assert.deepEqual(drop, []);
  });

  test("returns newest first regardless of input order", () => {
    const shuffled = [...series(5)].reverse();
    const { keep } = pruneRecords(shuffled);
    assert.deepEqual(
      keep.map((r) => r.id),
      ["s4", "s3", "s2", "s1", "s0"]
    );
  });

  test("drops the oldest once the count limit is passed", () => {
    const { keep, drop } = pruneRecords(series(MAX_STITCHES + 3), MAX_STITCHES, 10_000 * MB);
    assert.equal(keep.length, MAX_STITCHES);
    assert.deepEqual(
      drop.map((r) => r.id),
      ["s2", "s1", "s0"],
      "the three oldest go, and only those"
    );
  });

  test("drops the oldest once the byte budget is passed", () => {
    // Ten 30 MB stitches against a 100 MB budget: three fit.
    const { keep, drop } = pruneRecords(series(10, 30 * MB), 100, 100 * MB);
    assert.equal(keep.length, 3);
    assert.ok(libraryBytes(keep) <= 100 * MB);
    assert.equal(drop.length, 7);
    assert.ok(
      keep.every((k) => drop.every((d) => d.createdAt < k.createdAt)),
      "everything kept must be newer than everything dropped"
    );
  });

  test("keeps the newest stitch even when it alone exceeds the budget", () => {
    // Otherwise finishing a very long stitch would delete it on arrival — the
    // user would watch it complete and then find an empty library.
    const huge = record({ id: "huge", createdAt: 5_000, bytes: 900 * MB });
    const older = record({ id: "older", createdAt: 1_000, bytes: 5 * MB });
    const { keep, drop } = pruneRecords([older, huge], 100, 500 * MB);
    assert.deepEqual(keep.map((r) => r.id), ["huge"]);
    assert.deepEqual(drop.map((r) => r.id), ["older"]);
  });

  test("a record with no measured size is not treated as free", () => {
    // getInfoAsync can come back without a size; such a record must still be
    // counted against the limit somewhere, so the count cap is what holds.
    const { keep } = pruneRecords(series(MAX_STITCHES + 5, 0), MAX_STITCHES, 500 * MB);
    assert.equal(keep.length, MAX_STITCHES);
  });

  test("handles an empty library", () => {
    assert.deepEqual(pruneRecords([]), { keep: [], drop: [] });
    assert.equal(libraryBytes([]), 0);
  });

  test("formats sizes the way the library screen shows them", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(2048), "2 KB");
    assert.equal(formatBytes(3.5 * MB), "3.5 MB");
    assert.equal(formatBytes(120 * MB), "120 MB");
    assert.equal(formatBytes(2.5 * 1024 * MB), "2.5 GB");
  });
});
