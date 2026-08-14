import { baseProductId } from "../lib/planIdentity";

/**
 * Which RevenueCat store identifiers belong to plans the project has left
 * behind, and how their display names are moved aside.
 *
 * This lives in its own file for one reason: the pattern governs deletion.
 * Matching one character too loosely would take out a live product, so it is
 * unit-checked against every identifier in play rather than trusted by eye.
 * The seed script executes on import, so a test cannot reach the pattern
 * unless it sits outside that script.
 *
 * Two groups are retired:
 *
 *   - scrollsnap_*      the previous app name
 *   - the subscription identifiers burnt in App Store Connect by being created
 *     as in-app purchases rather than auto-renewable subscriptions. Apple never
 *     releases a product id, and deleting the product does not release it
 *     either — an identifier is spent the moment it is used, whether or not it
 *     was ever submitted for review.
 */
const RETIRED_BASE_IDS = new Set([
  // Created as a non-consumable in-app purchase and submitted for review.
  // Replaced by scrollstitch_pro_yearly.
  "scrollstitch_pro_annual",
  // Created as an in-app purchase, never submitted, then deleted — and still
  // rejected as "already being used" on re-creation. Replaced by
  // scrollstitch_pro_weekly_v2.
  "scrollstitch_pro_weekly",
]);

/** The previous app name. Nothing live begins with it. */
const LEGACY_APP_NAME = /^scrollsnap/i;

/**
 * Appended to a retired product's display name.
 *
 * A display name must be unique within its app, and it is the only field
 * RevenueCat lets an existing product change. A retired product holds the
 * exact name its replacement needs, so it has to be moved aside before the
 * replacement can be created — see the rename pass in seedRevenueCat.ts.
 */
export const RETIRED_SUFFIX = " (retired)";

/**
 * Matched on the exact identifier, not as a prefix.
 *
 * This is the whole reason the check is a set rather than a regex. The
 * replacement for the burnt weekly plan is `scrollstitch_pro_weekly_v2`, which
 * a prefix pattern like /^scrollstitch_pro_weekly/ matches happily — the seed
 * would create the live weekly product and then delete it in the same run, and
 * the paywall would lose the plan the trial funnels into.
 *
 * Play's `:basePlanId` suffix is stripped first, so both spellings of the same
 * retired subscription are caught.
 */
export function isRetiredIdentifier(storeIdentifier: string | null | undefined): boolean {
  const base = baseProductId(storeIdentifier);
  if (base === null) return false;
  if (LEGACY_APP_NAME.test(base)) return true;
  return RETIRED_BASE_IDS.has(base.toLowerCase());
}

/**
 * The display name a retired product should carry. Idempotent: running the
 * seed twice must not produce "... (retired) (retired)".
 */
export function retiredDisplayName(displayName: string | null | undefined, fallback: string): string {
  const current = displayName?.trim() ? displayName : fallback;
  return current.endsWith(RETIRED_SUFFIX) ? current : current + RETIRED_SUFFIX;
}
