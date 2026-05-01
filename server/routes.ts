import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import multer from "multer";
import {
  deduplicateFrames,
  detectAndRemoveStickyHeaders,
  stitchFrames,
  generatePdf,
} from "./video-processor";

const uploadDir = path.join(os.tmpdir(), "scrollsnap-uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 100 * 1024 * 1024 },
});

interface JobState {
  stage: string;
  progress: number;
  result?: any;
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
}, 5 * 60 * 1000);

export async function registerRoutes(app: Express): Promise<Server> {
  app.post(
    "/api/process-frames",
    upload.array("frames", 500),
    async (req: Request, res: Response) => {
      const jobId =
        Date.now().toString() + Math.random().toString(36).substr(2, 9);

      try {
        const files = req.files as Express.Multer.File[];
        if (!files || files.length === 0) {
          return res.status(400).json({ error: "No frames provided" });
        }

        console.log(`Received ${files.length} frames for job ${jobId}`);

        jobProgress.set(jobId, { stage: "Processing", progress: 0, createdAt: Date.now() });
        res.json({ jobId, frameCount: files.length });

        (async () => {
          try {
            const framePaths = files.map((f) => f.path);

            updateJob(jobId, { stage: "Removing duplicates", progress: 0.2 });
            const uniqueFrames = await deduplicateFrames(framePaths);
            console.log(
              `Deduplicated: ${framePaths.length} -> ${uniqueFrames.length} frames`
            );

            updateJob(jobId, { stage: "Removing sticky headers", progress: 0.4 });
            const { paths: cleanedFrames, headerHeight, footerHeight } =
              await detectAndRemoveStickyHeaders(uniqueFrames);
            if (headerHeight > 0 || footerHeight > 0) {
              console.log(`Removed sticky: header=${headerHeight}px, footer=${footerHeight}px`);
            }

            const quality = (req.query.quality as string) === "jpeg" ? "jpeg" : "png";
            const outputDir = path.join(os.tmpdir(), "scrollsnap-output");
            fs.mkdirSync(outputDir, { recursive: true });

            const imgExt = quality === "jpeg" ? "jpg" : "png";
            const outputImagePath = path.join(outputDir, `${jobId}.${imgExt}`);
            updateJob(jobId, { stage: "Stitching frames", progress: 0.55 });
            const dimensions = await stitchFrames(
              cleanedFrames,
              outputImagePath,
              quality
            );

            const outputPdfPath = path.join(outputDir, `${jobId}.pdf`);
            updateJob(jobId, { stage: "Generating PDF", progress: 0.8 });
            await generatePdf(outputImagePath, outputPdfPath);

            updateJob(jobId, {
              stage: "Complete",
              progress: 1,
              result: {
                imageUrl: `/api/output/${jobId}.${imgExt}`,
                pdfUrl: `/api/output/${jobId}.pdf`,
                frameCount: framePaths.length,
                uniqueFrames: uniqueFrames.length,
                dimensions,
              },
            });

            for (const f of files) {
              try {
                fs.unlinkSync(f.path);
              } catch {}
            }
          } catch (err: any) {
            console.error("Processing error:", err);
            updateJob(jobId, { stage: "Error", progress: 0, error: err.message });
          }
        })();
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    }
  );

  app.get("/api/progress/:jobId", (req: Request, res: Response) => {
    const job = jobProgress.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json(job);
  });

  app.get("/api/output/:filename", (req: Request, res: Response) => {
    const outputDir = path.join(os.tmpdir(), "scrollsnap-output");
    const filename = path.basename(req.params.filename);
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
    const outputDir = path.join(os.tmpdir(), "scrollsnap-output");
    const filename = path.basename(req.params.filename);
    const filePath = path.join(outputDir, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }

    const data = fs.readFileSync(filePath);
    const base64 = data.toString("base64");
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = ext === ".pdf" ? "application/pdf" : "image/png";

    res.json({ base64, mimeType, filename });
  });

  app.get("/api/crop/:filename", async (req: Request, res: Response) => {
    try {
      const sharp = (await import("sharp")).default;
      const outputDir = path.join(os.tmpdir(), "scrollsnap-output");
      const filename = path.basename(req.params.filename);
      const filePath = path.join(outputDir, filename);

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found" });
      }

      const cropTop = Math.max(0, parseInt(req.query.top as string) || 0);
      const cropBottom = Math.max(0, parseInt(req.query.bottom as string) || 0);

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

      const pdfFilename = `${baseName}_crop.pdf`;
      const pdfPath = path.join(outputDir, pdfFilename);
      await generatePdf(croppedPath, pdfPath);

      res.json({
        imageUrl: `/api/output/${croppedFilename}`,
        pdfUrl: `/api/output/${pdfFilename}`,
        dimensions: { width: origWidth, height: newHeight },
      });
    } catch (err: any) {
      console.error("Crop error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
