# Store Setup Checklist

This document covers every manual step needed to take ScrollStitch from the current
RevenueCat Test Store to live purchases on the App Store and Google Play.

The RevenueCat project, iOS app, and Android app are already created programmatically
(see `scripts/seedRevenueCat.ts`). The API keys are stored in environment secrets.

---

## 1. Apple App Store Connect

### 1a. Create the app
1. Go to [App Store Connect → My Apps](https://appstoreconnect.apple.com/apps) and click **+** → **New App**.
2. Select **iOS**, enter:
   - **Name**: ScrollStitch
   - **Bundle ID**: `com.scrollstitch` *(already set in `app.json`; permanent once registered)*
   - **SKU**: anything unique, e.g. `scrollstitch-001`
3. Save.

### 1b. Create in-app purchase products
Inside your new app → **In-App Purchases** → **+**:

| Product ID | Type | Price |
|---|---|---|
| `scrollstitch_pro_weekly_v2` | Auto-Renewable Subscription | $4.99 / week — **add a 3-day free trial as an Introductory Offer** |
| `scrollstitch_pro_yearly` | Auto-Renewable Subscription | $29.99 / year |
| `scrollstitch_pro_lifetime` | **Non-Consumable** — outside the subscription group | $79.99 once |

> **Get the type right the first time.** A product id is spent the moment it is
> used, and deleting the product does not release it. Both of the original
> identifiers — `scrollstitch_pro_weekly` and `scrollstitch_pro_annual` — were
> lost this way by being created as in-app purchases instead of
> auto-renewable subscriptions. One of them had never even been submitted for
> review, and App Store Connect still refuses to reuse the id. The `_v2` suffix
> above is the scar from that; there is no way to undo it.

For the two subscriptions:
- Set the **Subscription Group** to "ScrollStitch Pro" — both in the same group.
- Set **Subscription Levels**: annual at Level 1, weekly at Level 2, so the
  day-3 win-back offer upgrades a weekly subscriber immediately instead of
  waiting for their next renewal.
- Add **Localizations** (Display Name + Description) in at least English.
  Display Name is capped at 30 characters, Description at 45.
- Reference Name must be unique across every product in the app. The burnt ids
  still hold theirs, so use `ScrollStitch Pro Yearly` rather than
  `ScrollStitch Pro Annual`.
- Set **Review Screenshot** (required before approval).

Lifetime is a Non-Consumable and does **not** belong to the subscription group —
it has no duration, no renewal and no introductory offer.

Products in **Ready to Submit** already work in the sandbox, so TestFlight
testing does not have to wait for review.

### 1c. Link App Store Connect to RevenueCat
RevenueCat needs an **App Store Connect API key** to validate receipts server-side:

1. In App Store Connect → **Users and Access** → **Integrations** → **App Store Connect API**.
2. Create a key with **App Manager** role and download the `.p8` file.
3. In the RevenueCat dashboard → **Project Settings** → **Apps** → **ScrollStitch iOS** → **App Store Connect API Key**, paste the Issuer ID, Key ID, and upload the `.p8` file.

### 1d. Add the Privacy Policy URL
The hosted privacy policy is served at:

```
https://<your-production-domain>/privacy
```

Add this URL to:
- App Store Connect → **App Information** → **Privacy Policy URL**
- RevenueCat dashboard → **Project Settings** → **General** → **Privacy Policy URL** (optional but recommended)

---

## 2. Apple Small Business Program

Reduces Apple's commission from 30 % to 15 % for developers earning under $1 M/year.

1. Enroll at [developer.apple.com/app-store/small-business-program](https://developer.apple.com/app-store/small-business-program/).
2. Enrollment is free; Apple reviews and approves within a few days.
3. The reduced rate applies automatically to new sales after enrollment.

---

## 3. Google Play Console

### 3a. Create the app
1. Go to [play.google.com/console](https://play.google.com/console) → **Create app**.
2. Select **App**, **Free**, fill in the form.
3. Package name is `com.scrollstitch`, already set in `app.json`.

### 3b. Create subscription products
**Monetize** → **Products** → **Subscriptions** → **Create subscription**:

| Product ID | Base plan ID | Price |
|---|---|---|
| `scrollstitch_pro_weekly_v2` | `weekly` | $4.99 / week — add a 3-day free trial |
| `scrollstitch_pro_yearly` | `yearly` | $29.99 / year |

Lifetime is a one-time product, not a subscription — create it under
**Monetize** → **Products** → **In-app products** as `scrollstitch_pro_lifetime`
at $79.99. One-time products carry no base plan, so there is no suffix on it.

The full Play Store identifiers used by RevenueCat are:
- `scrollstitch_pro_weekly_v2:weekly`
- `scrollstitch_pro_yearly:yearly`
- `scrollstitch_pro_lifetime`

These already match the identifiers in `scripts/seedRevenueCat.ts`.

### 3c. Link Google Play to RevenueCat
RevenueCat needs a **Google Play service account** to validate purchases:

1. In [Google Cloud Console](https://console.cloud.google.com/), open the project linked to your Play account.
2. **IAM & Admin** → **Service Accounts** → **Create Service Account**.
   - Role: **Pub/Sub Admin** (Google Play requires this for real-time notifications).
3. Download the **JSON key**.
4. In Google Play Console → **Setup** → **API access**, link the service account and grant it **Financial data, orders, and cancellation survey responses** permissions.
5. In the RevenueCat dashboard → **Project Settings** → **Apps** → **ScrollStitch Android** → **Service Account**, upload the JSON key.

---

## 4. Update `app.json` before submission

Replace the placeholder bundle identifiers with your real ones:

```json
{
  "expo": {
    "ios": {
      "bundleIdentifier": "com.yourcompany.scrollstitch"
    },
    "android": {
      "package": "com.yourcompany.scrollstitch"
    }
  }
}
```

Also update `scripts/seedRevenueCat.ts`:
- `APP_STORE_BUNDLE_ID`
- `PLAY_STORE_PACKAGE_NAME`

Then re-run `npx tsx scripts/seedRevenueCat.ts` to sync the new identifiers to RevenueCat.

---

## 5. Test with Sandbox / Test Tracks

Before going live:
- **iOS**: Use a Sandbox tester account in App Store Connect → **Users and Access** → **Sandbox Testers**.
- **Android**: Use a licensed tester or internal test track in Google Play Console.
- In the app, `__DEV__` mode routes to the RevenueCat Test Store key automatically (`lib/revenuecat.tsx`).

---

## Current RevenueCat Configuration

| Item | Value |
|---|---|
| Project ID | `proj509b3274` (env: `REVENUECAT_PROJECT_ID`) |
| iOS App ID | env: `REVENUECAT_APPLE_APP_STORE_APP_ID` |
| Android App ID | env: `REVENUECAT_GOOGLE_PLAY_STORE_APP_ID` |
| Entitlement | `pro` |
| Offerings | `default` (current) |
| Weekly package | `$rc_weekly` → `scrollstitch_pro_weekly_v2` |
| Annual package | `$rc_annual` → `scrollstitch_pro_yearly` |
| Lifetime package | `$rc_lifetime` → `scrollstitch_pro_lifetime` |
| Privacy Policy URL | `https://<production-domain>/privacy` |


## Free trial (required for the paywall copy to appear)

The paywall only says "Start 3 days free" when the store actually reports an
introductory offer the current user is eligible for. Configure it in both
stores, or the button silently falls back to "Subscribe — $4.99/week":

**App Store Connect** → your weekly subscription → *Subscription Prices* →
**Introductory Offer** → Free trial, 3 days, all territories, no end date.

**Google Play Console** → *Monetize → Subscriptions* → the weekly base plan →
**Add offer** → Free trial, 3 days, eligibility "New customers only".

RevenueCat picks these up automatically — nothing to configure there.

## Hard paywall and App Review

The app has no free tier: without an active `pro` entitlement the only screen
is the onboarding flow, which ends in the plans. That is allowed, but App
Review will check three things, all of which are already in place:

- **Restore Purchases** is on the paywall (required, and reviewers use it).
- **Subscription terms** — length, price and auto-renewal — are stated next to
  the button, including the trial terms when a trial is offered.
- **Links to Terms of Use and Privacy Policy** sit under the button. Terms
  points at Apple's standard EULA; Privacy points at `/privacy` on the server,
  so that route must be reachable on the production domain before submitting.

Reviewers test purchases in the sandbox, so no demo account is needed — but do
make sure the sandbox products are live in App Store Connect before submitting,
or the paywall shows the "Couldn't load pricing" state and the app gets
rejected as non-functional.


## Before the first build

`eas.json` carries the environment for every build profile. All three point at
`scroll-stitcher.replit.app`, the current deployment.

**Change `build.production.env.EXPO_PUBLIC_DOMAIN` before submitting to the
App Store** if you have a custom domain by then. Expo inlines the value at
build time, so it cannot be corrected without a new build *and* a new App
Store release — a `.replit.app` address shipped to the store is one you are
stuck with until the next update.

Checklist for a first production build:

1. Confirm `https://<domain>/privacy` loads in a browser — the paywall links
   there and App Review will click it.
2. Set `EXPO_PUBLIC_DOMAIN` in `eas.json` → `build.production.env` to the
   domain you intend to keep.
3. `npx tsx scripts/seedRevenueCat.ts` to create the weekly/annual products in
   RevenueCat (bundle ID `com.scrollstitch`).
4. Create the same two subscriptions in App Store Connect, plus the 3-day
   Introductory Offer on the weekly plan.
5. In RevenueCat, add the App Store Connect **In-App Purchase Key** so receipts
   validate. Without it purchases succeed but no entitlement is granted.
6. `eas build --platform ios --profile production`.

Bundle ID, package name, photo-library purpose strings and the export
compliance flag (`ITSAppUsesNonExemptEncryption: false`) are already set in
`app.json`.


## After every deploy

Check `https://<domain>/api/health`. It returns the app name and version, the
git SHA the server was built from, and `privacyPolicyMentions` — which reads
`"current"` on a good build and `"ScrollSnap"` if the deployment is still
serving pre-rename code. App Review follows the privacy link from the paywall,
so a stale policy naming a different app is a rejection risk, not a cosmetic
one.
