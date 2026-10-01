import { test } from "node:test";
import assert from "node:assert/strict";

import { HttpError, httpErrorMessage, isRetryableStatus } from "../httpErrors";
import { readableMediaError, technicalErrorCode } from "../mediaErrors";

test("uses the server's own sentence from a JSON error body", () => {
  assert.equal(
    httpErrorMessage(400, '{"error":"Not enough distinct frames to stitch."}'),
    "Not enough distinct frames to stitch."
  );
});

test("never shows braces and quotes on screen", () => {
  const shown = httpErrorMessage(500, '{"error":""}');
  assert.ok(!shown.includes("{") && !shown.includes('"'), shown);
});

test("accepts a `message` field as well as `error`", () => {
  assert.equal(httpErrorMessage(502, '{"message":"Upstream timed out"}'), "Upstream timed out");
});

test("replaces a proxy's HTML page with a plain sentence", () => {
  const html = "<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>";
  assert.equal(httpErrorMessage(502, html), "The server ran into a problem. Please try again.");
});

test("passes a short plain-text reason through", () => {
  assert.equal(httpErrorMessage(500, "disk full"), "disk full");
});

test("explains the statuses a person can act on", () => {
  assert.match(httpErrorMessage(413, ""), /too large/);
  assert.match(httpErrorMessage(429, ""), /busy/);
  assert.match(httpErrorMessage(404, null), /HTTP 404/);
});

test("drops a plain-text body too long to be a sentence", () => {
  assert.equal(httpErrorMessage(503, "x".repeat(500)), "The server ran into a problem. Please try again.");
});

test("retries only what a second attempt could fix", () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) assert.equal(isRetryableStatus(s), true, String(s));
  for (const s of [400, 401, 403, 404, 413, 422]) assert.equal(isRetryableStatus(s), false, String(s));
});

test("an HttpError reads cleanly on the error screen and carries its status code", () => {
  const err = new HttpError(413, httpErrorMessage(413, ""));
  assert.equal(readableMediaError(err), "This recording is too large to upload. Try a shorter one.");
  assert.equal(technicalErrorCode(err), "HTTP-413");
});
