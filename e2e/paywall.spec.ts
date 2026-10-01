import { test, expect, button, snap } from "./support";

// The app has a hard paywall: without the RevenueCat "pro" entitlement the
// only screen is onboarding, which ends in the plans. There is no free tier,
// no stitch counter and no sign-in — RevenueCat's anonymous id is the account.

test.describe("paywall and purchase", () => {
  test("a new user is held in onboarding and reaches the plans", async ({ page, rc, pageErrors }) => {
    await rc({ subscribed: false });
    await page.goto("/");
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByText("Stop taking 12", { exact: false })).toBeVisible();
    await snap(page, "onboarding");

    // Walk the slides with the Next button rather than Skip.
    await button(page, "Next slide").click();
    await button(page, "Next slide").click();
    await button(page, "Next slide").click();
    await button(page, "Continue to plans").click();

    await expect(page.getByText("Go Pro", { exact: true })).toBeVisible();
    const plans = page.getByRole("radiogroup", { name: "Choose a plan" }).getByRole("radio");
    await expect(plans).toHaveCount(3);
    await expect(plans.nth(0)).toHaveAccessibleName("Weekly plan, $4.99 per week, 3 days free first");
    await expect(button(page, "Start 3 days free, then $4.99 per week")).toBeEnabled();
    await snap(page, "paywall");
    expect(pageErrors).toEqual([]);
  });

  test("the copy follows the selected plan, including one-time lifetime terms", async ({ page, rc }) => {
    await rc({ subscribed: false });
    await page.goto("/");
    await button(page, "Skip to plans").click();

    await page.getByRole("radio", { name: /^Annual plan/ }).click();
    await expect(button(page, "Subscribe for $29.99 per year")).toBeVisible();
    await expect(page.getByText(/^\$29\.99 per year\. Auto-renews/)).toBeVisible();

    await page.getByRole("radio", { name: /^Lifetime/ }).click();
    await expect(button(page, "Buy ScrollStitch Pro for $79.99, one-time payment")).toBeVisible();
    // Apple checks that terms match what is sold: no "renews" for a one-off.
    await expect(page.getByText(/not a subscription — nothing renews/)).toBeVisible();
    await snap(page, "paywall-lifetime");
  });

  test("buying unlocks the app", async ({ page, rc }) => {
    await rc({ subscribed: false, purchase: "grant" });
    await page.goto("/");
    await button(page, "Skip to plans").click();
    await button(page, "Start 3 days free, then $4.99 per week").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(button(page, "Pick a screen recording")).toBeVisible();
    await snap(page, "after-purchase");
  });

  test("a purchase that grants no access says so instead of looking frozen", async ({ page, rc }) => {
    await rc({ subscribed: false, purchase: "no-entitlement" });
    await page.goto("/");
    await button(page, "Skip to plans").click();
    await button(page, "Start 3 days free, then $4.99 per week").click();
    await expect(page.getByText(/couldn't confirm access/)).toBeVisible();
    await expect(page).toHaveURL(/\/onboarding/);
  });

  test("cancelling the store sheet is not an error", async ({ page, rc }) => {
    await rc({ subscribed: false, purchase: "cancel" });
    await page.goto("/");
    await button(page, "Skip to plans").click();
    await button(page, "Start 3 days free, then $4.99 per week").click();
    await expect(button(page, "Start 3 days free, then $4.99 per week")).toBeEnabled();
    await expect(page.getByText(/didn't complete|Purchase was cancelled/i)).toHaveCount(0);
  });

  test("a store error is shown and the button stays usable", async ({ page, rc }) => {
    await rc({ subscribed: false, purchase: "error" });
    await page.goto("/");
    await button(page, "Skip to plans").click();
    await button(page, "Start 3 days free, then $4.99 per week").click();
    await expect(page.getByText("E2E: the store rejected the purchase.", { exact: true })).toBeVisible();
    await expect(button(page, "Start 3 days free, then $4.99 per week")).toBeEnabled();
  });

  test("restore: nothing to restore, then an active purchase", async ({ page, rc }) => {
    await rc({ subscribed: false, restore: "none" });
    await page.goto("/");
    await button(page, "Skip to plans").click();
    await button(page, "Restore purchases").click();
    await expect(page.getByText("We couldn't find an active purchase on this Apple ID.", { exact: true })).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as { __E2E_RC__: { restore: string } }).__E2E_RC__.restore = "grant";
    });
    await button(page, "Restore purchases").click();
    await expect(button(page, "Pick a screen recording")).toBeVisible();
  });

  test("pricing that fails to load offers a retry that recovers", async ({ page, rc }) => {
    await rc({ subscribed: false, offerings: "error" });
    await page.goto("/");
    await button(page, "Skip to plans").click();
    await expect(page.getByText(/Couldn.t load pricing/)).toBeVisible();
    await snap(page, "paywall-pricing-error");

    await page.evaluate(() => {
      (window as unknown as { __E2E_RC__: { offerings: string } }).__E2E_RC__.offerings = "ok";
    });
    await button(page, "Retry loading pricing").click();
    await expect(page.getByRole("radio")).toHaveCount(3);
  });

  test("a store that returns no plans shows the retry, not a dead button", async ({ page, rc }) => {
    await rc({ subscribed: false, offerings: "empty" });
    await page.goto("/");
    await button(page, "Skip to plans").click();
    await expect(page.getByText(/Couldn.t load pricing/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Start|Subscribe|Buy)/ })).toHaveCount(0);
  });

  test("a subscriber goes straight to the app and never sees the plans", async ({ page, rc }) => {
    await rc({ subscribed: true });
    await page.goto("/");
    await expect(button(page, "Pick a screen recording")).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText("Go Pro", { exact: true })).toHaveCount(0);
  });
});
