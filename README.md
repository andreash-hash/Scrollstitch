# ScrollStitch

Turn a scrolling screen recording into one long, seamless screenshot (PNG/JPEG + PDF).

- **Client** (Expo / React Native, `app/`): picks a screen recording, extracts a frame
  every 300 ms, runs a rough on-device dedup, uploads the frames, and polls live
  processing progress.
- **Server** (Node + Express + Sharp, `server/`): validates the frames, deduplicates
  them (16×16 perceptual hash), detects and removes sticky headers/footers, greedily
  selects the best frames by NCC overlap, stitches everything into one image, and
  renders a PDF.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run server:dev` | Start the processing server (port 5000) |
| `npm run expo:dev` | Start the Expo client |
| `npm test` | End-to-end pipeline tests on synthetic recordings (CI-friendly) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (expo config) |

## Health check

`GET /api/health` reports what the running server actually is — app name and
version, git SHA, uptime, and whether the privacy policy still names the old
app. Use it after every deploy: a deployment quietly serving an old build is
otherwise invisible until something unrelated looks wrong.

## Pipeline

`POST /api/process-frames` → validate → dedup → sticky removal → **greedy frame
selection** → stitch → PDF. Progress (stage, percent, frame counter) is polled via
`GET /api/progress/:jobId`; the final result includes per-seam diagnostics
(overlap px, NCC, threshold used) plus any warnings — e.g. scroll-jump "gaps" —
which the client surfaces in the UI.

## CHANGELOG

### 2026-08 — Deploy visibility

The published deployment was found serving code from before the ScrollSnap →
ScrollStitch rename — caught only because its privacy policy still named the
old app. `GET /api/health` now reports the build's identity (name, version,
git SHA, uptime) plus a check on that exact symptom, so the next drift takes
five seconds to spot instead of a lucky glance.

### 2026-08 — Modernist re-skin

Ported the "Modernist" design system from the Claude Design bundle (kept in
`design/` for reference). The app's look is now the inverse of what it was:

| | Before | Now |
| --- | --- | --- |
| Ground | dark `#0A0E17` | light `#f3f2f2` |
| Accent | teal `#00D4AA` | red-orange `#ec3013` |
| Type | Inter | Archivo (headings at 800) |
| Corners | 10–20 px | 0 — every radius token is 0 |

- `constants/colors.ts` is now the token source: the Modernist palette plus the
  neutral ramp, with `Type` and `Space` scales exported alongside. The `dark`
  key is kept so existing `Colors.dark` imports keep working.
- **Every gradient is gone.** The system is flat, so each `LinearGradient` became
  a plain `View` with a solid accent fill — including the buttons, hero badge
  and progress bar.
- Structural retune where a colour swap was not enough: 2 px rules under the
  header, the stats band ruled top and bottom with 1 px vertical dividers
  instead of three floating cards, an oversized accent percentage over a flat
  track, and uppercase letter-spaced labels on buttons and status text.
- Light chrome throughout: `dark-content` status bar, `userInterfaceStyle:
  "light"`, and light splash/adaptive-icon backgrounds.

**Not yet applied from the design**, and deliberately so: the three-tab bar and
Library tab need result persistence that does not exist (the server deletes its
output), and the export dialog, toast and cancel-during-processing change
behaviour rather than appearance. "Trim edges" is kept although the design omits
it, and "Replay intro" stays removed regardless — the hard paywall bounces a
subscriber straight back out of the intro.

### 2026-07 — Release configuration

- **Bundle identifier** `app.scrollstitch` (iOS and Android), replacing the
  `com.myapp` placeholder, and the URL scheme is now `scrollstitch`. Both are
  permanent once registered, so they had to be settled before anything reached
  App Store Connect.
- **Photo-library purpose strings** in `app.json`. Without them iOS *crashes*
  the moment a permission is requested, and the package defaults ("Allow
  ScrollStitch to access your photos") are the vague kind App Review has been
  rejecting. They now say what the app does with the recording.
- **`ITSAppUsesNonExemptEncryption: false`** declared in the manifest — the app
  only talks HTTPS, and declaring it here removes the export-compliance prompt
  from every build upload.
- **`eas.json`** added with development/preview/production profiles. The
  RevenueCat public keys (designed to ship inside the binary) are filled in;
  `EXPO_PUBLIC_DOMAIN` is a deliberate placeholder, because the client throws
  at startup without it and every stitch runs on that server.
- STORE_SETUP gained an ordered first-build checklist, including the App Store
  Connect In-App Purchase Key that RevenueCat needs before entitlements are
  granted in production.

### 2026-07 — Renamed ScrollSnap → ScrollStitch

Renamed before anything was created in the stores, because **product
identifiers can never be changed once they exist in App Store Connect**.

Motivation: Snap Inc. holds a registered `SNAP` trademark covering software for
collecting, editing, storing and sharing data, and actively opposes marks in
this space — including `SNAP-N-STOR`, which was photo software for phones. The
association also bought nothing: nobody looking for this app searches "snap",
whereas "stitch" is a term the category actually uses.

Renamed everywhere: app name and slug, in-app title, AsyncStorage keys, saved
filenames, server temp directories, subscription product identifiers
(`scrollstitch_pro_weekly` / `_annual`), RevenueCat project and app names,
privacy policy and docs.

Also hardened the seed script: it now matches the RevenueCat project by
`REVENUECAT_PROJECT_ID` before falling back to the project name. Matching on
the name alone meant this rename would have silently created a *second*
project, orphaning the apps and API keys the client already ships with.

### 2026-07 — Hard paywall, weekly plan, day-3 win-back, review prompt

Monetisation reworked to a hard-paywall model: weekly $4.99 with a 3-day
trial as the primary plan, annual $29.99 as the win-back.

- **No free tier.** Without an active `pro` entitlement the router allows only
  the onboarding flow, which ends in the plans. The redirect waits for the
  entitlement check so paying subscribers never see the paywall flash, and
  "Skip" now jumps to the plans instead of into the app.
- **Weekly replaces monthly** in the seed script, the entitlement, the offering
  (`$rc_weekly`) and the paywall. Annual is the second option.
- **Trial copy follows the store, not the code**: the button says "Start 3 days
  free" only when the store reports an introductory offer this user is eligible
  for, and falls back to the plain price otherwise — so it can never promise a
  trial the store will not grant.
- **Day-3 win-back**: after three days, the first successful stitch offers
  weekly subscribers the annual plan, once, and never alongside the review
  prompt.
- **Review prompt** after the second *clean* stitch (no gap warnings) — asking
  right after a result the user can see worked, rather than on launch.
- **Paywall copy sells outcomes** ("One clean image instead of 12 screenshots")
  rather than listing features, and now carries the subscription terms plus
  Terms of Use and Privacy Policy links that App Review requires.
- Removed "Replay intro": with the intro ending in a hard paywall, a subscriber
  replaying it would be redirected straight back out.

### 2026-07 — Accessibility pass

Every interactive element in the app now carries a role and a label — 37
controls across the main screen, onboarding/paywall, the subscription banner
and the error fallback (audited programmatically; none left unlabelled).

- **Roles and labels** on every button, with `accessibilityHint` where the
  outcome isn't obvious from the label ("Manage subscription" opens the App
  Store, "View plans" leaves the current screen).
- **State is exposed, not just drawn**: sensitivity and output-quality chips
  and the billing toggle are `radio` with a `selected` state; buttons that
  work in the background report `busy` and `disabled`; the settings toggle
  reports `expanded`.
- **Progress is announced.** An animated bar tells a screen-reader user
  nothing, and the poll rewrites the status text several times a second, so
  the bar is a `progressbar` with a live value and each stage change is
  announced once via `AccessibilityInfo`.
- **Warnings and errors are alerts** (`accessibilityRole="alert"` plus a live
  region), so scroll-jump warnings, processing failures and the subscription
  banner reach the user instead of appearing silently.
- **Composite readouts**: each stat tile reads as one phrase ("23 frames used
  in the stitch") instead of a number and a label read separately, and the
  result image is described with its dimensions.

### 2026-07 — Local changes no longer sink a seam

A real Reddit-feed recording produced near-misses rather than noise: seams
scoring 0.75–0.80 against a 0.85 bar, i.e. content that plainly lines up. Feeds
mutate locally while you scroll — an image finishes loading, a video starts, a
counter ticks — and a single correlation over the whole overlap lets one
changed band outvote everything that matches.

- Each candidate overlap is now also scored **band by band (9 slices) and the
  median taken**, with the final score the better of global and median. A
  minority of changed bands cannot move the median, while unrelated content
  leaves every band at noise — so this is more permissive only where most of
  the overlap genuinely agrees. Verified: a seam with one repainted band scores
  0.808 (rejected) on the global measure alone, and matches with the median.

### 2026-07 — Denser sampling, ceiling raised to 99 %

Measured on a real recording after the range fix: gaps fell from 30 of 45 seams
to 7 of 22, and the output shrank from 37 793 px to 14 076 px (duplicate
content actually trimmed). The remaining gaps scored 26–39 % — noise, meaning
those pairs genuinely share no content because the flick outran the sampling.

- Extraction interval 150 ms → **100 ms** (cap 300 frames) so even a hard flick
  leaves shared content. The surplus costs nothing: dedup and greedy selection
  discard it — that run turned 65 uploaded frames into 23 stitched.
- Search ceiling 97 % → **99 %**. Denser sampling pushes slow-scroll pairs
  toward total overlap; a pair above the ceiling scores noise and would be
  called a gap. Matching at 98 % is not a false positive — the selection step
  recognises it as a near-duplicate and skips the frame.

### 2026-07 — Overlap search covered only the middle of the range

- **The matcher had blind spots at both ends.** It searched overlaps from 20 %
  to 90 % of the frame height only. A fast flick leaves a sliver of shared
  content (well under 20 %), and dense 150 ms sampling of an ordinary scroll
  leaves nearly the whole frame shared (well over 90 %) — in both cases the
  true correlation peak sat outside the searched window, so the pair scored
  noise (0.2–0.45) and was reported as a scroll jump. The search now spans
  4 %–97 %; measured on the synthetic case, a 7 % overlap scored 0.227 under
  the old bounds versus a clean match now.
- **Confidence scales with overlap size**: few compared rows make a chance
  alignment cheap, so the required NCC ramps up by as much as +0.10 as the
  overlap shrinks below 25 % of the frame. Candidates are ranked by margin
  over their own requirement rather than by raw NCC.
- Overlap logs now include the overlap as a percentage of frame height and the
  range that was searched, so a future mismatch is diagnosable from one line.

### 2026-07 — Status-bar chrome and web downloads

- **Guard band in overlap matching**: sticky detection only catches chrome
  whose pixels are *identical* across frames, so an OS status bar with a live
  clock (or a screen-recording timer) slips through — yet it still occupies the
  same screen rows in every frame and poisons both edges of every comparison,
  pushing true seams just under the confidence threshold. NCC now excludes an
  8 %-of-frame guard band at both ends of the compared window. Measured on the
  synthetic case: NCC 0.78 (rejected) without the guard, ≥0.85 (accepted) with.
- **Seams cut mid-overlap**: the stitcher now takes the previous frame's pixels
  for the first half of an overlap and the new frame's for the second half.
  Content is identical either way, but undetected chrome lives at the frame
  edges — cutting in the middle keeps it out of the output entirely.
- **Web save/share**: `MediaLibrary` and `Sharing` don't exist in the browser,
  and React Native Web's `Alert` is a no-op, so both buttons failed silently in
  the Replit preview. On web they now download the file via a blob URL instead.

### 2026-07 — Real-recording fixes (fast flicks, iOS preview)

- **Denser frame sampling**: 300 ms sampling missed all overlap during flick
  scrolls (a flick moves 1–1.5 screen heights per 300 ms → every seam became a
  gap). Extraction now samples every 150 ms, widening adaptively so long videos
  stay ≤ 240 frames; the dedup passes discard the surplus on slow sections.
- **Blank-frame guards**: iOS Safari can fire `seeked` before the frame is
  decoded, capturing all-black frames. The web extractor now probes the canvas
  and retries/skips blanks; the server validation also drops uniform
  near-black frames with a warning instead of letting them force gaps.
- **Display preview**: iOS refuses to decode very large images (a long stitch
  is easily 50+ MP and rendered black). Results above 12 MP now ship with a
  downscaled JPEG `previewUrl` for on-screen use; saving/sharing still uses
  the full-resolution image. The crop endpoint got the same treatment.
- **Actionable gap summary**: when gaps dominate the seams, the result leads
  with one clear warning ("scrolling was too fast — re-record with a slower,
  steadier scroll") instead of dozens of per-seam messages.

### 2026-07 — RevenueCat merge repair

- Restored the stitching-completion work below after a Replit push (RevenueCat
  integration) was based on a stale working copy and reverted the server
  pipeline, tests, and client progress/warning UI. RevenueCat additions
  (paywall, entitlement gating, `/privacy` page, seed scripts) are kept intact.
- Fixed the committed `package-lock.json` pointing at Replit's internal
  package proxy (`package-firewall.replit.local`), which broke `npm install`
  everywhere outside Replit.
- Fixed a type error in `scripts/seedRevenueCat.ts` (SDK `Duration` type) and
  three lint errors (unescaped apostrophes) in the new subscription UI;
  rebuilt `server_dist/` from the restored sources.

### 2026-07 — Stitching completion

- **Greedy frame selection** (`selectFrames`): frames are walked chronologically and
  kept only when their NCC overlap against the last kept frame lands in the
  ~20–60 % window; >80 % overlap (near-duplicates) is skipped. Skipped-but-measurable
  frames are remembered and promoted when needed, so greedy skipping never
  manufactures a gap and the bottom of the scroll is never lost. Frames with no
  measurable overlap are still kept, with the seam marked **"gap"**, a server-side
  warning log, and a warning surfaced to the client UI.
- **Adaptive NCC confidence**: the acceptance threshold now scales with the measured
  contrast of the overlap zone (0.85 for high-contrast content, floor 0.75 for
  dark/low-contrast screens). Measured NCC, applied threshold, and contrast are
  logged per seam and returned in the result's seam summary.
- **Fine-search before rejection**: the ±16 px fine pass now runs *before* the
  confidence check, so true overlaps that sit between coarse 8 px samples are no
  longer rejected on JPEG-noisy content.
- **Dark-screen dedup fix**: frame signatures gained a contrast-normalised channel
  (still 16×16 @ 0.93) so distinct dark frames are no longer collapsed as
  duplicates, while static screens still dedup correctly.
- **Bounded memory stitching**: frames are decoded one at a time into a single
  preallocated RGB canvas (no per-frame buffer retention) — 85 frames stitch in
  seconds within a few hundred MB. Outputs too tall for JPEG (>65 500 px)
  automatically fall back to PNG; absurdly large outputs fail with a clear error.
- **Robust errors & progress**: undecodable frames are skipped with a warning
  (fully corrupt uploads fail with a clear message), empty uploads are rejected,
  and every stage reports fine-grained progress (`progress` + `detail` frame
  counter) that the client now renders directly instead of simulated ticks.
- **Client**: shows gap/scroll-jump warnings on the result screen, uses real
  server progress, and fixes the web frame-hash helper (`new Image()` resolved to
  the expo-image component, breaking on-device dedup on web).
- **Tests**: `npm test` runs synthetic end-to-end suites — a generated page is cut
  into JPEG-compressed frames (optionally with sticky header/footer, scroll jumps,
  near-duplicates, dark theme, keyboard overlays, corrupt files, 1–2 frames,
  85-frame memory check) and the stitched output is verified against the original
  page, both by geometry and by locating content strips. An HTTP-level suite
  covers upload → progress → result → download and error reporting.
- Removed the last remnants of the old fingerprint matching approach; typecheck
  (`tsc --noEmit`) and lint are clean.
