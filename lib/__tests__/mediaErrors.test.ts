import { test } from "node:test";
import assert from "node:assert/strict";

import { readableMediaError } from "../mediaErrors";

// The string this replaces reached a paying user on the App Store build:
// "The operation couldn't be completed. (PHPhotosErrorDomain error 3164.)"

const ICLOUD = /iCloud/;

test("translates the error that shipped", () => {
  const actual = readableMediaError(
    new Error("The operation couldn't be completed. (PHPhotosErrorDomain error 3164.)")
  );
  assert.match(actual, ICLOUD);
  assert.equal(/PHPhotosErrorDomain/.test(actual), false);
  assert.equal(/3164/.test(actual), false);
});

test("matches the domain, not the code", () => {
  // Apple does not document most of these numbers and they vary by cause, so
  // the code must not be part of the match.
  for (const code of [3164, 3072, 3311, 0]) {
    const msg = readableMediaError(
      new Error(`The operation couldn't be completed. (PHPhotosErrorDomain error ${code}.)`)
    );
    assert.match(msg, ICLOUD, `code ${code} should still be translated`);
  }
});

test("is case insensitive about the domain", () => {
  assert.match(readableMediaError(new Error("phphotoserrordomain error 1")), ICLOUD);
});

test("passes other messages through unchanged", () => {
  // A message written for this app is already the right thing to show.
  assert.equal(
    readableMediaError(new Error("Upload failed: network unreachable")),
    "Upload failed: network unreachable"
  );
});

test("never renders as empty or as [object Object]", () => {
  // Whatever arrives here is going straight onto the error screen.
  const fallback = "Failed to process video";
  assert.equal(readableMediaError(new Error("")), fallback);
  assert.equal(readableMediaError(new Error("   ")), fallback);
  assert.equal(readableMediaError(undefined), fallback);
  assert.equal(readableMediaError(null), fallback);
  assert.equal(readableMediaError({}), fallback);
  assert.equal(readableMediaError({ message: undefined }), fallback);
});

test("accepts a thrown string", () => {
  // Not everything that reaches a catch block is an Error.
  assert.match(readableMediaError("PHPhotosErrorDomain error 3164"), ICLOUD);
  assert.equal(readableMediaError("plain failure"), "plain failure");
});
