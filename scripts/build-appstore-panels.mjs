/**
 * Builds the App Store screenshot panels as HTML, then renders them to PNG at
 * 1290x2796 — the 6.9" size Apple requires.
 *
 * They are HTML rather than composited images because the layout work (filling
 * a panel, overlapping cards, rotation, shadows, text that wraps on its own) is
 * one line of CSS each and several fiddly calculations otherwise. Two earlier
 * attempts got those calculations wrong in ways that were only visible on
 * inspection.
 *
 * The content is not mocked up: build-appstore-source.ts renders a chat thread,
 * cuts it into overlapping frames with a sticky header burned in, and runs the
 * real pipeline over them. These panels show that output.
 *
 * Usage:
 *   node scripts/build-appstore-panels.mjs           # writes HTML + assets
 *   node scripts/build-appstore-panels.mjs --render  # also renders PNGs
 *
 * Rendering needs Chromium. Set CHROME to its path if it is not on PATH.
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "appstore-screenshots", "html");
const SRC = path.join(ROOT, "appstore-screenshots", "source");
fs.mkdirSync(DIR, { recursive: true });

// Assets the panels reference, copied in beside the HTML.
fs.copyFileSync(path.join(SRC, "stitched.png"), path.join(DIR, "stitched.png"));
for (const f of fs.readdirSync(SRC).filter((f) => /^frame\d+\.jpg$/.test(f))) {
  fs.copyFileSync(path.join(SRC, f), path.join(DIR, f));
}

const RED = "#ec3013", LIGHT = "#f3f2f2", INK = "#201e1d";

const SHELL = (bg, fg, caption, stage, extraCss = "") => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:1290px; height:2796px; overflow:hidden; }
  body {
    background:${bg}; color:${fg};
    font-family:'Archivo', sans-serif;
    display:flex; flex-direction:column;
  }
  h1 {
    font-family:'Archivo Black','Archivo',sans-serif; font-weight:900;
    font-size:106px; line-height:1.06; letter-spacing:-3px;
    text-align:center; padding:150px 70px 0; flex:none;
  }
  .stage { flex:1; position:relative; overflow:hidden; }
  /* A device body: heavy rule, square corners, matching the app's language. */
  .dev { position:absolute; background:#fff; border:12px solid ${INK}; overflow:hidden; }
  .dev img { display:block; width:100%; }
  .shadow { box-shadow: 0 40px 90px rgba(0,0,0,.35); }
  ${extraCss}
</style></head><body>
  <h1>${caption}</h1>
  <div class="stage">${stage}</div>
</body></html>`;

// ── 1. The problem: a scattered pile of separate captures ─────────────────
const pile = [
  { l: -60, t: 40, w: 430, r: -7, z: 1, f: 0 },
  { l: 330, t: 250, w: 430, r: 4, z: 3, f: 2 },
  { l: 760, t: 60, w: 430, r: 8, z: 2, f: 4 },
  { l: 120, t: 1180, w: 430, r: 5, z: 4, f: 6 },
  { l: 640, t: 1320, w: 430, r: -5, z: 5, f: 8 },
].map(p => `<div class="dev shadow" style="left:${p.l}px;top:${p.t}px;width:${p.w}px;height:1020px;
     transform:rotate(${p.r}deg);z-index:${p.z}"><img src="frame${p.f}.jpg"></div>`).join("");
fs.writeFileSync(DIR + "/p1.html", SHELL(RED, LIGHT, "Stop taking<br>12 screenshots", pile));

// ── 2. The result: one long image, bleeding off the bottom ────────────────
fs.writeFileSync(DIR + "/p2.html", SHELL(LIGHT, INK, "One long image.<br>No seams.",
  `<div class="dev shadow" style="left:50%;transform:translateX(-50%);top:60px;width:660px;height:2000px">
     <img src="stitched.png"></div>`));

// ── 3. Sticky header removed ──────────────────────────────────────────────
// Same frame on both sides — the only difference is the header, which is the
// entire point of the comparison.
fs.writeFileSync(DIR + "/p3.html", SHELL(INK, LIGHT, "Sticky headers<br>removed",
  // 560px device, 12px borders -> 536 inner; the 900x1950 frame renders 1161
  // tall. The right device is exactly 93px shorter because that is the header
  // the pipeline cut off.
  `<div class="dev" style="left:45px;top:500px;width:560px;height:1185px">
     <img src="frame4.jpg">
     <div class="mark"></div>
   </div>
   <div class="dev" style="right:45px;top:500px;width:560px;height:1092px">
     <img src="frame4.jpg" style="margin-top:-93px">
   </div>
   <div class="tag" style="left:45px;top:1721px;background:#605d5d">header repeats</div>
   <div class="tag" style="right:45px;top:1721px;background:${RED}">header gone</div>`,
  `.mark { position:absolute; inset:0 0 auto 0; height:93px;
     border:6px solid ${RED}; background:rgba(236,48,19,.22); }
   .tag { position:absolute; width:560px; height:104px; line-height:104px;
     text-align:center; font-weight:700; font-size:46px; color:${LIGHT}; }`));

// ── 4. Export: the result, with the two destinations on it ────────────────
fs.writeFileSync(DIR + "/p4.html", SHELL(RED, LIGHT, "Photos or PDF.<br>Your choice.",
  `<div class="dev shadow" style="left:50%;transform:translateX(-50%);top:40px;width:600px;height:2000px">
     <img src="stitched.png"></div>
   <div class="chip" style="top:520px">Save to Photos<span>one tall image, full quality</span></div>
   <div class="chip" style="top:900px">Export as PDF<span>share it or file it away</span></div>`,
  `.chip { position:absolute; left:50%; transform:translateX(-50%); width:1080px;
     background:${LIGHT}; color:${INK}; border:10px solid ${INK}; padding:38px 52px;
     font-weight:700; font-size:78px; box-shadow:0 30px 70px rgba(0,0,0,.4); }
   .chip span { display:block; font-weight:400; font-size:46px; opacity:.6; margin-top:12px; }`));

// ── 5. Gaps are marked, not invented ──────────────────────────────────────
fs.writeFileSync(DIR + "/p5.html", SHELL(LIGHT, INK, "Gaps marked.<br>Never faked.",
  `<div class="dev shadow" style="left:50%;transform:translateX(-50%);top:60px;width:660px;height:2000px">
     <img src="stitched.png">
     <div class="gap">GAP IN SCROLL</div>
     <img src="stitched.png" style="margin-top:0">
   </div>`,
  `.gap { background:${RED}; color:${LIGHT}; font-weight:700; font-size:48px;
     text-align:center; padding:34px 0; letter-spacing:1px; }`));

// ── 6. Notification ───────────────────────────────────────────────────────
fs.writeFileSync(DIR + "/p6.html", SHELL(INK, LIGHT, "We'll tell you<br>when it's done",
  `<div class="dev" style="left:50%;transform:translateX(-50%);top:80px;width:700px;height:1700px;border-color:#3a3a3a">
     <img src="stitched.png" style="filter:brightness(.4)"></div>
   <div class="note">
     <div class="ico"></div>
     <div><b>ScrollStitch</b><span>Your screenshot is ready</span></div>
   </div>
   <div class="sub">Put your phone down while it works</div>`,
  `.note { position:absolute; top:520px; left:50%; transform:translateX(-50%);
     width:1140px; background:${LIGHT}; border-radius:52px; padding:44px 56px;
     display:flex; gap:36px; align-items:center; box-shadow:0 40px 90px rgba(0,0,0,.55); }
   .ico { width:140px; height:140px; background:${RED}; flex:none; }
   .note b { display:block; color:${INK}; font-size:58px; font-weight:700; }
   .note span { display:block; color:${INK}; opacity:.65; font-size:48px; margin-top:8px; }
   .sub { position:absolute; bottom:110px; width:100%; text-align:center;
     font-size:54px; opacity:.75; }`));

console.log("wrote 6 html panels to", DIR);

if (process.argv.includes("--render")) {
  const chrome = process.env.CHROME || "chromium";
  const out = path.join(ROOT, "appstore-screenshots");
  const names = ["01-problem", "02-result", "03-headers", "04-export", "05-gaps", "06-notify"];
  for (let i = 1; i <= 6; i++) {
    execFileSync(chrome, [
      "--headless", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
      "--hide-scrollbars", "--window-size=1290,2796", "--virtual-time-budget=8000",
      `--screenshot=${path.join(out, names[i - 1] + ".png")}`,
      "file://" + path.join(DIR, `p${i}.html`),
    ], { stdio: "ignore" });
    console.log("rendered", names[i - 1]);
  }
}
