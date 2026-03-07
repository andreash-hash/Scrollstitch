import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import multer from "multer";
import {
  deduplicateFrames,
  stitchFrames,
  generatePdf,
} from "./video-processor";

const uploadDir = path.join(os.tmpdir(), "scrollsnap-uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 100 * 1024 * 1024 },
});

const jobProgress = new Map<
  string,
  { stage: string; progress: number; result?: any; error?: string }
>();

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

        jobProgress.set(jobId, { stage: "Processing", progress: 0 });
        res.json({ jobId, frameCount: files.length });

        (async () => {
          try {
            const framePaths = files.map((f) => f.path);

            jobProgress.set(jobId, {
              stage: "Removing duplicates",
              progress: 0.3,
            });
            const uniqueFrames = await deduplicateFrames(framePaths);
            console.log(
              `Deduplicated: ${framePaths.length} -> ${uniqueFrames.length} frames`
            );

            const outputDir = path.join(os.tmpdir(), "scrollsnap-output");
            fs.mkdirSync(outputDir, { recursive: true });

            const outputImagePath = path.join(outputDir, `${jobId}.png`);
            jobProgress.set(jobId, {
              stage: "Stitching frames",
              progress: 0.5,
            });
            const dimensions = await stitchFrames(
              uniqueFrames,
              outputImagePath
            );

            const outputPdfPath = path.join(outputDir, `${jobId}.pdf`);
            jobProgress.set(jobId, {
              stage: "Generating PDF",
              progress: 0.8,
            });
            await generatePdf(outputImagePath, outputPdfPath);

            jobProgress.set(jobId, {
              stage: "Complete",
              progress: 1,
              result: {
                imageUrl: `/api/output/${jobId}.png`,
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
            jobProgress.set(jobId, {
              stage: "Error",
              progress: 0,
              error: err.message,
            });
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
    const contentType = ext === ".pdf" ? "application/pdf" : "image/png";

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

  const httpServer = createServer(app);
  return httpServer;
}
