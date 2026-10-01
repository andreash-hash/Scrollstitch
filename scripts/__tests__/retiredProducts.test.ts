import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RETIRED_SUFFIX,
  isRetiredIdentifier,
  retiredDisplayName,
} from "../retiredProducts";

// This check decides which RevenueCat products get deleted. Every identifier
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
  // Burnt in App Store Connect by being created as in-app purchases rather
  // than auto-renewable subscriptions, in both store spellings
  "scrollstitch_pro_annual",
  "scrollstitch_pro_annual:annual",
  "scrollstitch_pro_weekly",
  "scrollstitch_pro_weekly:weekly",
];

const KEEP = [
  "scrollstitch_pro_weekly_v2",
  "scrollstitch_pro_weekly_v2:weekly",
  "scrollstitch_pro_yearly",
  "scrollstitch_pro_yearly:yearly",
  "scrollstitch_pro_lifetime",
];

test("retires the old app name and every burnt identifier", () => {
  for (const id of RETIRE) {
    assert.equal(isRetiredIdentifier(id), true, `${id} should be retired`);
  }
});

test("keeps every live product", () => {
  for (const id of KEEP) {
    assert.equal(isRetiredIdentifier(id), false, `${id} must NOT be deleted`);
  }
});

test("the replacement weekly is not caught by the retired weekly", () => {
  // The reason this check is an exact match and not a prefix regex. The live
  // weekly plan is the retired one plus a suffix, so /^scrollstitch_pro_weekly/
  // matches both — the seed would create the weekly product and delete it in
  // the same run, taking out the plan the free trial funnels into.
  assert.equal(isRetiredIdentifier("scrollstitch_pro_weekly"), true);
  assert.equal(isRetiredIdentifier("scrollstitch_pro_weekly_v2"), false);
  // Same shape, stated as the prefix relationship itself.
  assert.equal("scrollstitch_pro_weekly_v2".startsWith("scrollstitch_pro_weekly"), true);
});

test("yearly is not caught by the annual it replaced", () => {
  assert.equal(isRetiredIdentifier("scrollstitch_pro_annual"), true);
  assert.equal(isRetiredIdentifier("scrollstitch_pro_yearly"), false);
});

test("matches the whole identifier, not a fragment of it", () => {
  assert.equal(isRetiredIdentifier("com.scrollstitch_pro_annual"), false);
  assert.equal(isRetiredIdentifier("legacy_scrollsnap_pro_annual"), false);
  assert.equal(isRetiredIdentifier("scrollstitch_pro_annual_backup"), false);
  assert.equal(isRetiredIdentifier("scrollstitch_pro_lifetime"), false);
});

test("catches both spellings of a Play subscription", () => {
  // Play writes a subscription as productId:basePlanId. The suffix must not
  // let a retired product slip through as live.
  assert.equal(isRetiredIdentifier("scrollstitch_pro_weekly:weekly"), true);
  assert.equal(isRetiredIdentifier("scrollstitch_pro_annual:annual"), true);
  assert.equal(isRetiredIdentifier("scrollsnap_pro_annual:annual"), true);
});

test("is case insensitive", () => {
  assert.equal(isRetiredIdentifier("ScrollSnap_Pro_Annual"), true);
  assert.equal(isRetiredIdentifier("SCROLLSTITCH_PRO_ANNUAL"), true);
  assert.equal(isRetiredIdentifier("ScrollStitch_Pro_Weekly"), true);
});

test("treats a missing identifier as live", () => {
  // A product the API returned without a store_identifier is not evidence that
  // it is retired, and this check is a delete list.
  assert.equal(isRetiredIdentifier(undefined), false);
  assert.equal(isRetiredIdentifier(null), false);
  assert.equal(isRetiredIdentifier(""), false);
  assert.equal(isRetiredIdentifier(":weekly"), false);
});

test("repeated calls agree", () => {
  for (let i = 0; i < 5; i++) {
    assert.equal(isRetiredIdentifier("scrollstitch_pro_weekly"), true);
    assert.equal(isRetiredIdentifier("scrollstitch_pro_weekly_v2"), false);
  }
});

test("moves a retired display name aside", () => {
  assert.equal(
    retiredDisplayName("ScrollStitch Pro Weekly", "scrollstitch_pro_weekly"),
    "ScrollStitch Pro Weekly (retired)"
  );
});

test("renaming is idempotent", () => {
  // The seed is run repeatedly. A product that cannot be deleted is renamed on
  // every run, and must not accumulate suffixes.
  const once = retiredDisplayName("ScrollStitch Pro Weekly", "x");
  const twice = retiredDisplayName(once, "x");
  assert.equal(twice, once);
  assert.equal(twice.endsWith(RETIRED_SUFFIX + RETIRED_SUFFIX), false);
});

test("falls back to the store identifier when there is no display name", () => {
  assert.equal(
    retiredDisplayName(undefined, "scrollstitch_pro_weekly"),
    "scrollstitch_pro_weekly (retired)"
  );
  assert.equal(
    retiredDisplayName("   ", "scrollstitch_pro_weekly"),
    "scrollstitch_pro_weekly (retired)"
  );
});
