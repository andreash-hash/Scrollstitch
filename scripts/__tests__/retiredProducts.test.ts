import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RETIRED_SUFFIX,
  isRetiredIdentifier,
  retiredDisplayName,
} from "../retiredProducts";

// This pattern decides which RevenueCat products get deleted. Every identifier
// the project has ever put in front of it is listed here explicitly, split into
// the ones that must go and the ones that must survive, because the cost of the
// two mistakes is not symmetric: keeping a dead product leaves clutter in a
// dashboard, deleting a live one takes a plan out of the paywall.

const RETIRE = [
  // The previous app name
  "scrollsnap_pro_monthly",
  "scrollsnap_pro_annual",
  "scrollsnap_pro_weekly",
  "scrollsnap_pro_weekly:weekly",
  // The spent annual identifier, in all three store forms it exists in
  "scrollstitch_pro_annual",
  "scrollstitch_pro_annual:annual",
];

const KEEP = [
  "scrollstitch_pro_weekly",
  "scrollstitch_pro_weekly:weekly",
  "scrollstitch_pro_yearly",
  "scrollstitch_pro_yearly:yearly",
  "scrollstitch_pro_lifetime",
];

test("retires the old app name and the spent annual identifier", () => {
  for (const id of RETIRE) {
    assert.equal(isRetiredIdentifier(id), true, `${id} should be retired`);
  }
});

test("keeps every live product", () => {
  for (const id of KEEP) {
    assert.equal(isRetiredIdentifier(id), false, `${id} must NOT be deleted`);
  }
});

test("yearly is not caught by the annual pattern", () => {
  // The whole point of the move: these two differ by one word, and the pattern
  // has to separate them. If this ever fails, the live annual plan is deleted
  // on the next seed run.
  assert.equal(isRetiredIdentifier("scrollstitch_pro_annual"), true);
  assert.equal(isRetiredIdentifier("scrollstitch_pro_yearly"), false);
});

test("matches only at the start of the identifier", () => {
  // An unanchored pattern would be the same string with a much wider reach.
  assert.equal(isRetiredIdentifier("com.scrollstitch_pro_annual"), false);
  assert.equal(isRetiredIdentifier("legacy_scrollsnap_pro_annual"), false);
});

test("is case insensitive", () => {
  assert.equal(isRetiredIdentifier("ScrollSnap_Pro_Annual"), true);
  assert.equal(isRetiredIdentifier("SCROLLSTITCH_PRO_ANNUAL"), true);
});

test("treats a missing identifier as live", () => {
  // A product the API returned without a store_identifier is not evidence that
  // it is retired, and this pattern is a delete list.
  assert.equal(isRetiredIdentifier(undefined), false);
  assert.equal(isRetiredIdentifier(null), false);
  assert.equal(isRetiredIdentifier(""), false);
});

test("repeated calls agree", () => {
  // A regex literal carrying /g would advance lastIndex between calls and start
  // answering differently for the same input. This pattern is reused across
  // every product in the project, twice per run.
  for (let i = 0; i < 5; i++) {
    assert.equal(isRetiredIdentifier("scrollstitch_pro_annual"), true);
    assert.equal(isRetiredIdentifier("scrollstitch_pro_yearly"), false);
  }
});

test("moves a retired display name aside", () => {
  assert.equal(
    retiredDisplayName("ScrollStitch Pro Annual", "scrollstitch_pro_annual"),
    "ScrollStitch Pro Annual (retired)"
  );
});

test("renaming is idempotent", () => {
  // The seed is run repeatedly. A product that cannot be deleted is renamed on
  // every run, and must not accumulate suffixes.
  const once = retiredDisplayName("ScrollStitch Pro Annual", "x");
  const twice = retiredDisplayName(once, "x");
  assert.equal(twice, once);
  assert.equal(twice.endsWith(RETIRED_SUFFIX + RETIRED_SUFFIX), false);
});

test("falls back to the store identifier when there is no display name", () => {
  assert.equal(
    retiredDisplayName(undefined, "scrollstitch_pro_annual"),
    "scrollstitch_pro_annual (retired)"
  );
  assert.equal(
    retiredDisplayName("   ", "scrollstitch_pro_annual"),
    "scrollstitch_pro_annual (retired)"
  );
});
