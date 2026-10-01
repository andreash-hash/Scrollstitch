import { useEffect } from "react";
import { Platform } from "react-native";
import Purchases from "react-native-purchases";
import { useDeepLinkIapProvider } from "insert-affiliate-react-native-sdk";

/**
 * Affiliate attribution, hung off RevenueCat rather than wired into the
 * purchase.
 *
 * The SDK never touches a transaction. It resolves which affiliate sent a
 * customer here, and this passes that on as RevenueCat *attributes*; the
 * attribution itself is settled server-side by a RevenueCat webhook. Nothing
 * about the paywall, the `pro` entitlement or the purchase flow changes, which
 * is the whole reason this integration is safe to add to a shipping app: two
 * systems both deciding who owns a subscription is a class of bug worth not
 * having.
 */
const COMPANY_CODE = process.env.EXPO_PUBLIC_INSERT_AFFILIATE_COMPANY_CODE;

export function InsertAffiliateSync() {
  const { initialize, isInitialized, setInsertAffiliateIdentifierChangeCallback } =
    useDeepLinkIapProvider();

  useEffect(() => {
    if (isInitialized) return;
    if (!COMPANY_CODE) {
      // Missing config must not be a crash. Without a code there is nothing to
      // attribute to, and an app that still sells subscriptions is a far better
      // outcome than one that refuses to start over a marketing integration.
      console.log(
        "Insert Affiliate disabled: EXPO_PUBLIC_INSERT_AFFILIATE_COMPANY_CODE is not set."
      );
      return;
    }

    initialize(
      COMPANY_CODE,
      __DEV__, // verbose logging only in development
      true, // Insert Links — the built-in deep link provider
      false // clipboard reading stays off: it trips iOS's paste banner and
      //       reads the clipboard of everyone who opens the app, which is a
      //       poor trade for the handful of attributions it recovers.
    ).catch((err: unknown) => {
      console.log("Insert Affiliate failed to initialise:", err);
    });
  }, [initialize, isInitialized]);

  useEffect(() => {
    setInsertAffiliateIdentifierChangeCallback(async (identifier, offerCode) => {
      if (!identifier) return;
      try {
        await Purchases.setAttributes({
          insert_affiliate: identifier,
          affiliateOfferCode: offerCode || "",
        });
        await Purchases.syncAttributesAndOfferingsIfNeeded();
      } catch (err) {
        // An attribute that will not sync is a lost attribution, not a broken
        // app. Never let it reach the person trying to buy something.
        console.log("Insert Affiliate: could not sync attributes:", err);
      }
    });

    return () => setInsertAffiliateIdentifierChangeCallback(null);
  }, [setInsertAffiliateIdentifierChangeCallback]);

  return null;
}

/** Web has no native SDK behind any of this. */
export const insertAffiliateEnabled = Platform.OS !== "web" && !!COMPANY_CODE;
