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

const privacyPolicyHtml = fs.readFileSync(
  path.resolve(process.cwd(), "server", "templates", "privacy-policy.html"),
  "utf-8"
);

const uploadDir = path.join(os.tmpdir(), "scrollsnap-uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 100 * 1024 * 1024 },
});

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

function updateJob(id: string, update: Partial<JobState>) {
  const existing = jobProgress.get(id);
  if (existing) {
    Object.assign(existing, update);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobProgress.entries()) {
    if (now - job.createdAt > 30 * 60 * 1000) {
      jobProgress.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

/** Express 5 types query/param values as string | string[] — take the first. */
function firstString(value: unknown): string {
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" ? value : "";
}

const outputDir = path.join(os.tmpdir(), "scrollsnap-output");

// Progress budget per pipeline stage: [start, end] within 0..1.
const STAGE_SPANS = {
  validate: [0, 0.05],
  dedup: [0.05, 0.2],
  sticky: [0.2, 0.3],
  select: [0.3, 0.55],
  stitch: [0.55, 0.85],
  pdf: [0.85, 0.98],
} as const;

export async function registerRoutes(app: Express): Promise<Server> {
  app.get("/privacy", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(privacyPolicyHtml);
  });

  app.post(
    "/api/process-frames",
    upload.array("frames", 500),
    async (req: Request, res: Response) => {
      const jobId =
        Date.now().toString() + Math.random().toString(36).substr(2, 9);

      try {
        const files = req.files as Express.Multer.File[];
        if (!files || files.length === 0) {
          return res.status(400).json({
            error:
              "No frames were received. Record a scrolling screen video and try again.",
          });
        }

        console.log(`Received ${files.length} frames for job ${jobId}`);

        const quality = firstString(req.query.quality) === "jpeg" ? "jpeg" : "png";

        jobProgress.set(jobId, { stage: "Processing", progress: 0, createdAt: Date.now() });
        res.json({ jobId, frameCount: files.length });

        (async () => {
          const framePaths = files.map((f) => f.path);
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

            const outputPdfPath = path.join(outputDir, `${jobId}.pdf`);
            updateJob(jobId, { stage: "Generating PDF", progress: STAGE_SPANS.pdf[0], detail: undefined });
            await generatePdf(outputImagePath, outputPdfPath);

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
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "Processing failed unexpectedly.";
            console.error(`Processing error (job ${jobId}):`, err);
            updateJob(jobId, { stage: "Error", progress: 0, error: message });
          } finally {
            for (const f of [...framePaths, ...tempOutputs]) {
              try {
                fs.unlinkSync(f);
              } catch {
                // already gone (e.g. tmp stitch file was renamed) — ignore
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

  app.get("/api/output/:filename", (req: Request, res: Response) => {
    const filename = path.basename(firstString(req.params.filename));
    const filePath = path.join(outputDir, filename);

    if (!fs.existsSync(filePath)) {
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

  app.get("/api/output-base64/:filename", (req: Request, res: Response) => {
    const filename = path.basename(firstString(req.params.filename));
    const filePath = path.join(outputDir, filename);

    if (!fs.existsSync(filePath)) {
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

      const pdfFilename = `${baseName}_crop.pdf`;
      const pdfPath = path.join(outputDir, pdfFilename);
      await generatePdf(croppedPath, pdfPath);

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
