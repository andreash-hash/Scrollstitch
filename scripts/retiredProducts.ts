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
 *   - scrollstitch_pro_annual[...]
 *                       created in App Store Connect as a non-consumable
 *                       in-app purchase rather than an auto-renewable
 *                       subscription, and submitted for review. A submitted
 *                       product cannot be deleted and Apple never releases a
 *                       product id for reuse, so the identifier is spent. The
 *                       annual plan is scrollstitch_pro_yearly now.
 *
 * Anchored at the start deliberately. An unanchored /scrollstitch_pro_annual/
 * would be the same string with a much wider reach, and the live weekly,
 * yearly and lifetime products sit one word away from it.
 */
export const RETIRED_IDENTIFIER = /^scrollsnap|^scrollstitch_pro_annual/i;

/**
 * Appended to a retired product's display name.
 *
 * A display name must be unique within its app, and it is the only field
 * RevenueCat lets an existing product change. The retired annual holds the
 * exact name its replacement needs, so it has to be moved aside before the
 * replacement can be created — see the rename pass in seedRevenueCat.ts.
 */
export const RETIRED_SUFFIX = " (retired)";

export function isRetiredIdentifier(storeIdentifier: string | null | undefined): boolean {
  return RETIRED_IDENTIFIER.test(storeIdentifier ?? "");
}

/**
 * The display name a retired product should carry. Idempotent: running the
 * seed twice must not produce "... (retired) (retired)".
 */
export function retiredDisplayName(displayName: string | null | undefined, fallback: string): string {
  const current = displayName?.trim() ? displayName : fallback;
  return current.endsWith(RETIRED_SUFFIX) ? current : current + RETIRED_SUFFIX;
}
