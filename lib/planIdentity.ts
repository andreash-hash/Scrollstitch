/**
 * Comparing a customer's active product against a plan we sell.
 *
 * This exists because the obvious version is wrong twice over.
 *
 * Matching a substring — `activeProductId.includes("annual")` — is wrong
 * because a store identifier is not a description of the plan. When the annual
 * plan moved to `scrollstitch_pro_yearly`, that substring stopped appearing in
 * the identifier of the very plan it was meant to detect, and the check began
 * answering false for every annual subscriber.
 *
 * Comparing the raw strings is wrong because Play writes a subscription as
 * `productId:basePlanId`, and reports it with the suffix in some places and
 * without it in others. The identifier behind the annual package can arrive as
 * `scrollstitch_pro_yearly:yearly` while the active entitlement reports
 * `scrollstitch_pro_yearly` for the same purchase.
 */

/** The product id without Play's `:basePlanId` suffix. */
export function baseProductId(identifier: string | null | undefined): string | null {
  if (!identifier) return null;
  const base = identifier.split(":")[0];
  return base.length > 0 ? base : null;
}

/**
 * Whether two store identifiers name the same product, across the suffix
 * difference. Never true for a missing identifier: "we do not know what they
 * are on" is not the same as "they are on this plan".
 */
export function isSamePlan(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const left = baseProductId(a);
  const right = baseProductId(b);
  return left !== null && right !== null && left === right;
}
