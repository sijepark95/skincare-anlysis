import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { demoProducts } from "../../src/domain/demo-catalog";

const product = demoProducts.find((item) => item.sku === "SEN-HYDRATE-01")!;
const sessionId = "77777777-7777-4777-8777-777777777777";
const visualCodes = {
  sensitivity: ["NS", "S"],
  pigmentation: ["P0", "P1", "P2"],
  wrinkles: ["W0", "W1", "W2"],
  acne: ["NA", "A"],
  pores: ["NVP", "VP"],
  sagging: ["NSA", "SA"],
  keratin: ["ND", "D"],
  redness: ["NR", "R"],
};

// Entirely synthetic browser fixtures: no Auth, mail, image service or LLM calls.
async function mockConsultation(page: Page, experimental = false) {
  let explanationCalls = 0;
  let consent = false;
  let answers = {
    skinType: "dry",
    concerns: ["dehydration"],
    excludedIngredients: [] as string[],
    sensitive: false,
  };
  await page.route("**/api/v1/context", (route) =>
    route.fulfill({
      json: {
        device: {
          organizationId: product.organizationId,
          storeId: product.storeId,
          deviceId: "99999999-9999-4999-8999-999999999999",
        },
        staff: null,
        mode: "demo",
        analysisMode: experimental ? "experimental" : "mock",
        explanationAvailable: true,
      },
    }),
  );
  await page.route("**/api/v1/kiosk/sessions**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/consent")) {
      consent = route.request().postDataJSON().accepted === true;
      expect(route.request().postDataJSON().explanationAccepted).toBe(false);
    }
    if (pathname.endsWith("/answers")) answers = route.request().postDataJSON();
    if (pathname.endsWith("/explanation")) explanationCalls++;
    const analysis = {
      request_id: sessionId,
      mode: experimental ? "experimental" : "mock",
      quality_status: experimental ? "experimental" : "demo",
      model_version: "synthetic-layout-fixture",
      observations: [],
      disclaimer: "Experimental interface fixture, not a diagnosis.",
      ...(experimental
        ? {
            visual: {
              model_version: "synthetic-layout-visual",
              heads: Object.entries(visualCodes).map(([key, codes]) => ({
                key,
                label: key,
                predicted_code: codes[0],
                probabilities: codes.map((code, index) => ({
                  code,
                  probability: index === 0 ? 0.8 : 0.2 / (codes.length - 1),
                })),
              })),
            },
            ingredients: {
              model_version: "synthetic-layout-ingredients",
              candidates: [{ ingredient: "Glycerin", score: 0.7 }],
              input_coverage: [
                "partial_questionnaire_features",
                "visual_condition_unseen_in_training_omitted",
              ],
            },
          }
        : {}),
    };
    await route.fulfill({
      json: {
        id: sessionId,
        organizationId: product.organizationId,
        storeId: product.storeId,
        deviceId: "99999999-9999-4999-8999-999999999999",
        createdAt: "2026-10-11T12:00:00Z",
        consent,
        consentVersion: "synthetic-layout-notice",
        explanationConsent: { accepted: false },
        answers,
        analysis,
        recommendations: [
          {
            product,
            score: 2,
            matchedIngredients: ["Glycerin"],
            reasons: [
              { concern: "dehydration", ingredient: "Glycerin", relevance: 2 },
            ],
          },
        ],
        explanation: null,
      },
    });
  });
  await page.goto("/kiosk/skin");
  return { explanationCalls: () => explanationCalls };
}

async function expectTouchLayout(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  const undersized = await page
    .locator(".kiosk button, .kiosk .check-row, .kiosk summary, .kiosk a")
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const bounds = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (
          !bounds.width ||
          !bounds.height ||
          style.visibility === "hidden" ||
          style.display === "none"
        )
          return [];
        return bounds.height < 55.5
          ? [{ text: element.textContent?.trim(), height: bounds.height }]
          : [];
      }),
    );
  expect(undersized).toEqual([]);
}

async function expectTabletAction(page: Page, action: Locator) {
  if (page.viewportSize()!.width < 768) return;
  const bounds = await action.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height,
  );
}

async function preferences(page: Page) {
  await page.getByRole("button", { name: "Let's get started" }).click();
  const agreement = page.getByRole("checkbox", {
    name: /I agree to this temporary session/,
  });
  await expect(agreement).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Add an AI explanation (optional)" }),
  ).not.toBeChecked();
  await expectTouchLayout(page);
  await page.screenshot({
    path: test.info().outputPath("consent.png"),
    fullPage: true,
  });
  await agreement.focus();
  await page.keyboard.press("Space");
  await expect(agreement).toBeChecked();
  await page.getByRole("button", { name: "I agree, let's begin" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expectTouchLayout(page);
  await expectTabletAction(
    page,
    page.getByRole("button", { name: "Continue", exact: true }),
  );
  await page
    .getByRole("button", { name: /Dry Often feels tight or dry/ })
    .click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expectTouchLayout(page);
  await expectTabletAction(
    page,
    page.getByRole("button", { name: "Continue", exact: true }),
  );
  const hydration = page.getByRole("button", {
    name: "Hydration",
    exact: true,
  });
  await hydration.focus();
  await page.keyboard.press("Space");
  await expect(hydration).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expectTouchLayout(page);
  await expectTabletAction(
    page,
    page.getByRole("button", { name: "Continue to photo" }),
  );
  await page.getByRole("button", { name: "Continue to photo" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expectTouchLayout(page);
  await page.screenshot({
    path: test.info().outputPath("camera.png"),
    fullPage: true,
  });
}

for (const viewport of [
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]) {
  test(`guest journey preserves touch layout and keyboard choices at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const state = await mockConsultation(page);
    await expect(
      page.getByRole("button", { name: "Let's get started" }),
    ).toBeEnabled();
    await expectTouchLayout(page);
    await expectTabletAction(
      page,
      page.getByRole("button", { name: "Let's get started" }),
    );
    await page.screenshot({
      path: testInfo.outputPath("welcome.png"),
      fullPage: true,
    });
    await preferences(page);
    await page
      .getByRole("button", { name: "Continue with mock experience" })
      .click();
    await expect(page.locator(".product-card")).toContainText(product.name);
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await expectTouchLayout(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(state.explanationCalls()).toBe(0);
    await page.screenshot({
      path: testInfo.outputPath("results.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Finish & clear session" }).click();
    await expect(page.locator(".product-card")).toHaveCount(0);
    await page.getByRole("button", { name: "Let's get started" }).click();
    await expect(
      page.getByRole("checkbox", { name: /I agree to this temporary session/ }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "Add an AI explanation (optional)" }),
    ).not.toBeChecked();
    await page
      .getByRole("button", { name: "End session", exact: true })
      .click();
  });
}

test("experimental products precede technical details, which open with the keyboard", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockConsultation(page, true);
  await preferences(page);
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic-layout.png",
    mimeType: "image/png",
    buffer: Buffer.from(base64, "base64"),
  });
  await page.getByRole("button", { name: "Analyze my photo" }).click();
  const productCard = page.locator(".product-card");
  await expect(productCard).toContainText(product.name);
  const details = page.locator("details.analysis-details");
  const summary = details.locator("summary").first();
  await expect(summary).toHaveText("About your experimental results");
  await expect(details).not.toHaveAttribute("open", "");
  expect(
    await productCard.evaluate((card) => {
      const technicalDetails = document.querySelector(
        "details.analysis-details",
      );
      return Boolean(
        technicalDetails &&
        card.compareDocumentPosition(technicalDetails) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }),
  ).toBe(true);
  await expect(page.locator(".model-code").first()).not.toBeVisible();
  await expectTouchLayout(page);
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  await expect(page.locator(".model-code")).toHaveCount(8);
  await expect(page.locator(".model-code").first()).toBeVisible();
  await expectTouchLayout(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("experimental-details.png"),
    fullPage: true,
  });
  await page.keyboard.press("Space");
  await expect(details).not.toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Finish & clear session" }).click();
});
