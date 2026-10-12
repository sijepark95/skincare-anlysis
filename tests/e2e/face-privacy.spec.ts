import { expect, test } from "@playwright/test";

test("client navigation keeps same-origin face assets and blocks SDK metrics", async ({
  page,
}) => {
  let externalRequests = 0;
  await page.route("https://odml.pa.googleapis.com/**", (route) => {
    externalRequests++;
    return route.abort();
  });
  const response = await page.goto("/");
  expect(response?.headers()["content-security-policy"]).toContain(
    "connect-src 'self' ws://127.0.0.1:3100;",
  );
  await page
    .getByRole("link", { name: "Find your beauty direction", exact: true })
    .click();
  await expect(page).toHaveURL(/\/kiosk$/);
  await expect(
    page.getByRole("heading", {
      name: /Your face\. Your colors\. Your possibilities\./i,
    }),
  ).toBeVisible();

  const checks = await page.evaluate(async () => {
    const violations: string[] = [];
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      violations.push(event.effectiveDirective);
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    const health = await fetch("/api/v1/healthz");
    const model = await fetch("/face/blaze-face-short-range-v1.tflite");
    const wasmLoader = await fetch(
      "/face/mediapipe-1.1.0/wasm/vision_wasm_internal.js",
    );
    let externalAllowed = false;
    try {
      await fetch("https://odml.pa.googleapis.com/v1/log", {
        method: "POST",
        body: "synthetic-csp-test",
      });
      externalAllowed = true;
    } catch {
      // A browser-enforced CSP rejection is the expected privacy boundary.
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.removeEventListener("securitypolicyviolation", onViolation);
    return {
      health: health.ok,
      model: model.ok,
      wasmLoader: wasmLoader.ok,
      externalAllowed,
      violations,
    };
  });
  expect(checks.health).toBe(true);
  expect(checks.model).toBe(true);
  expect(checks.wasmLoader).toBe(true);
  expect(checks.externalAllowed).toBe(false);
  expect(checks.violations).toContain("connect-src");
  // Interception happens after CSP: a blocked POST never reaches networking.
  expect(externalRequests).toBe(0);
});
