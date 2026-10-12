import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("localhost development signup reaches the same-origin demo registration guard", async ({
  page,
}) => {
  await page.goto("http://localhost:3100/management/signup");
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/v1/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await response.json();
    return { status: response.status, code: body.error?.code };
  });
  expect(result).toEqual({ status: 503, code: "signup_requires_supabase" });
});

test("staff login explains a network failure and allows a successful retry", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/v1/auth/login", (route) =>
    ++attempts === 1
      ? route.abort("internetdisconnected")
      : route.fulfill({ json: { ok: true } }),
  );
  await page.goto("/management/login");
  await page.getByLabel("Email address").fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Check your internet connection",
  );
  await expect(page.getByLabel("Email address")).toHaveValue(
    "owner@example.test",
  );
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page).toHaveURL(/\/management$/);
  await expect(
    page.getByRole("heading", { name: "Your store, at a glance." }),
  ).toBeVisible();
});

test("pairing accepts a pasted code, keeps it after a failure and allows retry", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/v1/device/pair", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      code: "ABCD1234ABCD1234",
    });
    if (++attempts === 1)
      await route.fulfill({
        status: 400,
        json: {
          error: {
            code: "invalid_code",
            message:
              "This code is invalid, expired or already used. Create a new code in your store workspace and try again.",
          },
        },
      });
    else await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/kiosk/pair");
  await page
    .getByLabel("Pairing code", { exact: true })
    .fill("abcd1234abcd1234");
  await expect(page.getByLabel("Pairing code", { exact: true })).toHaveValue(
    "ABCD 1234 ABCD 1234",
  );
  await page.getByRole("button", { name: "Pair this tablet" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Create a new code",
  );
  await expect(page.getByLabel("Pairing code", { exact: true })).toHaveValue(
    "ABCD 1234 ABCD 1234",
  );
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Pair this tablet" }).click();
  await expect(page).toHaveURL(/\/kiosk$/);
});

test("device setup shows errors inside the dialog and retires an expired code", async ({
  page,
}, testInfo) => {
  let attempts = 0;
  await page.route("**/api/v1/management/pairing-codes?*", (route) => {
    if (++attempts === 1)
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: "request_capacity",
            message: "The service is busy. Please try again shortly.",
          },
        },
      });
    return route.fulfill({
      json: {
        code: "ABCD1234ABCD1234",
        expiresAt: new Date(Date.now() + 4000).toISOString(),
      },
    });
  });
  await page.goto("/management/devices");
  await page.getByRole("button", { name: "Pair new device" }).click();
  const dialog = page.getByRole("dialog", { name: "Pair a new device" });
  await expect(dialog).toContainText("Soho Studio");
  await dialog.getByLabel("Device name").fill("Front counter tablet");
  await dialog.getByRole("button", { name: "Create pairing code" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Please try again shortly",
  );
  await dialog.getByRole("button", { name: "Create pairing code" }).click();
  await expect(dialog.getByLabel("Pairing code")).toHaveText(
    "ABCD 1234 ABCD 1234",
  );
  await page.screenshot({
    path: testInfo.outputPath("device-pairing-1024x768.png"),
  });
  await expect(dialog.getByRole("status")).toContainText(
    "This code has expired",
  );
  await expect(dialog.getByLabel("Pairing code")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Create pairing code" }),
  ).toBeVisible();
});

test("an expired staff session returns to login before showing store data", async ({
  page,
}) => {
  await page.route("**/api/v1/management/overview?*", (route) =>
    route.fulfill({
      status: 401,
      json: {
        error: {
          code: "sign_in_required",
          message: "Please sign in to your workspace.",
        },
      },
    }),
  );
  await page.goto("/management");
  await expect(page).toHaveURL(/\/management\/login$/);
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
});

test("auth forms keep credentials and pairing codes out of URLs before JavaScript is ready", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  for (const [path, input, button] of [
    ["/management/login", "Email address", "Sign in to workspace"],
    ["/kiosk/pair", "Pairing code", "Pair this tablet"],
  ]) {
    await page.goto(`http://127.0.0.1:3100${path}`);
    await expect(page.getByLabel(input, { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: button })).toBeDisabled();
    await expect(page.locator("form")).toHaveAttribute("method", "post");
  }
  await context.close();
});
