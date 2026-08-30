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

### 2026-08 — A sweep for the same mistakes, before building again

Rather than build straight after the last fix, the codebase was read for the
classes of bug this week actually produced.

**Completion could fire twice.** The poll's interval callback is `async`, so a
tick that outlives its 500ms slot overlaps the next one and both can read the
same `Complete`. Clearing the interval stops future ticks, not one already in
flight. The result: two success haptics, `recordSuccessfulStitch` counting one
job as two, and the win-back and review prompts triggering earlier than they
should. Both terminal branches now run once.

**Internal strings still reached the client from two server routes.** Upload
and crop failures were sending `err.message` straight through — the same
mistake as the Sharp path that arrived on a lock screen. Both go through
`readableProcessingError` now.

Checked and found sound: the other two intervals both guard against
double-starting; `saveToPhotos`, `sharePdf` and `applyCrop` all clear their busy
flags in a `finally`, so a failure cannot leave a button dead; the poll's empty
`catch` is correct now that a stall is measured separately; and the swallowed
`AsyncStorage` writes set in-memory state first, so a failed write costs
persistence between launches and nothing in the session.


### 2026-08 — A theory that outlived its evidence

    Failed to transcode picked video
    → Caused by: Operation Interrupted
    Error code: PICK · ERR_FAILED_TO_TRANSCODE_VIDEO

That is the re-encode forced on every pick two builds ago, failing. A
passthrough export cannot be interrupted, because there is nothing to
interrupt; a full re-encode runs long enough to be, and this one was.

Worth being exact about why it was there. The reasoning was that
expo-image-picker's passthrough fast path mishandles trimmed recordings, and
the evidence was a recording that needed picking twice. That double pick has
since been explained completely — the app was showing its start screen while
iOS was still exporting, so the second tap was someone reasonably assuming the
first had missed. Nothing to do with trimming.

The theory lost its evidence and the change stayed, which is how a fix becomes
a bug. Passthrough is back.

The trimming hypothesis may still be true; it was never actually tested. It is
also no longer expensive to find out. A failure here reports `PICK` with
Apple's own code attached, the re-entry guard stops a second pick landing on
top of the first, and the `preparing` stage means a slow export looks like
waiting rather than like nothing having happened.


### 2026-08 — A dropped batch should not lose the whole job

Two runs, two failures: one `UPLOAD`, one `TIMEOUT`. Both are what a phone on a
mobile network does to a long transfer, and neither was survivable.

The comment above `UPLOAD_BATCH_SIZE` says the batches are "small enough to
retry cheaply". The retry was never written. A single dropped connection ended
the upload and the job with it.

Writing one meant fixing the server first. A chunk's frames were named from a
counter shared across the whole process, so a resent chunk landed *beside* its
half-written first attempt rather than replacing it, and the stitch would have
contained the same frames twice. Both numbers in a frame's name now come from
its own request, which makes resending a chunk idempotent — and stops a
filename depending on how many frames the server had handled since it last
restarted. Each batch gets three attempts with a widening pause, rebuilding its
body each time, because a FormData already consumed by a failed send is not
safe to hand over again.

The trigger is retried too, which is only safe because of the session-ownership
fix a few builds back: a second request for a session already being processed
gets the running job rather than starting a rival over the same frames.

`TIMEOUT` was measured from the start of processing, so a long recording on a
busy server hit a five-minute wall while it was still working. It measures the
gap since the last sign of life now — any change in stage, progress or frame
count resets it — which still catches a job that has genuinely stopped, and no
longer throws away one that has not.


### 2026-08 — The silent gap where the picker used to be

Still three taps to start a stitch, and after the alert was removed, no longer
any explanation for them. That last part is what gave it away: nothing was
failing. There was no error to report because there was no error.

`launchImageLibraryAsync` resolves only once iOS has finished exporting the
chosen recording, and the picker dismisses well before that. In between, the
app is doing nothing and `stage` is still `"idle"` — so the start screen slides
back into view with the pick button on it, exactly as though the tap had
missed. Tap it again, and a second export starts behind the first. Three taps,
and the third one appearing to work is only the first one finishing.

Every theory before this assumed something was throwing. Nothing was.

There is now a `"preparing"` stage, entered *before* the picker is presented so
the screen underneath has already changed by the time it slides away, and a
re-entry guard so a second pick cannot start on top of the first. The guard
clears in a `finally`: a path that forgets to clear it would leave the button
dead for the rest of the session, which is worse than the bug being fixed.


### 2026-08 — Three symptoms, one leaked interval

Reported as three bugs: the phone vibrating without stopping once a result
appeared, "Process Another Video" returning the reader straight to the result
they had just left, and a recording that needed picking three times before
anything happened.

One line explains the first two.

    pollRef.current = setInterval(...)

Assigning over a live `pollRef` loses the handle to the interval it replaces.
That poll runs forever, finds the job `Complete` every 500ms, and each tick
fires the success haptic — the endless vibration — and sets the stage back to
`complete`, which is why leaving the result screen bounced straight back to it.
`pollProgress` now clears before it starts.

The second poll came from the retry added a build earlier. It re-ran the whole
chain — read *and* upload — when only the read was worth attempting twice, so a
recovered recording uploaded and polled a second time. Only the read is retried
now, and the upload sits outside it.

The third symptom was the recovery path itself. A failed export loses the
asset, so retrying meant re-opening the picker: an alert, a second selection,
and a picker presented while the alert was still dismissing — which iOS drops,
so the second pick did nothing and a third was needed. The transcode that
dance was avoiding is now simply done up front with `HighestQuality`. The
frames get downscaled to thumbnails anyway, so the quality it costs is quality
the app discards, and the alert and the second selection are gone with it.


### 2026-08 — The shortcut goes, and the access warning moves earlier

"Use Latest Recording" is gone. One button now, and it opens the picker —
which is what everyone expects from an app that wants a video, and what the
secondary "Pick from Library" button was already offering underneath it.

Removing it also removes where several of this week's failures lived. The
shortcut read the library itself through `MediaLibrary`, and that is the only
reason limited photo access stayed invisible for so long: under "Selected
Photos" the query returns *only* the ticked assets, so the newest recording it
could see was always one the app was allowed to read. The conflict could not
occur. Adding the fallback to the system picker is what made it reachable —
PHPicker shows the whole library whatever the app has been granted — so the
failure was not old and newly surfaced, it was newly built.

The limited-access warning now comes before the picker rather than after a
recording has been chosen. It says the picker will show everything and that
recordings outside the selection cannot be read, and offers Settings.
Continuing is a real option: a recording inside the selected set works, and
someone who deliberately shares a few photos with an app should not have to
widen that to use it. Once per launch — a warning on every pick is noise.


### 2026-08 — Trimmed recordings, and a fast path that cannot carry them

`PICK · PHPhotos-3164`, on a recording sitting on the device, with full photo
library access. Not iCloud, not limited access — both were checked and both
were wrong guesses. The answer was in expo-image-picker's own iOS source:

```swift
if options.videoExportPreset == .passthrough, let assetId = ... {
  let resource = resources.first(where: { $0.type == .fullSizeVideo })
              ?? resources.first(where: { $0.type == .video })
  try await PHAssetResourceManager.default().writeData(for: resource, ...)
```

`passthrough` is the default, so this path is always taken, and it prefers
`fullSizeVideo` — the *rendered* resource, which exists precisely when a
recording has been trimmed or edited. The comment directly above it says as
much: an adjusted asset makes the photo service re-render a temporary file, and
this fast path exists to avoid that.

Screen recordings get trimmed constantly. A library where some videos work and
others do not is exactly what that looks like from inside the app.

Any preset other than `passthrough` skips the fast path and takes the slower
route that renders the adjustment properly. That is only worth paying for once
the quick one has failed, so the pick is retried with `HighestQuality` — after
asking, because silently reopening a picker someone just used reads as the app
having lost their choice.

Three wrong diagnoses preceded this one, and the difference was not cleverness:
the first two were guesses about a black box, and this one came from reading
what the library actually does.


### 2026-08 — PICK, and what the code line bought

The error code shipped in the previous build and answered the question in one
screenshot: `PICK · PHPhotos-3164`. `PICK` means `launchImageLibraryAsync`
itself threw, before the app held a recording at all — not the extraction, not
the upload, and not iCloud, which the reader had already ruled out by opening
the file in Photos and watching it play instantly.

Three builds went into the wrong calls for want of that one line.

The picker failing to export an asset that exists locally points at what the
app is allowed to read rather than at the file. `granted` is `true` for
"Selected Photos" as well as "All Photos", and the app treated the two as the
same thing. Under limited access it may only read the recordings the user
ticked — and a library where some videos work and others do not is exactly what
that looks like from inside the app.

`accessPrivileges` is now read alongside `granted`. When it is `limited`, the
failure says so and names the setting to change instead of offering a generic
apology, and carries `PICK-LTD` so the next report distinguishes the two.

`videoMaxDuration` is dropped from the picker call. It applies to camera
recording, not to picking from the library, so it never did anything here.


### 2026-08 — The iCloud diagnosis was wrong

The message said the recording was probably still in iCloud. It was checked
against a failing video in Photos: no cloud badge, no download, plays
instantly. The file is on the device, and the app was confidently telling
people something untrue about their own library.

So the message now states only what is known — the photo library would not hand
the file over — and offers iCloud as one possibility rather than the diagnosis.

The deeper mistake was hiding Apple's error number. `readableMediaError` was
written to keep `PHPhotosErrorDomain error 3164` off a paying user's screen,
which is right, but it dropped the number entirely — and that number is the one
thing that identifies which failure this is. A build cycle went into guessing
what the sentence had erased.

`technicalErrorCode` puts it back where it belongs: the sentence stays
readable, and the identifier goes on the small grey code line next to the step
that failed, as `READ · PHPhotos-3164`. That is what a support code is for.


### 2026-08 — Fetch the recording rather than asking the reader to

Build 8 still failed on some recordings and not others, with the message saying
the video might be in iCloud. That message was most likely correct. The picker
has no iCloud option — nothing in `ImagePickerOptions` says "fetch this from
the network first" — so a recording that is not on the device can come back as
a file the app cannot read, and the advice was to go and open it in Photos by
hand.

`MediaLibrary` does have the option, and the picker returns an `assetId` that
`MediaLibrary` accepts as an `AssetRef`. So a read failure now retries through
PhotoKit with the download switched on, and only reports failure if that also
comes back empty. The reader is told what is happening while it runs, because
a silent wait on a slow connection is its own bug.

**Every failure screen now carries a short error code.** Two builds went into
fixing the wrong call, and the reason is that a screen naming no step looks
identical however it got there: the first attempt guarded one call out of four
and was indistinguishable in a screenshot from having changed nothing. PICK,
READ, READ2, AUTO-UPLOAD, UPLOAD, TIMEOUT and SERVER each name where the app
gave up. It costs the reader a line of grey text and removes a whole class of
guesswork.


### 2026-08 — Two jobs, one session, and a race to delete each other's frames

A push notification reached a lock screen reading:

    Stitching failed: Input file is missing:
    /tmp/scrollstitch-sessions/mt8xbwlmss701niv/00000_00025

A job deletes its input frames when it finishes. Correct for one job, fatal for
two: the first to finish removes the files the second is still reading, and
Sharp reports it as a missing path — naming a frame the reader never saw, in a
session that was intact when the run began.

Two runs over one session is not hypothetical. The client posts to
`/api/process-frames` once, but a POST whose connection drops *after* the
server accepted it can be retried by the networking layer underneath, and the
retry is indistinguishable from a fresh request. The same evening produced
`fetch failed: The network connection was lost` two minutes after an unrelated
failure, on 5G, which is exactly the condition that produces one.

`sessionJobs` now records which job owns a session's frames. A second request
for a session already being processed gets the running job's id instead of
starting a rival over the same files, which is both the safe answer and the
true one — there really is a job, and it really is running.

The second fix is that the path was ever sent. `readableProcessingError` keeps
Sharp's message in the server log, where the session id and frame number are
precisely what is wanted, and sends the reader something in terms of what they
did. Writing its tests caught the same hole found in `readableMediaError` a day
earlier: an object with no `message` stringifying to `[object Object]`.


### 2026-08 — The fallback covered one step out of four

The previous entry added a fallback to the system picker and it did not fire.
The build reached TestFlight, the raw PhotoKit string was gone — so the new
error copy was live — and the same dead end appeared under a friendlier
sentence.

The fallback was wrapped around exactly one call, `getAssetInfoAsync`, because
that was the call named in the error. Three others in the same path talk to
PhotoKit and can fail the same way: the permission request, the library query,
and the frame extraction that follows. Any of them threw straight past the
fallback into the outer catch, which does nothing but render the message.

`resolveLatestRecording` now owns the whole shortcut and returns null for every
failure in it rather than throwing. Null means "the shortcut cannot deliver",
and there is one answer to that: open the picker. Extraction is handled
separately, because a file that resolves and still will not open is also the
picker's problem, while a failed upload is not — reopening a picker there would
discard work the user already waited through.

The reason this took two attempts is in `extractFramesFromVideo`. Every frame
was wrapped in `catch {}`. Dropping a frame that will not render is correct;
dropping the reason is not, and when a video cannot be read at all, every
iteration throws the same diagnosis and all of them were discarded. Total
failure now rethrows the first one, so the cause survives to the screen instead
of arriving as a count of zero.


### 2026-08 — A PhotoKit error reached a paying user

The first thing someone saw after subscribing on the App Store build was:

    Processing Failed
    The operation couldn't be completed. (PHPhotosErrorDomain error 3164.)

Two separate failures, one screen.

The shortcut behind the main button takes the newest video in the library and
opens it directly. Under "Optimise iPhone Storage" that recording lives in
iCloud with no file on the device, so PhotoKit has to fetch it first — and on a
weak connection the fetch fails. There was no flag to turn on:
`shouldDownloadFromNetwork` already defaults to true, so the download had been
attempted and had lost.

The dead end was the bug. A failed fetch left the screen with nothing to do,
and the fallback made it worse: `info.localUri || asset.uri` handed the
thumbnailer a `ph://` reference, which is an identifier rather than a file.
Failing to resolve an asset now falls through to the system picker, which
downloads iCloud assets itself with Apple's progress UI and lets the user point
at the recording they meant rather than whatever they filmed last. An empty
result does the same, since "no videos" and "Selected Photos access that
excludes the recording" are indistinguishable from here.

The second failure is that the raw error was ever rendered. `readableMediaError`
in `lib/mediaErrors.ts` matches on the error domain — the numeric codes vary and
Apple documents almost none of them — and says the useful thing instead: the
recording is probably still in iCloud. Writing the test for it turned up one
more path to the same screen: an object with no `message` stringified to
`[object Object]`.


### 2026-08 — The weekly identifier was spent too, and deleting it changed nothing

`scrollstitch_pro_weekly` was also created in App Store Connect as an in-app
purchase rather than an auto-renewable subscription. It was never submitted for
review and the product was deleted — and App Store Connect still answers *"The
Product ID you entered is already being used by another subscription"* on
re-creation.

That is the part worth keeping: **deleting a product does not release its id.**
The annual identifier was lost because it had been submitted, which made it
easy to believe submission was the trigger. It is not. An identifier is spent
the moment it is used. There is no state a product can be put into that gives
it back.

The weekly plan is `scrollstitch_pro_weekly_v2` now. The suffix is not a
version scheme, it is a scar; a product id is never shown to anyone, so the
only thing that matters is that it is free and that it matches RevenueCat
exactly.

Retiring the old one made the delete check dangerous in a way it had not been
before. The live weekly identifier is the retired one plus a suffix, so the
prefix pattern that had been fine until now — `/^scrollstitch_pro_weekly/` —
matches both, and the seed would have created the weekly product and deleted it
in the same run, taking out the plan the free trial funnels into. The check is
an exact match on the identifier with Play's `:basePlanId` suffix stripped, and
the test that fails on the prefix version is in `scripts/__tests__`.

### 2026-08 — Product ids did not live in exactly one file after all

The note below claims the rename cost nothing in the app because the client
never names a product. That was wrong, and worth correcting rather than
quietly deleting: `lib/revenuecat.tsx` decided whether someone was already on
the annual plan by asking whether their active product id *contained* the word
`annual`.

Moving the plan to `scrollstitch_pro_yearly` removed that substring from the
identifier of the very plan the check was looking for. It answered false for
every annual subscriber, and the day-3 win-back offer — which exists to move
weekly subscribers up to annual — would have been shown to people already
paying for annual, offering to sell them what they had.

Nothing caught it, because a substring test against a literal has nothing to
typecheck and the identifier it was reading is chosen in a different file. The
check now compares against the product behind the annual package, so the two
move together by construction. Lifetime buyers are excluded on the same
grounds: there is nothing above their plan to upsell.

The comparison also has to survive Play writing subscriptions as
`productId:basePlanId` and reporting them both ways, so it matches on the part
before the colon. It lives in `lib/planIdentity.ts` with tests, including the
one that would have caught this: the same plan, spelled two ways, sharing no
useful substring.

### 2026-08 — The lifetime product was created with a type no store accepts

With the naming collision out of the way the seed got as far as the lifetime
product and stopped there: `Allowed product types for Test Store:
'subscription', 'consumable' and 'non_consumable'`. The script was sending
`one_time`.

`one_time` is the umbrella the API *reports* such a product under — it is in
the product type enum, and there is a `one_time` field on a returned product —
but it is not a type a store accepts when creating one. A lifetime unlock is
bought once and kept: a **non-consumable**, in App Store Connect, in Play, and
on the Test Store alike. That is what the seed sends now.

Finding this took a round trip it should not have. The script threw
`Failed to create Test/Lifetime product` and discarded the API's own response,
so the message naming the offending field had to be recovered by repeating the
call by hand. Product creation errors now carry the store's reply.

### 2026-08 — The seed could not create the plan that replaced the old one

Moving the annual plan to `scrollstitch_pro_yearly` changed the constant but
never reached RevenueCat: the seed run failed on the first new product with
`resource_already_exists`, and left the project exactly as it was.

The cause was ordering. A product's display name must be unique within its app,
and the new yearly product wanted `ScrollStitch Pro Annual` — the name still
held by the product it was replacing, which the retirement pass does not remove
until the end of the same run. Creation came first, so it collided every time.
Because the run died there, nothing after it happened either: no yearly
product, no lifetime product, no package swap, no retirement. That is why the
lifetime tier was missing from the offering too — one failure, two features
silently absent, and a script that reported the error and then exited.

Retired products are now renamed out of the way before anything is created.
Renaming is the only mutation RevenueCat allows on an existing product, which
also makes it the only fix that survives the case the retirement pass already
anticipated: a product with recorded transactions cannot be deleted, so
deleting it first would not have been enough. A test purchase is all it takes
to make a product permanent, and the name would have stayed occupied on every
future run.

The pattern that decides what gets retired now lives in
`scripts/retiredProducts.ts` with tests in `scripts/__tests__`. It governs
deletion and the two mistakes are not symmetric — keeping a dead product leaves
clutter in a dashboard, deleting a live one takes a plan out of the paywall —
so it is checked against every identifier the project has used, including the
one-word gap between `…_pro_annual` and `…_pro_yearly`.

### 2026-08 — The annual plan needs a new identifier

`scrollstitch_pro_annual` was created in App Store Connect as a non-consumable
in-app purchase rather than an auto-renewable subscription, and submitted for
review. A submitted product cannot be deleted, and Apple never releases a
product id for reuse, so that identifier is spent.

The annual plan is now `scrollstitch_pro_yearly` (`…_yearly:yearly` on Play).
The retirement pass, which already removed the products left over from the
previous app name, also detaches and deletes the abandoned annual ones. Its
pattern is unit-checked against every identifier in play, because it governs
deletion and matching one character too loosely would take out a live product.

Worth recording why this cost almost nothing in the app: **product ids appear
in exactly one file.** The client never names a product — it asks for packages
(`$rc_weekly`, `$rc_annual`, `$rc_lifetime`) and lets RevenueCat resolve them.
Changing a store identifier is one constant and one script run, with no app
change and no rebuild.

The type mattered as much as the id. A non-consumable annual would not renew,
could carry no introductory offer — so no three-day trial — and would have sold
permanent access for $29.99 beside a $79.99 lifetime.

### 2026-08 — A lifetime tier, as a price anchor

Weekly and annual gave the paywall no top end, so the annual was the dearest
thing on it. A one-time purchase above it makes the annual read as the sensible
middle instead.

- `scrollstitch_pro_lifetime` at $79.99, attached to the same `pro`
  entitlement, in a `$rc_lifetime` package. It is a **one-time** product, not a
  subscription: the seeding script's product helper now takes a null duration
  to mean that, and picks the `one_time` type accordingly. In App Store Connect
  it is a **Non-Consumable**, outside the subscription group.
- The paywall shows whichever plans the store returns, so it picked up the
  third automatically. The chips carry the period on a second line, which is
  what makes three fit across.
- Nothing describes the lifetime plan as renewing. Its legal line says it is a
  one-time purchase with nothing to cancel, the call to action says "Buy once",
  and the trial copy stays on the weekly plan where the trial actually exists.
  Terms that do not match what is sold are a review rejection.

Prices can be changed later; product identifiers cannot.

### 2026-08 — RevenueCat caught up with the app

The plan with no price was not a client bug. Inspecting the live project
showed it predated both the rename and the move from monthly to weekly:

```
project    ScrollSnap
apps       ScrollSnap iOS / Android — bundle and package com.myapp
products   scrollsnap_pro_monthly, scrollsnap_pro_annual
packages   $rc_monthly, $rc_annual
```

The client asks for `$rc_weekly`. No such package existed, so the lookup
returned nothing and the chip rendered with an empty price, while `$rc_annual`
resolved and showed one. The bundle id mattered more: `com.myapp` against
`com.scrollstitch` in `app.json` meant *no* product would have resolved on a
real build, so both plans would have gone blank as soon as testing left the
test store.

Seeding now corrects existing apps rather than only creating missing ones —
name, bundle id, package name — and retires the previous naming. Store
identifiers cannot be edited (RevenueCat allows only a product's display name
to change), so old products are detached and deleted rather than renamed. One
survives deletion because it has recorded transactions, which a single test
purchase earns; it is detached from every package and from the entitlement, so
it is invisible to the app.

Attaching products to a package clears conflicting ones first. RevenueCat
permits one product per app per package, so leftovers from the old naming did
not sit harmlessly beside the new products — they blocked them, and the attach
failed. The first run then verified by *counting* attachments, passed on three
stale products, and the cleanup detached them afterwards, leaving `$rc_annual`
empty: the same symptom, moved to the other plan. Verification now checks the
expected products are present by identity, and the cleanup no longer touches
package attachments at all. Re-running repairs a broken state instead of
requiring a pristine one.

Nothing existed in App Store Connect yet, so no identifier was locked. After
those subscriptions are created the ids are permanent.

Still manual: the project's own name. The RevenueCat API exposes no operation
to rename a project, so it has to be changed in the dashboard.

### 2026-08 — Tell me when it's done

Jobs take long enough that people want to put the phone down. A *local*
notification cannot deliver that: iOS suspends the app's JavaScript within
seconds of backgrounding, so nothing is running at the moment the server
finishes — exactly the moment worth reporting. The notice therefore comes from
the server.

- The client registers an Expo push token when a job starts, not at launch —
  asking for notification permission means something when there is a wait to be
  told about. The progress view then says the app can be left.
- The server takes the token with the job and pushes on completion, including
  the frame count and any gaps. Failures push too: someone who walked away
  should not come back to a spinner that quietly stopped.
- Every part is best-effort. A denied permission, a simulator, a missing key —
  all resolve to "no notification", never to a failed stitch. The token is
  validated against the Expo token format before it reaches an outbound
  request, and a test asserts a malformed one costs the user nothing.

**Two setup steps are still required, and until both are done the app simply
runs without notifications:**

1. `eas init` — writes `extra.eas.projectId` into `app.json`. Expo cannot mint a
   push token without it. The code names this exact cause in the log.
2. An APNs key in EAS credentials (`eas credentials`), so Apple will deliver.

`expo-notifications` is a native module, so this needs a new build — it cannot
ship as an OTA update.

### 2026-08 — Faster jobs, an honest countdown, and a paywall that only offers what exists

From a real recording: the time estimate opened at 52s, climbed to 1m47s, then
sat still before finishing abruptly; the run felt slower than the previous one;
and the weekly plan showed no price.

**Processing is ~40% faster with byte-identical output** (12.3s → 7.3s for 80
frames on the bench), from two changes:

- The banded NCC walked the pixels four times per candidate overlap — twice for
  the global score and twice more across the bands. The bands tile the global
  range exactly and pixels are integers, so accumulating raw co-moments once per
  band and summing them yields the same global score for free. One pass instead
  of four; `select` fell 30%. Checked against the old implementation over 2394
  cases including near-flat and dark low-contrast windows, where the
  computational formula is most at risk: worst deviation 1.2e-14, no threshold
  decision changed.
- The PDF is built on first request rather than during the job. It was a third
  of the wait, spent on a file most runs never open. The URL is unchanged, so
  the client did not have to change; concurrent requests share one render.

**The time estimate now starts high and only counts down.** `elapsed / progress`
assumes progress advances evenly in time; it does not, so the first figure was
far too low and rose as reality asserted itself. Now: a deliberately pessimistic
prior from the frame count, blended into the measured rate as evidence
accumulates, and a displayed figure that never increases. While a slow stage
reports nothing the countdown keeps moving, at a reduced rate so it does not
spend the whole budget early. On the reported trace it opens at 2m10s against a
1m47s job and falls monotonically, where the old model oscillated 50s → 1m20s →
55s → 1m10s. The model is pure and unit-tested (`lib/eta.ts`), including a test
asserting the naive version really does open under a minute on that trace.

Stage weights in `STAGE_SPANS` are now shares of measured wall time rather than
equal slices, which is what makes progress advance evenly enough to extrapolate
from.

**The paywall only offers plans the store returned.** RevenueCat omits a package
whose product it cannot fetch, and the UI rendered it anyway — a plan priced "…"
beside a button that could not be pressed. Missing plans are now dropped, and an
offering with no usable plan shows the existing retry state. The seeding script
no longer treats a failed product attach as success: it verifies afterwards and
fails loudly, since that silent skip is the most likely way a package ends up in
an offering with nothing behind it.

**`npm run typecheck` was failing on any machine that had run Expo.** Expo writes
an ambient `expo-env.d.ts` on first bundle which pulls in the DOM lib; Node's and
the DOM's `setInterval` then merge as overloads, the DOM one wins, and
`.unref()` stops type-checking. Earlier clean runs simply predated that file
existing. Both timers now go through one helper that names the intent.

### 2026-08 — Pin out two critical advisories

Installs began failing in the Replit workspace: its package firewall returned
403 for `tar` and `shell-quote`, so `node_modules` came out incomplete and the
dev bundler could not resolve `@expo-google-fonts/archivo`. The firewall was
right — `npm audit` reports the same two advisories.

- `tar@7.5.6` → `7.5.22` (GHSA-34x7-hfp2-rc4v, hardlink path traversal) and
  `shell-quote@1.8.3` → `1.10.0` (GHSA-w7jw-789q-3m8p). Both arrive
  transitively, via `@expo/cli` and `react-devtools-core`, so they are pinned
  through `overrides` rather than a direct dependency.
- Critical advisories go from 2 to 0. The remaining 51 are pre-existing and
  untouched: `npm audit fix --force` would move Expo and React Native
  themselves, which is not a change to make in passing.
- Verified beyond the unit suite by running the Expo static export — the step
  the deploy runs first, and where `tar` is actually used. It completes and
  bundles the Archivo fonts.

### 2026-08 — Build identity survives deployment

`GET /api/health` reported `commit: "unknown"` in production, because it reads
the SHA from `.git` and deployment images strip it. The one field meant to
reveal a stale deploy was blank exactly where staleness is invisible.

- `npm run server:build` now writes `server_dist/build-info.json` recording the
  commit the bundle came from; the endpoint falls back to it when `.git` is
  absent. Verified by booting the production bundle in a directory with no git
  metadata: `commit` reads the real SHA instead of `"unknown"`.
- If a build runs somewhere without git metadata, it keeps any commit already
  recorded rather than overwriting it with `"unknown"` — a wrong-but-confident
  identity is worse than none.
- `server_dist/index.js` is a build artifact that is committed and is what
  `npm run server:prod` runs, so it can fall behind `server/` silently. A test
  now asserts every route the source registers is present in the bundle.
  Comparing bytes against a fresh build was rejected: esbuild is only present
  transitively, so its version is not pinned.

### 2026-08 — Chunked upload

Recovered from work that lived only in the Replit workspace and reimplemented
on this history, with tests.

At 100 ms sampling a recording yields hundreds of frames, and posting them in
one multipart body is tens of megabytes in a single request — one dropped
connection loses the whole recording with nothing to resume from.

- `POST /api/upload-chunk?sessionId=…&chunkIndex=…` stages a batch under a
  session directory; `POST /api/process-frames?sessionId=…` then runs the job
  against the staged frames with no body at all. The single-shot path is
  untouched, so an older client keeps working.
- Staged names are zero-padded by batch and sequence, because `readdir` gives
  lexical order and the frames must stitch in capture order.
- Session ids are sanitised before touching the filesystem; abandoned sessions
  are swept hourly, and a finished job removes its own directory.
- The client uploads in batches of 25 and reports real progress per batch
  rather than a simulated tick.

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
