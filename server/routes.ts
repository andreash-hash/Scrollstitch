import type { Express, Request, Response } from "express";
import { createServer, type Server } from "node:http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import multer from "multer";
import { processVideo } from "./video-processor";

const upload = multer({
  dest: path.join(os.tmpdir(), "scrollsnap-uploads"),
  limits: { fileSize: 500 * 1024 * 1024 },
});

const jobProgress = new Map<
  string,
  { stage: string; progress: number; result?: any; error?: string }
>();

export async function registerRoutes(app: Express): Promise<Server> {
  app.post(
    "/api/process",
    upload.single("video"),
    async (req: Request, res: Response) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "No video file provided" });
        }

        const jobId =
          Date.now().toString() +
          Math.random().toString(36).substr(2, 9);

        jobProgress.set(jobId, { stage: "Uploading", progress: 0 });

        res.json({ jobId });

        processVideo(
          req.file.path,
          jobId,
          (stage: string, progress: number) => {
            jobProgress.set(jobId, { stage, progress });
          }
        )
          .then((result) => {
            jobProgress.set(jobId, {
              stage: "Complete",
              progress: 1,
              result,
            });
            try {
              fs.unlinkSync(req.file!.path);
            } catch {}
          })
          .catch((err) => {
            jobProgress.set(jobId, {
              stage: "Error",
              progress: 0,
              error: err.message,
            });
            try {
              fs.unlinkSync(req.file!.path);
            } catch {}
          });
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
    const filePath = path.join(outputDir, req.params.filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      ext === ".pdf" ? "application/pdf" : "image/png";

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${req.params.filename}"`
    );
    fs.createReadStream(filePath).pipe(res);
  });

  const httpServer = createServer(app);
  return httpServer;
}
