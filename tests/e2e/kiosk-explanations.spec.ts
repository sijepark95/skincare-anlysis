import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { demoProducts } from "../../src/domain/demo-catalog";

const id = "88888888-8888-4888-8888-888888888888";
const product = demoProducts.find((item) => item.sku === "SEN-HYDRATE-01")!;
const secondProduct = demoProducts.find(
  (item) => item.sku === "SEN-BARRIER-01",
)!;
const matchText =
  "Glycerin appears in this product's registered ingredients and matches your hydration goal through the store's policy.";
const summary =
  "These notes describe existing ingredient matches. They do not establish effectiveness or safety.";

function fixture(accepted: boolean, extraProduct = false) {
  const recommendations = [
    {
      product,
      score: 2,
      matchedIngredients: ["Glycerin"],
      reasons: [
        { concern: "dehydration", ingredient: "Glycerin", relevance: 2 },
      ],
    },
  ];
  if (extraProduct)
    recommendations.push({ ...recommendations[0], product: secondProduct });
  return {
    id,
    organizationId: product.organizationId,
    storeId: product.storeId,
    deviceId: "99999999-9999-4999-8999-999999999999",
    createdAt: "2026-10-11T12:00:00Z",
    consent: true,
    consentVersion: "2026-10-mvp",
    explanationConsent: { accepted },
    answers: {
      skinType: "dry",
      concerns: ["dehydration"],
      excludedIngredients: [],
      sensitive: false,
    },
    analysis: {
      request_id: id,
      mode: "mock",
      quality_status: "demo",
      model_version: "synthetic-explanation-browser-fixture",
      observations: [],
      disclaimer: "Mock result for interface testing.",
    },
    recommendations,
    explanation: null,
  };
}

async function setup(
  page: Page,
  options: {
    available?: boolean;
    extraProduct?: boolean;
    explain?: (
      route: Route,
      session: ReturnType<typeof fixture>,
    ) => Promise<void>;
  } = {},
) {
  let accepted = false;
  let explanationCalls = 0;
  const consentBodies: unknown[] = [];
  await page.route("**/api/v1/context", (route) =>
    route.fulfill({
      json: {
        device: {
          organizationId: product.organizationId,
          storeId: product.storeId,
          deviceId: fixture(false).deviceId,
        },
        staff: null,
        mode: "demo",
        analysisMode: "mock",
        explanationAvailable: options.available ?? true,
      },
    }),
  );
  await page.route("**/api/v1/kiosk/sessions**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/consent")) {
      const body = route.request().postDataJSON();
      consentBodies.push(body);
      accepted = body.explanationAccepted === true;
    }
    if (pathname.endsWith("/explanation")) {
      explanationCalls++;
      expect(route.request().postDataJSON()).toEqual({});
      if (options.explain) {
        await options.explain(route, fixture(accepted, options.extraProduct));
        return;
      }
    }
    await route.fulfill({ json: fixture(accepted, options.extraProduct) });
  });
  await page.goto("/kiosk/skin");
  await page.getByRole("button", { name: "Let's get started" }).click();
  return {
    consentBodies,
    explanationCalls: () => explanationCalls,
  };
}

async function analyze(page: Page, optIn = false) {
  await page
    .getByRole("checkbox", { name: /I agree to this temporary session/ })
    .check();
  if (optIn)
    await page
      .getByRole("checkbox", { name: "Add an AI explanation (optional)" })
      .check();
  await page.getByRole("button", { name: "I agree, let's begin" }).click();
  await page
    .getByRole("button", { name: /Dry Often feels tight or dry/ })
    .click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Hydration", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue to photo" }).click();
  await page
    .getByRole("button", { name: "Continue with mock experience" })
    .click();
  await expect(page.locator(".product-card").first()).toContainText(
    product.name,
  );
}

test("external explanation is a separate unticked choice and does not block discovery", async ({
  page,
}) => {
  const state = await setup(page);
  const option = page.getByRole("checkbox", {
    name: "Add an AI explanation (optional)",
  });
  await expect(option).not.toBeChecked();
  await expect(page.locator("#explanation-privacy")).toContainText(
    "No photo, identity, raw analysis or training records are sent.",
  );
  await expect(page.locator("#explanation-privacy")).toContainText("30 days");
  for (const width of [1024, 768, 390]) {
    await page.setViewportSize({ width, height: 768 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
  await analyze(page);
  expect(state.consentBodies).toEqual([
    { accepted: true, explanationAccepted: false },
  ]);
  expect(state.explanationCalls()).toBe(0);
  await expect(page.locator(".product-card")).toContainText(
    "Matched to hydration through the store's ingredient policy.",
  );
  await expect(page.getByLabel("Recommendation explanation")).toHaveCount(0);
});

test("products appear immediately while opted-in notes load, then show verified match notes", async ({
  page,
}) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = await setup(page, {
    explain: async (route, session) => {
      await delayed;
      await route.fulfill({
        json: {
          ...session,
          explanation: {
            status: "generated",
            summary,
            products: [{ productId: product.id, text: matchText }],
          },
        },
      });
    },
  });
  await analyze(page, true);
  await expect(page.getByRole("status")).toHaveText(
    "Preparing your recommendation notes…",
  );
  await expect(
    page.getByRole("button", { name: "Finish & clear session" }),
  ).toBeEnabled();
  release();
  await expect(page.getByText("AI-assisted match explanation")).toBeVisible();
  await expect(page.getByLabel("Recommendation explanation")).toContainText(
    summary,
  );
  await expect(page.locator(".product-card")).toContainText(matchText);
  await expect(page.getByRole("status")).toHaveCount(0);
  expect(state.consentBodies).toEqual([
    { accepted: true, explanationAccepted: true },
  ]);
  expect(state.explanationCalls()).toBe(1);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("provider refusal uses plain fallback notes without changing products", async ({
  page,
}) => {
  await setup(page, {
    explain: async (route, session) => {
      await route.fulfill({
        json: {
          ...session,
          explanation: {
            status: "fallback",
            summary,
            products: [{ productId: product.id, text: matchText }],
          },
        },
      });
    },
  });
  await analyze(page, true);
  await expect(
    page.getByText("Why these matched", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("AI-assisted match explanation")).toHaveCount(0);
  await expect(page.locator(".product-card")).toContainText(matchText);
  await expect(page.locator(".notice.error")).toHaveCount(0);
});

test("notes completion removes newly ineligible products and their notes", async ({
  page,
}) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const secondText =
    "Glycerin matches this product through the store's policy.";
  await setup(page, {
    extraProduct: true,
    explain: async (route, session) => {
      await delayed;
      await route.fulfill({
        json: {
          ...session,
          recommendations: session.recommendations.filter(
            (item) => item.product.id !== product.id,
          ),
          explanation: {
            status: "generated",
            summary,
            products: [
              { productId: product.id, text: matchText },
              { productId: secondProduct.id, text: secondText },
            ],
          },
        },
      });
    },
  });
  await analyze(page, true);
  await expect(page.locator(".product-card")).toHaveCount(2);
  release();
  await expect(page.getByText("AI-assisted match explanation")).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(1);
  await expect(page.locator(".product-card")).toContainText(secondProduct.name);
  await expect(page.locator(".product-card")).toContainText(secondText);
  await expect(page.getByText(product.name, { exact: true })).toHaveCount(0);
  await expect(page.getByText(matchText, { exact: true })).toHaveCount(0);
});

test("notes cannot add products, reorder existing matches or replace product data", async ({
  page,
}) => {
  const unknown = demoProducts.find((item) => item.sku === "SEN-TONE-01")!;
  await setup(page, {
    extraProduct: true,
    explain: async (route, session) => {
      await route.fulfill({
        json: {
          ...session,
          recommendations: [
            { ...session.recommendations[0], product: unknown },
            ...[...session.recommendations].reverse().map((item) => ({
              ...item,
              product: { ...item.product, name: "Untrusted replacement name" },
            })),
          ],
          explanation: {
            status: "generated",
            summary,
            products: [
              { productId: product.id, text: matchText },
              { productId: unknown.id, text: "Unselected product note" },
            ],
          },
        },
      });
    },
  });
  await analyze(page, true);
  await expect(page.getByText("AI-assisted match explanation")).toBeVisible();
  await expect(page.locator(".product-card h3")).toHaveText([
    product.name,
    secondProduct.name,
  ]);
  await expect(page.getByText(unknown.name, { exact: true })).toHaveCount(0);
  await expect(page.getByText("Untrusted replacement name")).toHaveCount(0);
  await expect(page.getByText("Unselected product note")).toHaveCount(0);
});

test("an unavailable notes endpoint leaves the existing reviewed reasons usable", async ({
  page,
}) => {
  await setup(page, {
    explain: async (route) => {
      await route.fulfill({
        status: 503,
        json: { error: { code: "unavailable", message: "Unavailable" } },
      });
    },
  });
  await analyze(page, true);
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.locator(".product-card")).toContainText(
    "Matched to hydration through the store's ingredient policy.",
  );
  await expect(page.locator(".notice.error")).toHaveCount(0);
  await page.getByRole("button", { name: "Finish & clear session" }).click();
  await expect(
    page.getByRole("button", { name: "Let's get started" }),
  ).toBeVisible();
});

test("late notes cannot restore a finished session and the next guest starts without opt-in", async ({
  page,
}) => {
  let release!: () => void;
  let complete!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  await setup(page, {
    explain: async (route, session) => {
      await delayed;
      await route
        .fulfill({
          json: {
            ...session,
            explanation: {
              status: "generated",
              summary,
              products: [{ productId: product.id, text: matchText }],
            },
          },
        })
        .catch(() => undefined);
      complete();
    },
  });
  await analyze(page, true);
  await expect(page.getByRole("status")).toBeVisible();
  await page.getByRole("button", { name: "Finish & clear session" }).click();
  release();
  await completed;
  await expect(
    page.getByRole("button", { name: "Let's get started" }),
  ).toBeVisible();
  await expect(page.locator(".product-card")).toHaveCount(0);
  await expect(page.getByLabel("Recommendation explanation")).toHaveCount(0);
  await page.getByRole("button", { name: "Let's get started" }).click();
  await expect(
    page.getByRole("checkbox", { name: "Add an AI explanation (optional)" }),
  ).not.toBeChecked();
});

test("an unconfigured explanation service adds no consent choice or external request", async ({
  page,
}) => {
  const state = await setup(page, { available: false });
  await expect(
    page.getByRole("checkbox", { name: "Add an AI explanation (optional)" }),
  ).toHaveCount(0);
  await analyze(page);
  expect(state.consentBodies).toEqual([{ accepted: true }]);
  expect(state.explanationCalls()).toBe(0);
});
