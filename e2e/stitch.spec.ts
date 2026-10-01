import { test, expect, button, pickRecording, snap, json } from "./support";

test.describe("stitching a recording", () => {
  test.beforeEach(async ({ rc, page }) => {
    await rc({ subscribed: true });
    await page.goto("/");
    await expect(button(page, "Pick a screen recording")).toBeVisible();
  });

  test("recording in, long image and PDF out", async ({ page, api, pageErrors }) => {
    await pickRecording(page);

    // Frames are extracted in the browser from the real video, then uploaded.
    await expect(page.getByText(/^Extracting frames|^Filtering|^Uploading/i).first()).toBeVisible();
    await snap(page, "processing");

    await expect(button(page, "Save to Photos")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("360x2400", { exact: true })).toBeVisible();
    await expect(page.getByText("30", { exact: true })).toBeVisible(); // total frames
    await snap(page, "result");

    expect(api.count("/api/upload-chunk")).toBeGreaterThanOrEqual(1);
    const start = api.calls.find((c) => c.path === "/api/process-frames");
    expect(start?.search).toMatch(/quality=png/);
    expect(start?.search).toMatch(/sessionId=/);

    const png = page.waitForEvent("download");
    await button(page, "Save to Photos").click();
    expect((await png).suggestedFilename()).toMatch(/^scrollstitch_\d+\.png$/);

    const pdf = page.waitForEvent("download");
    await button(page, "Share as PDF").click();
    expect((await pdf).suggestedFilename()).toMatch(/\.pdf$/);

    expect(pageErrors).toEqual([]);
  });

  test("trimming sends the chosen edges and shows the new size", async ({ page, api }) => {
    await pickRecording(page);
    await expect(button(page, "Save to Photos")).toBeVisible({ timeout: 60_000 });

    const minusTop = button(page, "Decrease top trim by 50 pixels");
    await expect(minusTop).toBeDisabled();
    await button(page, "Increase top trim by 50 pixels").click();
    await button(page, "Increase top trim by 50 pixels").click();
    await button(page, "Increase bottom trim by 50 pixels").click();
    await expect(minusTop).toBeEnabled();
    await snap(page, "trim");

    await page.getByRole("button", { name: /Apply crop/i }).click();
    await expect(page.getByText("360x2250", { exact: true })).toBeVisible();
    const crop = api.calls.find((c) => c.path.startsWith("/api/crop/"));
    expect(crop?.path).toBe("/api/crop/e2ejob.png");
    expect(crop?.search).toContain("top=100");
    expect(crop?.search).toContain("bottom=50");
  });

  test("the trim steppers stop at their cap", async ({ page, api }) => {
    // A short stitch: half its height minus 10 is the most either edge takes.
    api.override("/api/progress/", (route) =>
      json(route, {
        stage: "Complete",
        progress: 1,
        result: {
          imageUrl: "/api/output/e2ejob.png",
          previewUrl: "/api/output/e2ejob.png",
          pdfUrl: "/api/output/e2ejob.pdf",
          frameCount: 3,
          uniqueFrames: 2,
          dimensions: { width: 360, height: 141 },
        },
      })
    );
    await pickRecording(page);
    const plus = button(page, "Increase top trim by 50 pixels");
    await expect(plus).toBeVisible({ timeout: 60_000 });
    await plus.click();
    await plus.click();
    // floor(141 / 2) - 10 = 60: a whole number, and the button then stops.
    await expect(page.getByText(/^Top\s+60px$/)).toBeVisible();
    await expect(plus).toBeDisabled();
  });

  test("Process another video returns to a clean start", async ({ page }) => {
    await pickRecording(page);
    await expect(button(page, "Save to Photos")).toBeVisible({ timeout: 60_000 });
    await button(page, "Process another video").click();
    await expect(button(page, "Pick a screen recording")).toBeVisible();
    await expect(button(page, "Save to Photos")).toHaveCount(0);
    await expect(button(page, "Start over")).toHaveCount(0);
  });

  test("a rejected upload shows the server's sentence, once, without JSON", async ({ page, api }) => {
    api.override("/api/upload-chunk", (route) =>
      json(route, { error: "Missing or invalid sessionId" }, 400)
    );
    await pickRecording(page);
    await expect(page.getByText("Processing Failed", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Missing or invalid sessionId", { exact: true })).toBeVisible();
    await expect(page.getByText(/[{}"]/)).toHaveCount(0);
    await expect(page.getByText(/HTTP-400/)).toBeVisible();
    // A 400 is not retried: it would only be refused again.
    expect(api.count("/api/upload-chunk")).toBe(1);
    await snap(page, "error-rejected-upload");
  });

  test("a server hiccup is retried, then explained in plain words", async ({ page, api }) => {
    api.override("/api/upload-chunk", (route) =>
      route.fulfill({ status: 502, contentType: "text/html", body: "<html><h1>502 Bad Gateway</h1></html>" })
    );
    await pickRecording(page);
    await expect(page.getByText("The server ran into a problem. Please try again.", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    expect(api.count("/api/upload-chunk")).toBe(3);
  });

  test("a failed job reports the server's reason and offers a retry", async ({ page, api }) => {
    api.override("/api/progress/", (route) =>
      json(route, { stage: "Error", progress: 0, error: "Not enough distinct frames to stitch." })
    );
    await pickRecording(page);
    await expect(page.getByText("Not enough distinct frames to stitch.", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(button(page, "Try again")).toBeVisible();
    await expect(button(page, "Start over")).toBeVisible();
  });

  test("a job the server has forgotten says it expired", async ({ page, api }) => {
    api.override("/api/progress/", (route) => json(route, { error: "Job not found" }, 404));
    await pickRecording(page);
    await expect(page.getByText(/This stitch expired/)).toBeVisible({ timeout: 60_000 });
  });

  test("settings: the choices are grouped radios and the choice is sent", async ({ page, api }) => {
    await button(page, "Settings").click();
    const quality = page.getByRole("radiogroup", { name: "Output quality" });
    await expect(page.getByRole("radiogroup", { name: "Sensitivity" }).getByRole("radio")).toHaveCount(3);
    await quality.getByRole("radio", { name: /JPEG/ }).click();
    await snap(page, "settings");
    await button(page, "Settings").click();

    await pickRecording(page);
    await expect(button(page, "Save to Photos")).toBeVisible({ timeout: 60_000 });
    const start = api.calls.find((c) => c.path === "/api/process-frames");
    expect(start?.search).toMatch(/quality=jpeg/);
  });

  test("the library opens and comes back", async ({ page }) => {
    await button(page, "Saved stitches").click();
    await expect(page).toHaveURL(/\/library$/);
    // On the web nothing is filed (the browser downloads instead): empty state.
    await expect(page.getByText("No stitches yet", { exact: true })).toBeVisible();
    await snap(page, "library-empty");
    await button(page, "Make a stitch").click();
    await expect(button(page, "Pick a screen recording")).toBeVisible();
  });
});
