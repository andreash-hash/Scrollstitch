# ScrollSnap

A mobile app that converts screen recordings into a single long stitched image or PDF.

## Architecture

- **Frontend**: Expo React Native (SDK 54) with file-based routing via Expo Router
- **Backend**: Express.js server for image processing
- **No database** — processing is stateless, results stored in temp files

## Core Flow

1. User picks a video via "Use Latest Recording" or "Pick from Library"
2. Frames extracted on-device every 300ms using expo-video-thumbnails
3. Client-side deduplication via 16x16 pixel hash comparison (expo-image-manipulator), configurable sensitivity
4. Filtered frames uploaded to server via expo/fetch + expo-file-system File class
5. Server deduplicates frames (perceptual comparison, sharp), removes sticky headers/footers
6. Server stitches unique frames vertically with overlap matching (sharp), PNG or JPEG output
7. Server generates a PDF from the stitched image (pdfkit)
8. Client can save to Photos or share as PDF; crop trimming available via /api/crop endpoint

## Key Files

- `app/index.tsx` — Main single-screen UI with all processing logic, settings, zoom, crop
- `server/video-processor.ts` — Frame deduplication, stitching (PNG/JPEG), and PDF generation
- `server/routes.ts` — API endpoints for frame upload, progress polling, output, crop
- `constants/colors.ts` — Dark theme color palette

## API Endpoints

- `POST /api/process-frames?quality=png|jpeg` — Upload frames, start background processing job
- `GET /api/progress/:jobId` — Poll processing progress
- `GET /api/output/:filename` — Stream output PNG/JPEG/PDF
- `GET /api/output-base64/:filename` — Get output as base64 JSON (used by mobile client)
- `GET /api/crop/:filename?top=N&bottom=N` — Crop top/bottom pixels from a stitched image, returns new image + PDF URLs

## Features

- **Auto-pick latest recording**: Uses expo-media-library to grab the most recent video
- **Sensitivity presets**: Fine (0.85) / Balanced (0.92) / Fast (0.97) similarity thresholds
- **Output quality toggle**: PNG (lossless) or JPEG (compressed) for the stitched output
- **ETA during processing**: Computed from elapsed time vs progress, shown below status text
- **Pinch-to-zoom preview**: iOS native scroll zoom (maximumZoomScale=6) on result image
- **Crop trim controls**: +/- steppers for top/bottom pixel crop, applied via server endpoint

## Important Notes

- expo-file-system v55 (SDK 54) deprecated many legacy APIs. Use `expo-file-system/legacy` for writeAsStringAsync/cacheDirectory/EncodingType
- For native file uploads, use `File` from `expo-file-system` + `fetch` from `expo/fetch`
- Frame extraction happens client-side to avoid large video uploads through proxies
- Server uses sharp for image processing and pdfkit for PDF generation
- ffmpeg is installed as system dependency but not currently used (frame extraction moved to client)

## Dependencies

### Frontend
- expo-image-picker, expo-video-thumbnails, expo-media-library
- expo-sharing, expo-file-system, expo-haptics
- expo-linear-gradient, react-native-reanimated
- @expo/vector-icons, expo-image

### Backend
- sharp (image processing), pdfkit (PDF generation)
- multer (file upload handling)
- ffmpeg (system dependency, installed via nix)
