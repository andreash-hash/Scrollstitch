# Store Setup Checklist

This document covers every manual step needed to take ScrollSnap from the current
RevenueCat Test Store to live purchases on the App Store and Google Play.

The RevenueCat project, iOS app, and Android app are already created programmatically
(see `scripts/seedRevenueCat.ts`). The API keys are stored in environment secrets.

---

## 1. Apple App Store Connect

### 1a. Create the app
1. Go to [App Store Connect → My Apps](https://appstoreconnect.apple.com/apps) and click **+** → **New App**.
2. Select **iOS**, enter:
   - **Name**: ScrollSnap
   - **Bundle ID**: `com.myapp` *(update `app.json` → `ios.bundleIdentifier` to your real unique ID first)*
   - **SKU**: anything unique, e.g. `scrollsnap-001`
3. Save.

### 1b. Create in-app purchase products
Inside your new app → **In-App Purchases** → **+**:

| Product ID | Type | Price |
|---|---|---|
| `scrollsnap_pro_monthly` | Auto-Renewable Subscription | $4.99 / month |
| `scrollsnap_pro_annual` | Auto-Renewable Subscription | $29.99 / year |

For each product:
- Set a **Subscription Group** (e.g. "ScrollSnap Pro").
- Add **Localizations** (Display Name + Description) in at least English.
- Set **Review Screenshot** (required before approval).
- Submit for review (products are reviewed alongside the app).

### 1c. Link App Store Connect to RevenueCat
RevenueCat needs an **App Store Connect API key** to validate receipts server-side:

1. In App Store Connect → **Users and Access** → **Integrations** → **App Store Connect API**.
2. Create a key with **App Manager** role and download the `.p8` file.
3. In the RevenueCat dashboard → **Project Settings** → **Apps** → **ScrollSnap iOS** → **App Store Connect API Key**, paste the Issuer ID, Key ID, and upload the `.p8` file.

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
3. Update `app.json` → `android.package` to match (currently `com.myapp`; use a unique reverse-domain ID).

### 3b. Create subscription products
**Monetize** → **Products** → **Subscriptions** → **Create subscription**:

| Product ID | Base plan ID | Price |
|---|---|---|
| `scrollsnap_pro_monthly` | `monthly` | $4.99 / month |
| `scrollsnap_pro_annual` | `annual` | $29.99 / year |

The full Play Store identifiers used by RevenueCat are:
- `scrollsnap_pro_monthly:monthly`
- `scrollsnap_pro_annual:annual`

These already match the identifiers in `scripts/seedRevenueCat.ts`.

### 3c. Link Google Play to RevenueCat
RevenueCat needs a **Google Play service account** to validate purchases:

1. In [Google Cloud Console](https://console.cloud.google.com/), open the project linked to your Play account.
2. **IAM & Admin** → **Service Accounts** → **Create Service Account**.
   - Role: **Pub/Sub Admin** (Google Play requires this for real-time notifications).
3. Download the **JSON key**.
4. In Google Play Console → **Setup** → **API access**, link the service account and grant it **Financial data, orders, and cancellation survey responses** permissions.
5. In the RevenueCat dashboard → **Project Settings** → **Apps** → **ScrollSnap Android** → **Service Account**, upload the JSON key.

---

## 4. Update `app.json` before submission

Replace the placeholder bundle identifiers with your real ones:

```json
{
  "expo": {
    "ios": {
      "bundleIdentifier": "com.yourcompany.scrollsnap"
    },
    "android": {
      "package": "com.yourcompany.scrollsnap"
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
| Monthly package | `$rc_monthly` → `scrollsnap_pro_monthly` |
| Annual package | `$rc_annual` → `scrollsnap_pro_annual` |
| Privacy Policy URL | `https://<production-domain>/privacy` |
