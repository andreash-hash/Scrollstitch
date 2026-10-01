/**
 * Test double for react-native-purchases, used ONLY in e2e web builds.
 *
 * metro.config.js swaps this in when E2E=1 at bundle time. Production and
 * ordinary dev builds never see it. On web the real SDK runs in "Browser
 * Mode" and talks to api.revenuecat.com — a test must not depend on that, or
 * on anyone's real account.
 *
 * Playwright drives the state through `window.__E2E_RC__` (set with
 * page.addInitScript before the app boots):
 *   { subscribed?: boolean, offerings?: "ok" | "empty" | "error",
 *     purchase?: "grant" | "no-entitlement" | "cancel" | "error",
 *     restore?: "grant" | "none" }
 */

type RcState = {
  subscribed?: boolean;
  offerings?: "ok" | "empty" | "error";
  purchase?: "grant" | "no-entitlement" | "cancel" | "error";
  restore?: "grant" | "none";
  productId?: string;
};

function state(): RcState {
  const g = globalThis as unknown as { __E2E_RC__?: RcState };
  if (!g.__E2E_RC__) g.__E2E_RC__ = {};
  return g.__E2E_RC__;
}

function customerInfo(active: boolean, productId = "scrollstitch_pro_weekly") {
  const entitlement = {
    identifier: "pro",
    isActive: true,
    productIdentifier: productId,
  };
  return {
    entitlements: {
      active: active ? { pro: entitlement } : {},
      all: active ? { pro: entitlement } : {},
    },
    activeSubscriptions: active ? [productId] : [],
    originalAppUserId: "e2e-user",
  };
}

function pkg(identifier: string, packageType: string, productId: string, priceString: string, intro?: unknown) {
  return {
    identifier,
    packageType,
    product: {
      identifier: productId,
      priceString,
      price: Number(priceString.replace(/[^0-9.]/g, "")),
      currencyCode: "USD",
      title: productId,
      introPrice: intro ?? null,
    },
  };
}

const PACKAGES = [
  pkg("$rc_weekly", "WEEKLY", "scrollstitch_pro_weekly_v2", "$4.99", {
    periodUnit: "DAY",
    periodNumberOfUnits: 3,
    priceString: "$0.00",
  }),
  pkg("$rc_annual", "ANNUAL", "scrollstitch_pro_yearly", "$29.99"),
  pkg("$rc_lifetime", "LIFETIME", "scrollstitch_pro_lifetime", "$79.99"),
];

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const Purchases = {
  LOG_LEVEL: { VERBOSE: "VERBOSE", DEBUG: "DEBUG", INFO: "INFO", WARN: "WARN", ERROR: "ERROR" },
  setLogLevel(_level: unknown) {},
  configure(_opts: unknown) {},
  async getCustomerInfo() {
    await delay(20);
    const s = state();
    return customerInfo(!!s.subscribed, s.productId);
  },
  async getOfferings() {
    await delay(20);
    const mode = state().offerings ?? "ok";
    if (mode === "error") throw new Error("E2E: offerings unavailable");
    const availablePackages = mode === "empty" ? [] : PACKAGES;
    const current = { identifier: "default", availablePackages };
    return { current, all: { default: current } };
  },
  async purchasePackage(p: { product: { identifier: string } }) {
    await delay(50);
    const s = state();
    switch (s.purchase ?? "grant") {
      case "cancel": {
        const err = new Error("Purchase was cancelled.") as Error & { userCancelled: boolean };
        err.userCancelled = true;
        throw err;
      }
      case "error":
        throw new Error("E2E: the store rejected the purchase.");
      case "no-entitlement":
        return { customerInfo: customerInfo(false), productIdentifier: p.product.identifier };
      default:
        s.subscribed = true;
        s.productId = p.product.identifier;
        return { customerInfo: customerInfo(true, p.product.identifier), productIdentifier: p.product.identifier };
    }
  },
  async restorePurchases() {
    await delay(50);
    const s = state();
    if ((s.restore ?? "none") === "grant") s.subscribed = true;
    return customerInfo(!!s.subscribed, s.productId);
  },
  async setAttributes(_attrs: Record<string, string | null>) {},
  async syncAttributesAndOfferingsIfNeeded() {
    return Purchases.getOfferings();
  },
};

export type PurchasesPackage = (typeof PACKAGES)[number];
export const LOG_LEVEL = Purchases.LOG_LEVEL;
export default Purchases;
