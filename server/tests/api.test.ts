import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { registerRoutes } from "../routes";
import {
  generatePage,
  renderFrames,
  makeTempDir,
  cleanupTempDirs,
} from "./helpers";

const WIDTH = 540;
const FRAME_H = 960;

let server: Server;
let baseUrl: string;

before(async () => {
  const app = express();
  server = await registerRoutes(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
  cleanupTempDirs();
});

function frameFormData(framePaths: string[]): FormData {
  const fd = new FormData();
  for (const p of framePaths) {
    fd.append(
      "frames",
      new Blob([fs.readFileSync(p)], { type: "image/jpeg" }),
      path.basename(p)
    );
  }
  return fd;
}

interface JobStatus {
  stage: string;
  progress: number;
  detail?: string;
  error?: string;
  result?: {
    imageUrl: string;
    previewUrl: string;
    pdfUrl: string;
    frameCount: number;
    uniqueFrames: number;
    selectedFrames: number;
    gapCount: number;
    warnings: string[];
    seams: { type: string; overlapPx: number; ncc: number; nccThreshold: number }[];
    dimensions: { width: number; height: number };
  };
}

async function pollUntilDone(jobId: string, timeoutMs = 90_000): Promise<JobStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: JobStatus | undefined;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/progress/${jobId}`);
    assert.equal(res.status, 200);
    last = (await res.json()) as JobStatus;
    if (last.stage === "Complete" || last.stage === "Error") return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`job ${jobId} did not finish in time (last stage: ${last?.stage})`);
}

describe("/api/process-frames end to end", () => {
  test("uploads frames, reports progress and serves the stitched result", async () => {
    const pageH = 3840;
    const page = generatePage(WIDTH, pageH, 2024);
    const positions = [0, 576, 1152, 1728, 2304, 2880];
    const frames = await renderFrames({
      page,
      outDir: makeTempDir("api-smooth"),
      frameHeight: FRAME_H,
      frames: positions.map((position) => ({ position })),
      jpegQuality: 80,
    });

    const uploadRes = await fetch(`${baseUrl}/api/process-frames?quality=png`, {
      method: "POST",
      body: frameFormData(frames),
    });
    assert.equal(uploadRes.status, 200);
    const { jobId, frameCount } = (await uploadRes.json()) as {
      jobId: string;
      frameCount: number;
    };
    assert.ok(jobId);
    assert.equal(frameCount, 6);

    const done = await pollUntilDone(jobId);
    assert.equal(done.stage, "Complete", done.error ?? "");
    assert.equal(done.progress, 1);
    const result = done.result!;
    assert.equal(result.frameCount, 6);
    assert.equal(result.gapCount, 0);
    assert.ok(result.selectedFrames >= 2);
    assert.ok(Array.isArray(result.warnings));
    assert.equal(result.seams.length, result.selectedFrames);
    assert.ok(Math.abs(result.dimensions.height - pageH) <= 25);
    // Small output → preview is the full image itself
    assert.equal(result.previewUrl, result.imageUrl);

    // Both artifacts must be downloadable
    const imgRes = await fetch(`${baseUrl}${result.imageUrl}`);
    assert.equal(imgRes.status, 200);
    assert.equal(imgRes.headers.get("content-type"), "image/png");
    const imgBytes = await imgRes.arrayBuffer();
    assert.ok(imgBytes.byteLength > 10_000);

    const pdfRes = await fetch(`${baseUrl}${result.pdfUrl}`);
    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.headers.get("content-type"), "application/pdf");
  });

  test("rejects an upload without frames", async () => {
    const res = await fetch(`${baseUrl}/api/process-frames`, {
      method: "POST",
      body: new FormData(),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /No frames/i);
  });

  test("reports a clear error for an undecodable upload", async () => {
    const fd = new FormData();
    for (let i = 0; i < 3; i++) {
      fd.append("frames", new Blob([Buffer.from(`junk ${i}`)]), `bad_${i}.jpg`);
    }
    const uploadRes = await fetch(`${baseUrl}/api/process-frames`, {
      method: "POST",
      body: fd,
    });
    assert.equal(uploadRes.status, 200);
    const { jobId } = (await uploadRes.json()) as { jobId: string };

    const done = await pollUntilDone(jobId);
    assert.equal(done.stage, "Error");
    assert.match(done.error ?? "", /could(?: not)? be read as images/);
  });

  test("returns 404 for unknown jobs", async () => {
    const res = await fetch(`${baseUrl}/api/progress/nope`);
    assert.equal(res.status, 404);
  });
});
