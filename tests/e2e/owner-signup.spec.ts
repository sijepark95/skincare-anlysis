import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/email-delivery", (route) =>
    route.fulfill({ json: { mode: "smtp" } }),
  );
});

test("local signup explains captured email and keeps the development inbox accessible during verification", async ({
  page,
}, testInfo) => {
  await page.route("**/api/v1/auth/email-delivery", (route) =>
    route.fulfill({
      json: { mode: "local", inboxUrl: "http://127.0.0.1:15434" },
    }),
  );
  await page.route("**/api/v1/auth/signup", (route) =>
    route.fulfill({ json: { next: "verify_email" } }),
  );
  await page.route("**/api/v1/auth/resend-confirmation", (route) =>
    route.fulfill({ json: { sent: true } }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/management/signup");
  const inbox = page.getByRole("link", { name: "Open development inbox" });
  await expect(inbox).toHaveAttribute("href", "http://127.0.0.1:15434");
  await expect(inbox).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.locator("#email-delivery-notice")).toContainText(
    "not sent to your personal inbox",
  );
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("local-email-signup-390.png"),
  });
  await page.getByLabel("Email address").fill("local-owner@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("a-long-test-passphrase");
  await page.getByLabel("Confirm password").fill("a-long-test-passphrase");
  await page.getByRole("button", { name: "Create owner account" }).click();
  await expect(
    page.getByRole("heading", { name: "Find your verification code." }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "development inbox below",
  );
  await expect(page.getByRole("status")).not.toContainText("spam");
  await expect(inbox).toBeVisible();
  await page.getByRole("button", { name: "Send a new code" }).click();
  await expect(page.getByRole("status")).toContainText("awaiting confirmation");
  await expect(page.getByRole("status")).toContainText(
    "No email is sent to your personal inbox",
  );
});

test("unknown email delivery does not promise a sent email or expose a development inbox", async ({
  page,
}) => {
  await page.route("**/api/v1/auth/email-delivery", (route) =>
    route.fulfill({ json: { mode: "unknown" } }),
  );
  await page.route("**/api/v1/auth/signup", (route) =>
    route.fulfill({ json: { next: "verify_email" } }),
  );
  await page.goto("/management/signup");
  await page.getByLabel("Email address").fill("owner@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("a-long-test-passphrase");
  await page.getByLabel("Confirm password").fill("a-long-test-passphrase");
  await page.getByRole("button", { name: "Create owner account" }).click();
  await expect(
    page.getByRole("heading", { name: "Verify your email." }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "not been configured or confirmed",
  );
  await expect(
    page.getByRole("link", { name: "Open development inbox" }),
  ).toHaveCount(0);
});

test("owner signup confirms email and creates a workspace without putting credentials in URLs", async ({
  page,
}, testInfo) => {
  await page.route("**/api/v1/auth/signup", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      email: "new-owner@example.test",
      password: "a-long-test-passphrase",
    });
    await route.fulfill({ json: { next: "verify_email" } });
  });
  await page.route("**/api/v1/auth/verify-email", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      email: "new-owner@example.test",
      token: "12345678",
    });
    await route.fulfill({ json: { next: "setup" } });
  });
  await page.route("**/api/v1/auth/account", (route) =>
    route.fulfill({
      json: { authenticated: true, needsWorkspace: true, staff: null },
    }),
  );
  await page.route("**/api/v1/auth/workspace", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      organizationName: "The Beauty Company",
      storeName: "Uptown Studio",
    });
    await route.fulfill({ json: { staff: {} } });
  });

  await page.goto("/management/login");
  await page.getByRole("link", { name: "New to AELUNE? Sign up" }).click();
  await expect(page).toHaveURL(/\/management\/signup$/);
  await page.getByLabel("Email address").fill("new-owner@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("a-long-test-passphrase");
  await page.getByLabel("Confirm password").fill("a-long-test-passphrase");
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("owner-signup-390.png") });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Create owner account" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your inbox." }),
  ).toBeVisible();
  await expect(page.getByLabel("Verification code")).toBeFocused();
  await page.getByLabel("Verification code").fill("12345678");
  await page.getByRole("button", { name: "Verify email", exact: true }).click();
  await expect(page).toHaveURL(/\/management\/setup$/);
  await page.getByLabel("Company name").fill("The Beauty Company");
  await page.getByLabel("First store name").fill("Uptown Studio");
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("owner-setup-390.png") });
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/management$/);
});

test("signup prevents short or mismatched passwords and reports an actionable setup failure", async ({
  page,
}) => {
  let signupRequests = 0;
  await page.route("**/api/v1/auth/signup", (route) => {
    signupRequests++;
    return route.fulfill({
      status: 503,
      json: {
        error: {
          code: "signup_unavailable",
          message: "Connect Supabase to enable owner registration.",
        },
      },
    });
  });
  await page.goto("/management/signup");
  await page.getByLabel("Email address").fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill("short");
  await page.getByLabel("Confirm password").fill("short");
  await page.getByRole("button", { name: "Create owner account" }).click();
  expect(
    await page
      .getByLabel("Password", { exact: true })
      .evaluate((input: HTMLInputElement) => input.validity.tooShort),
  ).toBe(true);
  expect(signupRequests).toBe(0);
  await page
    .getByLabel("Password", { exact: true })
    .fill("a-long-test-passphrase");
  await page.getByLabel("Confirm password").fill("different-passphrase");
  await page.getByRole("button", { name: "Create owner account" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Passwords do not match",
  );
  await expect(page.getByLabel("Confirm password")).toBeFocused();
  expect(signupRequests).toBe(0);
  await page.getByLabel("Confirm password").fill("a-long-test-passphrase");
  await page.getByRole("button", { name: "Create owner account" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Connect Supabase",
  );
  await expect(
    page.getByRole("button", { name: "Create owner account" }),
  ).toBeEnabled();
});

test("email verification supports code recovery and a failed code can be retried", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/v1/auth/verify-email", (route) =>
    ++attempts === 1
      ? route.fulfill({
          status: 400,
          json: {
            error: {
              code: "verification_failed",
              message:
                "This code is invalid or expired. Request a new code and try again.",
            },
          },
        })
      : route.fulfill({ json: { next: "management" } }),
  );
  await page.route("**/api/v1/auth/resend-confirmation", (route) =>
    route.fulfill({ json: { sent: true } }),
  );
  await page.goto("/management/signup");
  await page
    .getByRole("button", { name: "Already have a verification code?" })
    .click();
  await expect(page.getByLabel("Email address")).toBeFocused();
  await page.getByLabel("Email address").fill("returning-owner@example.test");
  await page.getByRole("button", { name: "Send a new code" }).click();
  await expect(page.getByRole("status")).toContainText(
    "If this address is awaiting confirmation",
  );
  await page.getByLabel("Verification code").fill("123456");
  await page.getByRole("button", { name: "Verify email", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "invalid or expired",
  );
  await expect(page.getByLabel("Verification code")).toHaveValue("123456");
  await page.getByRole("button", { name: "Verify email", exact: true }).click();
  await expect(page).toHaveURL(/\/management$/);
});

test("a verified owner resumes unfinished workspace setup after sign in", async ({
  page,
}) => {
  await page.route("**/api/v1/auth/login", (route) =>
    route.fulfill({ json: { next: "setup" } }),
  );
  await page.route("**/api/v1/auth/account", (route) =>
    route.fulfill({
      json: { authenticated: true, needsWorkspace: true, staff: null },
    }),
  );
  await page.goto("/management/login");
  await page.getByLabel("Email address").fill("owner@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("a-long-test-passphrase");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(page).toHaveURL(/\/management\/setup$/);
  await expect(page.getByLabel("Company name")).toBeEnabled();
  await page.route("**/api/v1/context", (route) =>
    route.fulfill({ json: { mode: "supabase", staff: null, device: null } }),
  );
  await page.goto("/management");
  await expect(page).toHaveURL(/\/management\/setup$/);
  await expect(page.getByLabel("Company name")).toBeEnabled();
});

test("workspace setup guards signed out users and offers a retry after a connection failure", async ({
  page,
}) => {
  let networkUnavailable = true;
  await page.route("**/api/v1/auth/account", (route) =>
    networkUnavailable
      ? route.abort("internetdisconnected")
      : route.fulfill({
          json: { authenticated: false, needsWorkspace: false, staff: null },
        }),
  );
  await page.goto("/management/setup");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Check your internet connection",
  );
  await expect(page.getByLabel("Company name")).toBeDisabled();
  networkUnavailable = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page).toHaveURL(/\/management\/login$/);
});

test("signup and workspace forms stay disabled before JavaScript can protect their submissions", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  for (const [path, field, button] of [
    ["/management/signup", "Email address", "Create owner account"],
    ["/management/setup", "Company name", "Create workspace"],
  ]) {
    await page.goto(`http://127.0.0.1:3100${path}`);
    await expect(page.getByLabel(field, { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: button })).toBeDisabled();
    await expect(page.locator("form")).toHaveAttribute("method", "post");
  }
  await context.close();
});
