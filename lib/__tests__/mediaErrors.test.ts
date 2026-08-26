import { test } from "node:test";
import assert from "node:assert/strict";

import { readableMediaError, technicalErrorCode } from "../mediaErrors";

// The string this replaces reached a paying user on the App Store build:
// "The operation couldn't be completed. (PHPhotosErrorDomain error 3164.)"

const PHOTO_LIBRARY = /photo library/i;

test("translates the error that shipped", () => {
  const actual = readableMediaError(
    new Error("The operation couldn't be completed. (PHPhotosErrorDomain error 3164.)")
  );
  assert.match(actual, PHOTO_LIBRARY);
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
    assert.match(msg, PHOTO_LIBRARY, `code ${code} should still be translated`);
  }
});

test("is case insensitive about the domain", () => {
  assert.match(readableMediaError(new Error("phphotoserrordomain error 1")), PHOTO_LIBRARY);
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
  assert.match(readableMediaError("PHPhotosErrorDomain error 3164"), PHOTO_LIBRARY);
  assert.equal(readableMediaError("plain failure"), "plain failure");
});

// The friendly sentence drops Apple's domain and number on purpose. Losing them
// entirely cost a build cycle: the screenshot that could have named the failure
// no longer carried the thing that names it. They belong on the code line.

test("extracts the identifier that was being hidden", () => {
  assert.equal(
    technicalErrorCode(
      new Error("The operation couldn't be completed. (PHPhotosErrorDomain error 3164.)")
    ),
    "PHPhotos-3164"
  );
});

test("works for any Apple error domain", () => {
  assert.equal(
    technicalErrorCode(new Error("(AVFoundationErrorDomain error -11800.)")),
    "AVFoundation--11800"
  );
  assert.equal(
    technicalErrorCode(new Error("(NSCocoaErrorDomain error 260.)")),
    "NSCocoa-260"
  );
});

test("falls back to a code property", () => {
  const err = Object.assign(new Error("network down"), { code: "ERR_NETWORK" });
  assert.equal(technicalErrorCode(err), "ERR_NETWORK");
});

test("returns empty when there is nothing technical to show", () => {
  // The code line is hidden when this is empty, so it must not invent one.
  assert.equal(technicalErrorCode(new Error("Upload failed")), "");
  assert.equal(technicalErrorCode(undefined), "");
  assert.equal(technicalErrorCode(null), "");
  assert.equal(technicalErrorCode({}), "");
});

test("the message no longer asserts iCloud as the cause", () => {
  // It shipped saying the recording was in iCloud, and appeared for one sitting
  // on the device that played instantly. It may mention iCloud as a
  // possibility; it must not state it as the diagnosis.
  const msg = readableMediaError(new Error("PHPhotosErrorDomain error 3164"));
  assert.match(msg, PHOTO_LIBRARY);
  assert.equal(/It may still be in iCloud rather than on this device/.test(msg), false);
});
