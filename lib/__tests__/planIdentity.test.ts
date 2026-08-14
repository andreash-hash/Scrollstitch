import { test } from "node:test";
import assert from "node:assert/strict";

import { baseProductId, isSamePlan } from "../planIdentity";

// The check this replaces asked whether the active product id contained
// "annual". It answered correctly right up until the annual plan was renamed to
// scrollstitch_pro_yearly, at which point it began telling every annual
// subscriber they were not on the annual plan — and the app offered to sell
// them the plan they were already paying for.

test("the identifiers that broke the substring check", () => {
  // The whole regression, in one assertion: same plan, no shared "annual".
  assert.equal(
    isSamePlan("scrollstitch_pro_yearly", "scrollstitch_pro_yearly"),
    true
  );
  assert.equal("scrollstitch_pro_yearly".includes("annual"), false);
});

test("matches across Play's base-plan suffix", () => {
  // Play reports the same purchase with and without the suffix depending on
  // where it is read from.
  assert.equal(
    isSamePlan("scrollstitch_pro_yearly", "scrollstitch_pro_yearly:yearly"),
    true
  );
  assert.equal(
    isSamePlan("scrollstitch_pro_yearly:yearly", "scrollstitch_pro_yearly"),
    true
  );
  assert.equal(
    isSamePlan("scrollstitch_pro_weekly:weekly", "scrollstitch_pro_weekly:weekly"),
    true
  );
});

test("does not confuse one plan for another", () => {
  assert.equal(
    isSamePlan("scrollstitch_pro_weekly", "scrollstitch_pro_yearly"),
    false
  );
  assert.equal(
    isSamePlan("scrollstitch_pro_weekly:weekly", "scrollstitch_pro_yearly:yearly"),
    false
  );
  assert.equal(
    isSamePlan("scrollstitch_pro_lifetime", "scrollstitch_pro_yearly"),
    false
  );
});

test("a weekly subscriber is not on the annual plan", () => {
  // The case the win-back offer exists for: this must stay false, or the offer
  // never appears for anyone.
  assert.equal(
    isSamePlan("scrollstitch_pro_weekly", "scrollstitch_pro_yearly"),
    false
  );
  assert.equal(
    isSamePlan("scrollstitch_pro_weekly", "scrollstitch_pro_lifetime"),
    false
  );
});

test("an unknown plan is never a match", () => {
  // Not knowing what someone is on is not evidence that they are on this plan.
  assert.equal(isSamePlan(null, "scrollstitch_pro_yearly"), false);
  assert.equal(isSamePlan(undefined, "scrollstitch_pro_yearly"), false);
  assert.equal(isSamePlan("scrollstitch_pro_yearly", null), false);
  assert.equal(isSamePlan(null, null), false);
  assert.equal(isSamePlan("", ""), false);
  // A bare suffix is not an identifier either.
  assert.equal(isSamePlan(":yearly", ":yearly"), false);
});

test("baseProductId strips only the suffix", () => {
  assert.equal(baseProductId("scrollstitch_pro_yearly:yearly"), "scrollstitch_pro_yearly");
  assert.equal(baseProductId("scrollstitch_pro_yearly"), "scrollstitch_pro_yearly");
  assert.equal(baseProductId(null), null);
  assert.equal(baseProductId(""), null);
  assert.equal(baseProductId(":yearly"), null);
});
