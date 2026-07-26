# ScrollSnap

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

## Pipeline

`POST /api/process-frames` → validate → dedup → sticky removal → **greedy frame
selection** → stitch → PDF. Progress (stage, percent, frame counter) is polled via
`GET /api/progress/:jobId`; the final result includes per-seam diagnostics
(overlap px, NCC, threshold used) plus any warnings — e.g. scroll-jump "gaps" —
which the client surfaces in the UI.

## CHANGELOG

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
