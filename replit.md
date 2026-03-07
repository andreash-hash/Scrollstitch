# ScrollSnap

A mobile app that converts screen recordings into a single long stitched image or PDF.

## Architecture

- **Frontend**: Expo React Native (SDK 54) with file-based routing via Expo Router
- **Backend**: Express.js server for image processing
- **No database** — processing is stateless, results stored in temp files

## Core Flow

1. User picks a video from their camera roll (expo-image-picker)
2. Frames are extracted on-device using expo-video-thumbnails (every 0.5s)
3. Frames are uploaded to the server via expo/fetch + expo-file-system File class
4. Server deduplicates frames using perceptual image comparison (sharp)
5. Server stitches unique frames vertically with overlap matching (sharp)
6. Server generates a PDF from the stitched image (pdfkit)
7. Client can save to Photos (expo-media-library) or share as PDF (expo-sharing)

## Key Files

- `app/index.tsx` — Main single-screen UI with all processing logic
- `server/video-processor.ts` — Frame deduplication, stitching, and PDF generation
- `server/routes.ts` — API endpoints for frame upload, progress polling, and output retrieval
- `constants/colors.ts` — Dark theme color palette

## API Endpoints

- `POST /api/process-frames` — Upload extracted frames (multipart, field: "frames")
- `GET /api/progress/:jobId` — Poll processing progress
- `GET /api/output/:filename` — Download output PNG/PDF
- `GET /api/output-base64/:filename` — Get output as base64 JSON (used by mobile client)

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
