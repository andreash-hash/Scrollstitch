import { test as base, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Shared e2e plumbing.
 *
 * The web build is exported with EXPO_PUBLIC_DOMAIN=api.e2e.test, a host that
 * does not exist: every request to it is answered here by route interception,
 * and every other non-local request is refused. Nothing reaches the real
 * server, RevenueCat (swapped for e2e/mocks at bundle time) or anyone's data.
 */

export const API_HOST = "api.e2e.test";
export const FIXTURES = path.join(__dirname, "fixtures");
export const RECORDING = path.join(FIXTURES, "scroll.webm");
const STITCHED_PNG = readFileSync(path.join(FIXTURES, "stitched.png"));
// The smallest file a PDF viewer opens; the app only needs it downloadable.
const TINY_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj " +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
);

export type RcState = {
  subscribed?: boolean;
  offerings?: "ok" | "empty" | "error";
  purchase?: "grant" | "no-entitlement" | "cancel" | "error";
  restore?: "grant" | "none";
};

export type ApiHandler = (route: Route, url: URL) => Promise<void> | void;

export const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/**
 * A backend that behaves like the real one for a successful job: accepts the
 * chunks, starts a job, reports two progress ticks, then completes with the
 * fixture stitch. Tests override single endpoints via `api.override()`.
 */
export class FakeApi {
  readonly calls: { method: string; path: string; search: string }[] = [];
  private overrides = new Map<string, ApiHandler>();
  private polls = 0;

  override(pathPrefix: string, handler: ApiHandler) {
    this.overrides.set(pathPrefix, handler);
  }

  count(pathPrefix: string) {
    return this.calls.filter((c) => c.path.startsWith(pathPrefix)).length;
  }

  async handle(route: Route, url: URL) {
    this.calls.push({ method: route.request().method(), path: url.pathname, search: url.search });
    for (const [prefix, handler] of this.overrides) {
      if (url.pathname.startsWith(prefix)) return handler(route, url);
    }
    const p = url.pathname;
    if (p === "/api/upload-chunk") return json(route, { received: 25 });
    if (p === "/api/process-frames") return json(route, { jobId: "e2ejob" });
    if (p.startsWith("/api/progress/")) {
      this.polls++;
      if (this.polls === 1) return json(route, { stage: "Deduplicating", progress: 0.2, detail: "10/30" });
      if (this.polls === 2) return json(route, { stage: "Stitching", progress: 0.8 });
      return json(route, {
        stage: "Complete",
        progress: 1,
        result: {
          imageUrl: "/api/output/e2ejob.png",
          previewUrl: "/api/output/e2ejob.png",
          pdfUrl: "/api/output/e2ejob.pdf",
          frameCount: 30,
          uniqueFrames: 24,
          selectedFrames: 7,
          gapCount: 0,
          warnings: [],
          dimensions: { width: 360, height: 2400 },
        },
      });
    }
    if (p.startsWith("/api/crop/")) {
      const top = Number(url.searchParams.get("top") ?? 0);
      const bottom = Number(url.searchParams.get("bottom") ?? 0);
      return json(route, {
        imageUrl: "/api/output/e2ejob_crop.png",
        previewUrl: "/api/output/e2ejob_crop.png",
        pdfUrl: "/api/output/e2ejob_crop.pdf",
        dimensions: { width: 360, height: 2400 - top - bottom },
      });
    }
    if (p.endsWith(".png")) return route.fulfill({ status: 200, contentType: "image/png", body: STITCHED_PNG });
    if (p.endsWith(".pdf")) return route.fulfill({ status: 200, contentType: "application/pdf", body: TINY_PDF });
    return json(route, { error: "Not mocked: " + p }, 404);
  }
}

type Fixtures = {
  api: FakeApi;
  rc: (state: RcState) => Promise<void>;
  pageErrors: string[];
};

export const test = base.extend<Fixtures>({
  pageErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await use(errors);
  },
  // auto: installed for every test, used or not, so no test can reach the
  // network just by forgetting to ask for the fake backend.
  api: [
    async ({ context }, use) => {
    const api = new FakeApi();
    await context.route(/^https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return route.continue();
      if (url.hostname === API_HOST) return api.handle(route, url);
      return route.abort("blockedbyclient");
    });
    await use(api);
    },
    { auto: true },
  ],
  rc: async ({ page }, use) => {
    await use(async (state: RcState) => {
      await page.addInitScript((s) => {
        (window as unknown as { __E2E_RC__: RcState }).__E2E_RC__ = s;
      }, state);
    });
  },
});

export { expect };

/** Role lookups with exact names — Playwright's default is a substring match. */
export const button = (page: Page, name: string | RegExp) =>
  page.getByRole("button", typeof name === "string" ? { name, exact: true } : { name });

export async function pickRecording(page: Page, file = RECORDING) {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    button(page, "Pick a screen recording").click(),
  ]);
  await chooser.setFiles(file);
}

/** Screenshot saved as a file in the test's output folder (CI publishes
 * these to the ci-results branch) and attached to the HTML report. */
export async function snap(page: Page, name: string) {
  const file = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  await test.info().attach(name, { path: file, contentType: "image/png" });
}
