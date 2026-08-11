// Records which commit the server bundle was built from.
//
// /api/health reads the SHA from .git at startup, but deployment images strip
// .git — so in production the field read "unknown", which is exactly when it
// matters. Writing it at build time gives the running server something to
// report when git metadata is gone.
//
// The deploy builds in the workspace, where .git is present, so the deployed
// value is the real HEAD. The copy committed alongside the bundle is only a
// fallback for a build that cannot see git, and it necessarily names the
// commit *before* the one containing it — it is written before that commit
// exists. Off by one beats "unknown"; do not read it as exact.

import * as fs from "fs";
import * as path from "path";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "server_dist");
const outFile = path.join(outDir, "build-info.json");

function readCommitFromGit() {
  const gitDir = path.join(root, ".git");
  const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf-8").trim();
  if (!head.startsWith("ref: ")) return head;

  const ref = head.slice(5).trim();
  try {
    return fs.readFileSync(path.join(gitDir, ref), "utf-8").trim();
  } catch {
    // Ref is packed rather than loose
    const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf-8");
    const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
    if (!line) throw new Error(`ref ${ref} not found in packed-refs`);
    return line.split(" ")[0];
  }
}

let commit;
try {
  commit = readCommitFromGit();
} catch {
  // No git metadata here. If a previous build already recorded a commit, that
  // value is still the truth about this bundle — overwriting it with "unknown"
  // would destroy the only identity the deployment has.
  if (fs.existsSync(outFile)) {
    console.log("build-info: no git metadata, keeping existing build-info.json");
    process.exit(0);
  }
  commit = "unknown";
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  outFile,
  JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2) + "\n"
);
console.log(`build-info: commit ${commit.slice(0, 7)}`);
