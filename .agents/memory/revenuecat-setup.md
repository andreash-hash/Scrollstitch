---
name: RevenueCat integration
description: RevenueCat is fully wired up with two subscription products (monthly P1M $4.99, annual P1Y $29.99) in the test store. Entitlement identifier is "pro". Project and app IDs are stored in env vars.
---

## Architecture

- `scripts/revenueCatClient.ts` — creates an authenticated `@replit/revenuecat-sdk` client via `ReplitConnectors.createProxyFetch("revenuecat")`; must be called fresh (not cached).
- `scripts/seedRevenueCat.ts` — idempotent seed script; run with `npx tsx scripts/seedRevenueCat.ts`. Creates project, apps, products, entitlement, offering, packages.
- `lib/revenuecat.tsx` — client-side SDK wrapper (`SubscriptionProvider`, `useSubscription`, `initializeRevenueCat`). Entitlement: `"pro"`.
- `app/_layout.tsx` — calls `initializeRevenueCat()` at module level (with try/catch), wraps with `SubscriptionProvider`. `SubscriptionSync` component inside `RootLayoutNav` syncs `isSubscribed → setIsPro`.
- `contexts/AppContext.tsx` — `isPro` is now set externally via `setIsPro`; AsyncStorage-based mock removed.

## Key decisions

**Why:** `AppContextProvider` wraps `SubscriptionProvider`, so AppContext cannot call `useSubscription` directly. A `SubscriptionSync` child component bridges the two via `useEffect`.

**How to apply:** Any new component that needs `isPro` should use `useAppContext()`. Subscription-specific data (offerings, packages, purchase function) should use `useSubscription()`.

## RevenueCat IDs (from env vars, do not hardcode)

- Project: `REVENUECAT_PROJECT_ID`
- Test Store App: `REVENUECAT_TEST_STORE_APP_ID`
- iOS App: `REVENUECAT_APPLE_APP_STORE_APP_ID`
- Android App: `REVENUECAT_GOOGLE_PLAY_STORE_APP_ID`
- API Keys: `EXPO_PUBLIC_REVENUECAT_TEST_API_KEY`, `EXPO_PUBLIC_REVENUECAT_IOS_API_KEY`, `EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY`

## Paywall (onboarding.tsx)

- Prices come from `monthlyPackage.product.priceString` / `annualPackage.product.priceString` — never hardcoded.
- In `__DEV__` mode: custom modal confirms purchase before calling `Purchases.purchasePackage`.
- "Restore Purchases" calls `restore()` from `useSubscription`.

## Pro gating (index.tsx)

- Settings panel (sensitivity, output quality): locked behind `isPro`; shows `showUpgradeModal` for free users.
- Crop panel: locked behind `isPro`; shows `cropPanelLocked` row with upgrade modal trigger.
- Upgrade modal redirects to onboarding paywall via `resetOnboarding()` + `router.replace("/onboarding")`.
