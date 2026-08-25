import { test } from "node:test";
import assert from "node:assert/strict";

import { readableProcessingError } from "../processingErrors";

// The push notification that prompted this reached a lock screen reading:
//   Stitching failed: Input file is missing:
//   /tmp/scrollstitch-sessions/mt8xbwlmss701niv/00000_00025

const SHARP_MISSING =
  "Input file is missing: /tmp/scrollstitch-sessions/mt8xbwlmss701niv/00000_00025";

test("the message that shipped to a lock screen", () => {
  const actual = readableProcessingError(new Error(SHARP_MISSING));
  assert.match(actual, /frames were no longer available/i);
  // None of our internals belong on someone's phone.
  assert.equal(/tmp/.test(actual), false);
  assert.equal(/mt8xbwlmss701niv/.test(actual), false);
  assert.equal(/00025/.test(actual), false);
});

test("does not depend on the path in the message", () => {
  // Sharp appends whatever path it was handed; only the prefix is stable.
  for (const path of ["/tmp/a/00000_00001", "C:\\x\\y", "", "/var/folders/zz/frame"]) {
    assert.match(
      readableProcessingError(new Error(`Input file is missing: ${path}`)),
      /no longer available/i
    );
  }
});

test("translates an undecodable frame separately", () => {
  // A different cause deserves different words: the file was there and was not
  // an image, which is not the same as it having vanished.
  const actual = readableProcessingError(
    new Error("Input buffer contains unsupported image format")
  );
  assert.match(actual, /could not be read/i);
  assert.equal(/no longer available/i.test(actual), false);
});

test("translates a full disk", () => {
  assert.match(
    readableProcessingError(new Error("ENOSPC: no space left on device, write")),
    /ran out of space/i
  );
});

test("passes our own messages through", () => {
  // Errors this codebase raises are already written for the reader.
  const ours = "Could not extract any frames from the video";
  assert.equal(readableProcessingError(new Error(ours)), ours);
});

test("never renders empty or as [object Object]", () => {
  const fallback = "Processing failed unexpectedly.";
  assert.equal(readableProcessingError(new Error("")), fallback);
  assert.equal(readableProcessingError(new Error("   ")), fallback);
  assert.equal(readableProcessingError(undefined), fallback);
  assert.equal(readableProcessingError(null), fallback);
  // The one that got past the first version of this check elsewhere.
  assert.equal(readableProcessingError({}), fallback);
  assert.equal(readableProcessingError({ message: "x" }), fallback);
});

test("accepts a thrown string", () => {
  assert.match(readableProcessingError("Input file is missing: /x"), /no longer available/i);
  assert.equal(readableProcessingError("plain failure"), "plain failure");
});

test("is case insensitive", () => {
  assert.match(readableProcessingError(new Error("INPUT FILE IS MISSING: /x")), /no longer available/i);
});
