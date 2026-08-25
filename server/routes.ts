import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import multer from "multer";
import {
  validateFrames,
  deduplicateFrames,
  detectAndRemoveStickyHeaders,
  selectFrames,
  stitchFrames,
  generatePreviewImage,
  generatePdf,
  type Seam,
} from "./video-processor";

import { readableProcessingError } from "./processingErrors";

const privacyPolicyHtml = fs.readFileSync(
  path.resolve(process.cwd(), "server", "templates", "privacy-policy.html"),
  "utf-8"
);

// App Review requires a working support URL, and it must not be the privacy
// policy over again.
const supportHtml = fs.readFileSync(
  path.resolve(process.cwd(), "server", "templates", "support.html"),
  "utf-8"
);

/**
 * Build identity, resolved once at startup.
 *
 * A deployment silently serving old code is invisible until something looks
 * wrong in an unrelated place — a stale privacy policy naming the previous app
 * is how this was actually caught. One endpoint makes it a five-second check.
 */
const BUILD_INFO = (() => {
  let name = "unknown";
  let version = "unknown";
  try {
    const appJson = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "app.json"), "utf-8")
    );
    name = appJson.expo?.name ?? "unknown";
    version = appJson.expo?.version ?? "unknown";
  } catch {
    // Deployment bundles may omit app.json — the other fields still identify it.
  }

  // Read the SHA straight from .git rather than shelling out; deployments that
  // strip .git simply report "unknown" instead of failing to boot.
  let commit = "unknown";
  try {
    const gitDir = path.resolve(process.cwd(), ".git");
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf-8").trim();
    if (head.startsWith("ref: ")) {
      const ref = head.slice(5).trim();
      try {
        commit = fs.readFileSync(path.join(gitDir, ref), "utf-8").trim();
      } catch {
        // Ref is packed rather than loose
        const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf-8");
        const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
        if (line) commit = line.split(" ")[0];
      }
    } else {
      commit = head;
    }
  } catch {
    // No git metadata available
  }

  if (commit === "unknown") {
    // Deployment images strip .git, which is precisely where a stale build is
    // hardest to spot. `npm run server:build` records the SHA next to the
    // bundle so the deployed server can still name the code it is running.
    try {
      const info = JSON.parse(
        fs.readFileSync(
          path.resolve(process.cwd(), "server_dist", "build-info.json"),
          "utf-8"
        )
      );
      if (typeof info.commit === "string" && info.commit) commit = info.commit;
    } catch {
      // Neither git metadata nor a recorded build — "unknown" is honest.
    }
  }

  return {
    name,
    version,
    commit: commit === "unknown" ? commit : commit.slice(0, 7),
    startedAt: new Date().toISOString(),
    privacyPolicyMentions: /ScrollSnap/i.test(privacyPolicyHtml)
      ? "ScrollSnap"
      : "current",
  };
})();

const uploadDir = path.join(os.tmpdir(), "scrollstitch-uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 100 * 1024 * 1024 },
});

// ── Chunked upload ─────────────────────────────────────────────────────────
// At 100ms sampling a recording can yield hundreds of frames, and posting them
// in one multipart body is tens of megabytes in a single request — the kind
// that dies on a flaky mobile connection with nothing to resume from. Clients
// may instead stage frames in batches under a session id, then trigger
// processing with an empty request. The single-shot path still works.
const sessionsDir = path.join(os.tmpdir(), "scrollstitch-sessions");
fs.mkdirSync(sessionsDir, { recursive: true });

/** Session ids land in a filesystem path, so allow only safe characters. */
function sanitiseSessionId(raw: unknown): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
}

const chunkStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const id = sanitiseSessionId((req as Request).query.sessionId);
    if (!id) return cb(new Error("Missing sessionId"), "");
    const dir = path.join(sessionsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, _file, cb) => {
    // Frames must stitch in capture order, and readdir gives us lexical order —
    // so the batch index and position within it are both zero-padded.
    const chunk = String((req as Request).query.chunkIndex ?? "0")
      .replace(/\D/g, "")
      .padStart(5, "0");
    const seq = String(chunkSeq++).padStart(5, "0");
    cb(null, `${chunk}_${seq}`);
  },
});
let chunkSeq = 0;

const chunkUpload = multer({
  storage: chunkStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
});

/** Abandoned sessions (app closed mid-upload) would otherwise fill the disk. */
everyMs(() => {
  try {
    for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(sessionsDir, entry.name);
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > 60 * 60 * 1000) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        // Raced with another cleanup — nothing to do
      }
    }
  } catch {
    // Sessions dir vanished; it is recreated on the next upload
  }
}, 15 * 60 * 1000);

interface JobState {
  stage: string;
  progress: number;
  /** Human-readable sub-progress, e.g. "12/80 frames". */
  detail?: string;
  result?: unknown;
  error?: string;
  createdAt: number;
}
const jobProgress = new Map<string, JobState>();

/**
 * Which job owns a session's staged frames, so a session is never processed
 * twice at once.
 *
 * A job deletes its input frames when it finishes. That is correct for one job
 * and fatal for two: the first to finish removes the files the second is still
 * reading, and Sharp reports it as "Input file is missing" — a path the caller
 * never chose, naming a frame they never saw, for a session that was fine when
 * the run began.
 *
 * Two runs over one session is not a hypothetical. The client posts once, but a
 * POST whose connection drops after the server accepted it can be retried by
 * the networking layer underneath, and the second request looks exactly like a
 * fresh one. Handing back the job already running is both the safe answer and
 * the honest one.
 */
const sessionJobs = new Map<string, { jobId: string; frameCount: number }>();

function updateJob(id: string, update: Partial<JobState>) {
  const existing = jobProgress.get(id);
  if (existing) {
    Object.assign(existing, update);
  }
}

everyMs(() => {
  const now = Date.now();
  for (const [id, job] of jobProgress.entries()) {
    if (now - job.createdAt > 30 * 60 * 1000) {
      jobProgress.delete(id);
    }
  }
}, 5 * 60 * 1000);

/**
 * Run background housekeeping on a timer that never holds the process open.
 *
 * Expo writes an ambient expo-env.d.ts the first time the app is bundled, and
 * it pulls in the DOM lib. Node's and the DOM's global `setInterval` then merge
 * as overloads and the DOM one — returning `number`, with no `unref` — wins, so
 * a bare `setInterval(...).unref()` fails to type-check on every machine that
 * has ever run Expo. Importing from "node:timers" does not help: that module
 * re-exports the same global binding. Hence the cast, in one place.
 */
function everyMs(fn: () => void, ms: number): void {
  const timer = setInterval(fn, ms) as unknown as NodeJS.Timeout;
  timer.unref?.();
}

/**
 * Tell a device its stitch is ready.
 *
 * The client cannot do this itself: iOS suspends its JavaScript seconds after
 * the app is backgrounded, so nobody is listening at the moment the job
 * finishes. Hence a push addressed to a token the client registered when it
 * started the job.
 *
 * Best-effort by design — a job that succeeded must not be reported as failed
 * because a notification could not be delivered.
 */
async function sendCompletionPush(
  token: string,
  body: string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        to: token,
        title: "ScrollStitch",
        body,
        sound: "default",
        channelId: "stitch-complete",
        data,
      }),
    });
    if (!res.ok) {
      console.warn(`Push send failed: ${res.status} ${await res.text()}`);
      return;
    }
    // Expo reports per-message failures (e.g. DeviceNotRegistered) in the body.
    const payload = (await res.json()) as { data?: { status?: string; message?: string } };
    if (payload.data?.status === "error") {
      console.warn(`Push rejected: ${payload.data.message}`);
    }
  } catch (err) {
    console.warn("Push send threw:", err);
  }
}

/** An Expo push token, or "" if it is not one. Never trust a query parameter. */
function validPushToken(raw: string): string {
  return /^Expo(nent)?PushToken\[[^\]\s]{1,128}\]$/.test(raw) ? raw : "";
}

/** Express 5 types query/param values as string | string[] — take the first. */
function firstString(value: unknown): string {
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" ? value : "";
}

const outputDir = path.join(os.tmpdir(), "scrollstitch-output");

// Progress budget per pipeline stage: [start, end] within 0..1.
/**
 * How much of the progress bar each stage owns.
 *
 * These are shares of measured WALL TIME, not equal slices: at 80 frames the
 * stages come in at roughly validate 4%, dedup 14%, sticky 2%, select 58%,
 * stitch 16%, preview 6%. Giving every stage an equal slice is what made the
 * bar sprint and then stall, and made any time estimate derived from it start
 * far too low. Weighted this way, progress advances at a roughly constant rate,
 * so elapsed/progress is a usable prediction of the total.
 *
 * Re-measure with the benchmark before changing these.
 */
const STAGE_SPANS = {
  validate: [0, 0.05],
  dedup: [0.05, 0.18],
  sticky: [0.18, 0.2],
  select: [0.2, 0.78],
  stitch: [0.78, 0.94],
  // 0.94 → 1.0 is the preview downscale, which reports no per-frame progress.
} as const;

export async function registerRoutes(app: Express): Promise<Server> {
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()), ...BUILD_INFO });
  });

  app.get("/privacy", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(privacyPolicyHtml);
  });

  app.get("/support", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(supportHtml);
  });

  // Stage one batch of frames under a session id. Called repeatedly before
  // /api/process-frames is triggered with the same session.
  app.post(
    "/api/upload-chunk",
    chunkUpload.array("frames", 500),
    (req: Request, res: Response) => {
      if (!sanitiseSessionId(req.query.sessionId)) {
        return res.status(400).json({ error: "Missing or invalid sessionId" });
      }
      const files = (req.files as Express.Multer.File[]) ?? [];
      res.json({ received: files.length });
    }
  );

  app.post(
    "/api/process-frames",
    // A session-based request carries no body: skip multer entirely so it does
    // not reject the empty multipart payload.
    (req: Request, res: Response, next) => {
      if (firstString(req.query.sessionId)) {
        req.files = [];
        return next();
      }
      upload.array("frames", 500)(req, res, next);
    },
    async (req: Request, res: Response) => {
      const jobId =
        Date.now().toString() + Math.random().toString(36).substr(2, 9);

      try {
        const sessionId = sanitiseSessionId(req.query.sessionId);
        let framePaths: string[];
        let sessionDir: string | null = null;

        if (sessionId) {
          // A run is already underway over these exact files. Starting a second
          // one would have the two race to delete each other's inputs, so
          // report the one that exists instead.
          const owner = sessionJobs.get(sessionId);
          if (owner && jobProgress.has(owner.jobId)) {
            return res.json({ jobId: owner.jobId, frameCount: owner.frameCount });
          }

          sessionDir = path.join(sessionsDir, sessionId);
          let staged: string[] = [];
          try {
            staged = fs.readdirSync(sessionDir).sort();
          } catch {
            // Session never existed, or the cleanup sweep already removed it
          }
          if (staged.length === 0) {
            return res.status(400).json({
              error:
                "The uploaded frames could not be found. They may have expired — please try again.",
            });
          }
          framePaths = staged.map((f) => path.join(sessionDir!, f));
        } else {
          const files = (req.files as Express.Multer.File[]) ?? [];
          if (files.length === 0) {
            return res.status(400).json({
              error:
                "No frames were received. Record a scrolling screen video and try again.",
            });
          }
          framePaths = files.map((f) => f.path);
        }

        console.log(
          `Received ${framePaths.length} frames for job ${jobId}` +
            (sessionId ? ` (session ${sessionId})` : "")
        );

        const quality = firstString(req.query.quality) === "jpeg" ? "jpeg" : "png";
        const pushToken = validPushToken(firstString(req.query.pushToken));

        jobProgress.set(jobId, { stage: "Processing", progress: 0, createdAt: Date.now() });
        if (sessionId) {
          sessionJobs.set(sessionId, { jobId, frameCount: framePaths.length });
        }
        res.json({ jobId, frameCount: framePaths.length });

        (async () => {
          const tempOutputs: string[] = [];
          try {
            const warnings: string[] = [];
            const stageProgress =
              (stage: string, span: readonly [number, number]) =>
              (done: number, total: number) => {
                const t = total > 0 ? done / total : 1;
                updateJob(jobId, {
                  stage,
                  progress: span[0] + t * (span[1] - span[0]),
                  detail: `${done}/${total}`,
                });
              };

            updateJob(jobId, { stage: "Validating frames", progress: 0 });
            const { valid: validFrames, warnings: validationWarnings } =
              await validateFrames(framePaths, stageProgress("Validating frames", STAGE_SPANS.validate));
            warnings.push(...validationWarnings);
            if (validFrames.length === 0) {
              throw new Error(
                "None of the uploaded frames could be read as images. " +
                  "The recording may be corrupt — please try recording again."
              );
            }
            if (validFrames.length < framePaths.length) {
              console.warn(
                `Job ${jobId}: ${framePaths.length - validFrames.length} corrupt frame(s) skipped`
              );
            }

            updateJob(jobId, { stage: "Removing duplicates", progress: STAGE_SPANS.dedup[0], detail: undefined });
            const uniqueFrames = await deduplicateFrames(
              validFrames,
              stageProgress("Removing duplicates", STAGE_SPANS.dedup)
            );
            console.log(
              `Deduplicated: ${validFrames.length} -> ${uniqueFrames.length} frames`
            );

            updateJob(jobId, { stage: "Removing sticky headers", progress: STAGE_SPANS.sticky[0], detail: undefined });
            const { paths: cleanedFrames, headerHeight, footerHeight } =
              await detectAndRemoveStickyHeaders(uniqueFrames);
            if (headerHeight > 0 || footerHeight > 0) {
              console.log(`Removed sticky: header=${headerHeight}px, footer=${footerHeight}px`);
            }
            // Cropped copies are per-job intermediates — clean them up at the end.
            tempOutputs.push(...cleanedFrames.filter((p) => !framePaths.includes(p)));

            updateJob(jobId, { stage: "Selecting frames", progress: STAGE_SPANS.select[0], detail: undefined });
            const selection = await selectFrames(
              cleanedFrames,
              stageProgress("Selecting frames", STAGE_SPANS.select)
            );
            warnings.push(...selection.warnings);
            if (selection.paths.length === 0) {
              throw new Error(
                "No stitchable frames were found in the recording. Please try again."
              );
            }
            console.log(
              `Selected ${selection.paths.length}/${cleanedFrames.length} frames, ${selection.gapCount} gap(s)`
            );

            fs.mkdirSync(outputDir, { recursive: true });
            updateJob(jobId, { stage: "Stitching frames", progress: STAGE_SPANS.stitch[0], detail: undefined });
            // Stitch to a temp path first — the extension depends on the actual
            // encoded format (JPEG output falls back to PNG for very tall images).
            const tmpStitchPath = path.join(outputDir, `${jobId}.stitch.tmp`);
            tempOutputs.push(tmpStitchPath);
            const stitchResult = await stitchFrames(
              selection.paths,
              tmpStitchPath,
              quality,
              selection.seams,
              stageProgress("Stitching frames", STAGE_SPANS.stitch)
            );
            const imgExt = stitchResult.format === "jpeg" ? "jpg" : "png";
            const outputImagePath = path.join(outputDir, `${jobId}.${imgExt}`);
            fs.renameSync(tmpStitchPath, outputImagePath);
            if (quality === "jpeg" && stitchResult.format === "png") {
              warnings.push(
                "The stitched image is too tall for JPEG — it was saved as PNG instead."
              );
            }

            // Downscaled display copy — very tall stitches will not decode on iOS
            let previewUrl = `/api/output/${jobId}.${imgExt}`;
            const previewPath = path.join(outputDir, `${jobId}_preview.jpg`);
            const preview = await generatePreviewImage(outputImagePath, previewPath);
            if (preview.scaled) {
              previewUrl = `/api/output/${jobId}_preview.jpg`;
            }

            // The PDF is NOT built here. It was a third of the job's wall time,
            // spent on an artifact most runs never ask for — saving to Photos
            // uses the image. /api/output builds it on first request instead,
            // so the URL below still works and nobody waits for a file they
            // are not going to open.

            const seamSummary = selection.seams.map((s: Seam, i: number) => ({
              index: i,
              type: s.type,
              overlapPx: s.overlapPx,
              ncc: Math.round(s.ncc * 1000) / 1000,
              nccThreshold: Math.round(s.nccThreshold * 1000) / 1000,
            }));

            updateJob(jobId, {
              stage: "Complete",
              progress: 1,
              detail: undefined,
              result: {
                imageUrl: `/api/output/${jobId}.${imgExt}`,
                previewUrl,
                pdfUrl: `/api/output/${jobId}.pdf`,
                frameCount: framePaths.length,
                uniqueFrames: uniqueFrames.length,
                selectedFrames: selection.paths.length,
                gapCount: selection.gapCount,
                warnings,
                seams: seamSummary,
                dimensions: { width: stitchResult.width, height: stitchResult.height },
              },
            });

            if (pushToken) {
              const pages = selection.paths.length;
              await sendCompletionPush(
                pushToken,
                selection.gapCount > 0
                  ? `Your screenshot is ready — ${pages} frames, ${selection.gapCount} gap${selection.gapCount === 1 ? "" : "s"}.`
                  : `Your screenshot is ready — ${pages} frames stitched.`,
                { jobId, status: "complete" }
              );
            }
          } catch (err) {
            // Log the original — the session id and frame number are exactly
            // what is needed here — and send the reader something they can act
            // on instead.
            console.error(`Processing error (job ${jobId}):`, err);
            const message = readableProcessingError(err);
            updateJob(jobId, { stage: "Error", progress: 0, error: message });
            if (pushToken) {
              // Someone who left the app deserves to hear about a failure too,
              // rather than coming back to a spinner that stopped.
              await sendCompletionPush(pushToken, `Stitching failed: ${message}`, {
                jobId,
                status: "error",
              });
            }
          } finally {
            for (const f of [...framePaths, ...tempOutputs]) {
              try {
                fs.unlinkSync(f);
              } catch {
                // already gone (e.g. tmp stitch file was renamed) — ignore
              }
            }
            if (sessionId) sessionJobs.delete(sessionId);
            if (sessionDir) {
              try {
                fs.rmSync(sessionDir, { recursive: true, force: true });
              } catch {
                // The hourly sweep will collect it
              }
            }
          }
        })();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed.";
        return res.status(500).json({ error: message });
      }
    }
  );

  app.get("/api/progress/:jobId", (req: Request, res: Response) => {
    const job = jobProgress.get(firstString(req.params.jobId));
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json(job);
  });

  // ── Lazy PDF ───────────────────────────────────────────────────────────────
  // Rendering the PDF eagerly cost a third of every job for something most
  // runs never download. It is built on first request instead. Requests that
  // arrive while one is already rendering wait on that same promise rather
  // than starting a second render of the same file.
  const pdfsInFlight = new Map<string, Promise<boolean>>();

  async function ensurePdf(filePath: string): Promise<boolean> {
    if (path.extname(filePath).toLowerCase() !== ".pdf") return fs.existsSync(filePath);
    if (fs.existsSync(filePath)) return true;

    const inFlight = pdfsInFlight.get(filePath);
    if (inFlight) return inFlight;

    const base = filePath.slice(0, -4);
    const source = [".png", ".jpg", ".jpeg"]
      .map((e) => base + e)
      .find((p) => fs.existsSync(p));
    if (!source) return false;

    const job = (async () => {
      try {
        await generatePdf(source, filePath);
        return true;
      } catch (err) {
        console.error(`Lazy PDF generation failed for ${filePath}:`, err);
        return false;
      } finally {
        pdfsInFlight.delete(filePath);
      }
    })();
    pdfsInFlight.set(filePath, job);
    return job;
  }

  app.get("/api/output/:filename", async (req: Request, res: Response) => {
    const filename = path.basename(firstString(req.params.filename));
    const filePath = path.join(outputDir, filename);

    if (!(await ensurePdf(filePath))) {
      return res.status(404).json({ error: "File not found" });
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      ext === ".pdf" ? "application/pdf" :
      ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
      "image/png";

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${filename}"`
    );
    fs.createReadStream(filePath).pipe(res);
  });

  app.get("/api/output-base64/:filename", async (req: Request, res: Response) => {
    const filename = path.basename(firstString(req.params.filename));
    const filePath = path.join(outputDir, filename);

    if (!(await ensurePdf(filePath))) {
      return res.status(404).json({ error: "File not found" });
    }

    const data = fs.readFileSync(filePath);
    const base64 = data.toString("base64");
    const ext = path.extname(filePath).toLowerCase();
    const mimeType =
      ext === ".pdf" ? "application/pdf" :
      ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
      "image/png";

    res.json({ base64, mimeType, filename });
  });

  app.get("/api/crop/:filename", async (req: Request, res: Response) => {
    try {
      const sharp = (await import("sharp")).default;
      const filename = path.basename(firstString(req.params.filename));
      const filePath = path.join(outputDir, filename);

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found" });
      }

      const cropTop = Math.max(0, parseInt(firstString(req.query.top), 10) || 0);
      const cropBottom = Math.max(0, parseInt(firstString(req.query.bottom), 10) || 0);

      if (cropTop === 0 && cropBottom === 0) {
        return res.status(400).json({ error: "No crop values provided" });
      }

      const meta = await sharp(filePath).metadata();
      const origWidth = meta.width ?? 0;
      const origHeight = meta.height ?? 0;
      const newHeight = Math.max(10, origHeight - cropTop - cropBottom);

      const ext = path.extname(filename).toLowerCase();
      const baseName = path.basename(filename, ext);
      const croppedFilename = `${baseName}_crop${ext}`;
      const croppedPath = path.join(outputDir, croppedFilename);

      await sharp(filePath)
        .extract({ left: 0, top: cropTop, width: origWidth, height: newHeight })
        .toFile(croppedPath);

      let previewUrl = `/api/output/${croppedFilename}`;
      const previewFilename = `${baseName}_crop_preview.jpg`;
      const preview = await generatePreviewImage(
        croppedPath,
        path.join(outputDir, previewFilename)
      );
      if (preview.scaled) {
        previewUrl = `/api/output/${previewFilename}`;
      }

      // Same as the main job: the PDF is built by /api/output on first request.
      const pdfFilename = `${baseName}_crop.pdf`;

      res.json({
        imageUrl: `/api/output/${croppedFilename}`,
        previewUrl,
        pdfUrl: `/api/output/${pdfFilename}`,
        dimensions: { width: origWidth, height: newHeight },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Crop failed.";
      console.error("Crop error:", err);
      res.status(500).json({ error: message });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
