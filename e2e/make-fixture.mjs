// Builds e2e/fixtures/scroll.webm (and stitched.png): a synthetic "screen recording" that scrolls
// down a tall page with distinct rows, so overlaps are unambiguous. Committed
// so CI needs no ffmpeg; rerun with `node e2e/make-fixture.mjs` if changed.
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const W = 360, H = 640, PAGE = 2400, FPS = 30, SECONDS = 4;
const rows = [];
for (let y = 0, i = 0; y < PAGE; y += 80, i++) {
  const hue = (i * 47) % 360;
  rows.push(`<rect x="0" y="${y}" width="${W}" height="80" fill="hsl(${hue},55%,${i % 2 ? 80 : 65}%)"/>`,
    `<text x="20" y="${y + 50}" font-family="sans-serif" font-size="28" fill="#111">Row ${i + 1} — message ${(i * 7919) % 1000}</text>`);
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${PAGE}">${rows.join("")}</svg>`;
const tall = await sharp(Buffer.from(svg)).png().toBuffer();
// What a correct stitch of the recording looks like: the mocked backend
// serves it as the job's output, so UI tests need no server or ffmpeg.
await sharp(tall).png({ compressionLevel: 9, palette: true }).toFile("e2e/fixtures/stitched.png");

const dir = mkdtempSync(join(tmpdir(), "ssfix-"));
const frames = FPS * SECONDS;
// Hold still for the first and last half second, like a real recording.
for (let f = 0; f < frames; f++) {
  const t = Math.min(1, Math.max(0, (f / (frames - 1) - 0.125) / 0.75));
  const top = Math.round(t * (PAGE - H));
  await sharp(tall).extract({ left: 0, top, width: W, height: H }).png()
    .toFile(join(dir, `f${String(f).padStart(4, "0")}.png`));
}
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(dir, "f%04d.png"),
  "-c:v", "libvpx", "-b:v", "1M", "-pix_fmt", "yuv420p", "e2e/fixtures/scroll.webm"]);
// The iOS simulator's Photos library needs H.264, not VP8 (used by Maestro).
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(dir, "f%04d.png"),
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "e2e/fixtures/scroll.mp4"]);
rmSync(dir, { recursive: true });
console.log("wrote e2e/fixtures/scroll.webm, scroll.mp4 and stitched.png");
