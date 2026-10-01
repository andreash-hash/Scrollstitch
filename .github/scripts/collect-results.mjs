// Collect a CI run into one folder for publish-ci-results.sh:
//   SUMMARY.md     pass/fail per e2e test, plus the failure message
//   screens/*.png  every screenshot the tests took (named after the test)
//   *.log          unit-test and other logs given on the command line
//
//   node .github/scripts/collect-results.mjs <out-dir> [log files...]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [out, ...logs] = process.argv.slice(2);
mkdirSync(join(out, "screens"), { recursive: true });

const lines = ["# E2E summary", ""];
const resultsFile = "test-results/results.json";
if (existsSync(resultsFile)) {
  const report = JSON.parse(readFileSync(resultsFile, "utf8"));
  const rows = [];
  const walk = (suite, prefix) => {
    const title = [prefix, suite.title].filter(Boolean).join(" › ");
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.[t.results.length - 1];
        const status = t.status === "expected" ? "pass" : t.status === "flaky" ? "flaky" : t.status === "skipped" ? "skip" : "FAIL";
        const msg = last?.error?.message?.split("\n")[0]?.replace(/\u001b\[[0-9;]*m/g, "") ?? "";
        rows.push(`| ${status} | ${[title, spec.title].filter(Boolean).join(" › ")} | ${msg.replace(/\|/g, "\\|")} |`);
      }
    }
    for (const child of suite.suites ?? []) walk(child, title);
  };
  for (const s of report.suites ?? []) walk(s, "");
  const s = report.stats ?? {};
  lines.push(`expected ${s.expected ?? 0} · unexpected ${s.unexpected ?? 0} · flaky ${s.flaky ?? 0} · skipped ${s.skipped ?? 0}`, "");
  lines.push("| result | test | error |", "| --- | --- | --- |", ...rows);
} else {
  lines.push("No e2e results file — the e2e step did not run or crashed before reporting.");
}
writeFileSync(join(out, "SUMMARY.md"), lines.join("\n") + "\n");

// Screenshots live in per-test folders under test-results/; flatten them.
const walkPngs = (dir) => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    // Playwright keeps its own copies of attachments; take each shot once.
    if (statSync(p).isDirectory()) {
      if (name !== "attachments" && !name.startsWith(".playwright")) walkPngs(p);
    }
    else if (name.endsWith(".png")) cpSync(p, join(out, "screens", `${basename(dir).slice(0, 60)}__${name}`));
  }
};
walkPngs("test-results");

for (const log of logs) if (existsSync(log)) cpSync(log, join(out, basename(log)));
console.log(`collected into ${out}`);
