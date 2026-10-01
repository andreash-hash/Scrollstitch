import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run against a static web export of the app, built with E2E=1 so
 * metro.config.js swaps RevenueCat for e2e/mocks. That variable is only set by
 * `npm run e2e:build`; ordinary dev, EAS and Replit builds never see the mock.
 *
 *   npm run test:e2e                  build the export, then run everything
 *   E2E_SKIP_BUILD=1 npm run test:e2e reuse an existing dist-e2e/
 *
 * The app's API host is a fake one answered by route interception (see
 * e2e/support.ts). Only real-pipeline.spec.ts reaches a server: a local one,
 * started below, with no secrets or database behind it.
 */
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 8099);
const SERVER_PORT = Number(process.env.E2E_SERVER_PORT ?? 5099);
process.env.E2E_SERVER_PORT = String(SERVER_PORT);

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      // An iPhone-sized viewport on Chromium: the shipped app is iOS-only, and
      // its web build lays out the same way at this width.
      name: "iphone-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
      },
    },
  ],
  webServer: [
    {
      command: process.env.E2E_SKIP_BUILD
        ? "node e2e/serve.mjs"
        : "npm run e2e:build && node e2e/serve.mjs",
      url: `http://127.0.0.1:${WEB_PORT}/`,
      env: { E2E_WEB_PORT: String(WEB_PORT), E2E_WEB_DIR: "dist-e2e" },
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      stdout: "ignore",
    },
    {
      command: "npx tsx server/index.ts",
      url: `http://127.0.0.1:${SERVER_PORT}/api/health`,
      env: { PORT: String(SERVER_PORT), NODE_ENV: "development" },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "ignore",
    },
  ],
});
