repo: andreash-hash/Scrollstitch
branch: main
path: (whole repo — read for reference, not copied)

## Last sync
date: 2026-08-10T11:51:05Z

### Updated in this project
- Read app/index.tsx (main stitch flow), app/onboarding.tsx (onboarding + paywall), constants/colors.ts, contexts/AppContext.tsx, README.md for pipeline/product context.
- Built "ScrollStitch App.dc.html": a full redesign of the mobile app under the bound Modernist design system (flat red/white, Archivo, square corners) — replaces the source's dark teal/gradient UI.
- Not a 1:1 UI port — colors, type and component shapes intentionally diverge to match Modernist; product flow (onboarding → paywall → upload → processing → result → export → library → settings) follows the source.

## Screen map
| Project screen | Repo source |
| --- | --- |
| Onboarding + paywall slides | app/onboarding.tsx |
| Upload / idle, processing, result, export | app/index.tsx |
| Settings (sensitivity, output quality, subscription) | app/index.tsx (settings panel), contexts/AppContext.tsx |
| Library (new addition, not in source) | — |
