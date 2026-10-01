import { test, expect, button, pickRecording, snap } from "./support";

// The one test that runs the real pipeline: requests to the fake API host are
// forwarded to a ScrollStitch server started by playwright.config.ts on
// E2E_SERVER_PORT. It holds no secrets and no database — the server is
// stateless image processing — so this is still fully local.
//
// It guards the stitch itself at the level a person sees it: the fixture
// recording scrolls a 2400px page, so anything else on the result screen
// means rows were repeated or lost.

const SERVER = `http://127.0.0.1:${process.env.E2E_SERVER_PORT ?? 5099}`;

test("the real server stitches the recording to the page's true height", async ({ page, rc, api }) => {
  test.slow();
  api.override("/", async (route, url) => {
    const response = await route.fetch({ url: `${SERVER}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  await rc({ subscribed: true });
  await page.goto("/");
  await pickRecording(page);
  await expect(button(page, "Save to Photos")).toBeVisible({ timeout: 90_000 });
  await snap(page, "real-pipeline-result");
  await expect(page.getByText("360x2400", { exact: true })).toBeVisible();
});
