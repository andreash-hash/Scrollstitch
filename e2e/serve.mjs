// Minimal static server for the e2e web export: serves files, and falls back
// to index.html for client-side routes (/onboarding, /library). No deps.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.env.E2E_WEB_DIR || "dist-e2e");
const port = Number(process.env.E2E_WEB_PORT || 8099);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
};

createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  let file = normalize(join(root, urlPath));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const s = await stat(file);
    if (s.isDirectory()) file = join(file, "index.html");
  } catch {
    file = join(root, "index.html");
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`e2e web build on http://127.0.0.1:${port} from ${root}`);
});
