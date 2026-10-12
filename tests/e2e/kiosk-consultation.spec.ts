import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  recommendProducts,
  type IngredientRule,
  type Product,
  type Questionnaire,
} from "../../src/domain";
import { buildSkinConsultation } from "../../src/domain/skin-consultation";
import {
  OPENAI_SKIN_DISCLAIMER,
  visibleRecommendationConcerns,
  type SkinVision,
} from "../../src/domain/skin-vision";

const id = "77777777-7777-4777-8777-777777777777";
const device = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  storeId: "22222222-2222-4222-8222-222222222222",
  deviceId: "33333333-3333-4333-8333-333333333333",
};
const policy: IngredientRule[] = [
  { concern: "texture", ingredient: "Niacinamide", relevance: 3 },
  { concern: "uneven_tone", ingredient: "Ascorbyl Glucoside", relevance: 3 },
  { concern: "fine_lines", ingredient: "Palmitoyl Tripeptide-1", relevance: 3 },
  { concern: "texture", ingredient: "Parfum", relevance: 1 },
];
const product: Product = {
  id: "44444444-4444-4444-8444-444444444444",
  ...device,
  sku: "REAL-SHELF-001",
  brand: "Registered merchant",
  name: "Store Registered Texture Serum",
  category: "serum",
  priceMinor: 2800,
  currency: "USD",
  stock: 4,
  visible: true,
  ingredients: ["Aqua", "Niacinamide"],
  formulaComplete: true,
  suitableSkinTypes: ["dry"],
  status: "published",
};
const otherStore = {
  ...product,
  id: "55555555-5555-4555-8555-555555555555",
  storeId: "66666666-6666-4666-8666-666666666666",
  name: "Other Store Product Never Shown",
};
const fragranceProduct = {
  ...product,
  id: "88888888-8888-4888-8888-888888888888",
  name: "Excluded Fragrance Product Never Shown",
  ingredients: ["Aqua", "Niacinamide", "Parfum"],
};

async function setup(
  page: Page,
  quality: SkinVision["image_quality"] | "no_photo" = "usable",
  emptyCatalog = false,
) {
  const state = {
    imageCalls: 0,
    explanationCalls: 0,
    finishCalls: 0,
    answers: {
      skinType: "dry",
      concerns: ["fine_lines"],
      sensitive: false,
      excludedIngredients: [],
    } as Questionnaire & { sensitive: boolean },
    report: null as ReturnType<typeof buildSkinConsultation> | null,
  };
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException("Synthetic camera denial", "NotAllowedError");
    };
  });
  await page.route("**/api/v1/context", (route) =>
    route.fulfill({
      json: {
        device,
        staff: null,
        mode: "demo",
        analysisMode: "openai",
        explanationAvailable: false,
      },
    }),
  );
  await page.route("**/api/v1/kiosk/sessions**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/answers")) state.answers = request.postDataJSON();
    if (pathname.endsWith("/explanation")) state.explanationCalls++;
    if (pathname.endsWith("/finish")) state.finishCalls++;
    let analysis = null;
    let recommendations: ReturnType<typeof recommendProducts> = [];
    if (pathname.endsWith("/analysis")) {
      const hasPhoto = request.headers()["content-type"]?.startsWith("image/");
      if (hasPhoto) state.imageCalls++;
      else expect(request.postDataJSON()).toEqual({});
      const vision: SkinVision | null =
        quality === "no_photo"
          ? null
          : {
              prompt_version: "visible-appearance-eval-v1",
              image_quality: quality,
              quality_flags:
                quality === "limited"
                  ? ["uneven_lighting"]
                  : quality === "not_assessable"
                    ? ["no_face"]
                    : [],
              observed_features: {
                visible_redness:
                  quality === "not_assessable" ? "not_assessable" : "visible",
                visible_spots:
                  quality === "not_assessable"
                    ? "not_assessable"
                    : "not_visible",
                visible_pores:
                  quality === "not_assessable" ? "not_assessable" : "visible",
                visible_fine_lines:
                  quality === "not_assessable" ? "not_assessable" : "uncertain",
                visible_flaking: "not_assessable",
              },
            };
      const goals = [
        ...new Set([
          ...state.answers.concerns,
          ...visibleRecommendationConcerns(vision),
        ]),
      ];
      recommendations = recommendProducts(
        emptyCatalog ? [] : [product, otherStore, fragranceProduct],
        { ...state.answers, concerns: goals },
        { ...device, rules: policy },
      );
      state.report = buildSkinConsultation({
        vision,
        questionnaire: state.answers,
        rules: policy,
        recommendations,
        policyVersion: "reviewed-store-policy-001",
      });
      analysis = {
        request_id: id,
        mode: "openai",
        model_version: "gpt-4.1-mini-2025-04-14",
        quality_status: vision?.image_quality ?? "not_provided",
        observations: [],
        disclaimer: OPENAI_SKIN_DISCLAIMER,
        vision,
      };
    }
    await route.fulfill({
      json: {
        id,
        ...device,
        createdAt: "2026-10-11T12:00:00Z",
        consent: true,
        consentVersion: "2026-10-openai-v1",
        answers: state.answers,
        analysis,
        recommendations,
        skinConsultation: state.report,
      },
    });
  });
  await page.goto("/kiosk/skin");
  await page.getByRole("button", { name: "Let's get started" }).click();
  await page
    .getByRole("checkbox", { name: /I agree to this temporary session/ })
    .check();
  if (quality !== "no_photo")
    await page
      .getByRole("checkbox", {
        name: "Analyze my photo with OpenAI (optional)",
      })
      .check();
  await page.getByRole("button", { name: "I agree, let's begin" }).click();
  await page
    .getByRole("button", { name: /Dry Often feels tight or dry/ })
    .click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Fine lines", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Fragrance", exact: true }).click();
  if (quality === "no_photo") {
    await page.getByRole("button", { name: "See my store matches" }).click();
  } else {
    await page.getByRole("button", { name: "Continue to photo" }).click();
    const base64 = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.locator('input[type="file"]').setInputFiles({
      name: "synthetic-consultation-test.png",
      mimeType: "image/png",
      buffer: Buffer.from(base64, "base64"),
    });
    await page
      .getByRole("button", { name: "Analyze my photo", exact: true })
      .click();
  }
  await expect(page.getByLabel("Personal skin consultation")).toBeVisible();
  return state;
}

test("professional consultation links observations to ingredients and only eligible registered products", async ({
  page,
}, testInfo) => {
  const state = await setup(page);
  expect(state.report?.status).toBe("photo_based");
  await expect(page.locator(".consultation-lead")).toHaveText(
    state.report!.summary,
  );
  await expect(page.locator(".consultation-priority")).toHaveCount(2);
  await expect(page.locator(".consultation-priorities")).toContainText(
    "Your selected goal",
  );
  await expect(page.locator(".consultation-priorities")).toContainText(
    "Visible in your photo",
  );
  await expect(page.locator(".consultation-ingredient")).toHaveCount(2);
  await expect(page.locator(".consultation-ingredients")).toContainText(
    "Niacinamide",
  );
  await expect(page.locator(".consultation-ingredients")).not.toContainText(
    "Parfum",
  );
  await expect(page.locator(".product-card")).toHaveCount(1);
  await expect(page.locator(".product-card")).toContainText(product.name);
  await expect(page.locator(".product-card")).toContainText("$28.00");
  await expect(page.locator(".consultation-product-reasons")).toContainText(
    "Niacinamide",
  );
  await expect(page.getByText(otherStore.name)).toHaveCount(0);
  await expect(page.getByText(fragranceProduct.name)).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "View 1 store match" }),
  ).toHaveAttribute("href", `#store-product-${product.id}`);
  await page.getByRole("link", { name: "View 1 store match" }).click();
  await expect(page.locator(`#store-product-${product.id}`)).toBeInViewport();
  await page
    .getByText("Explore your five photo observations", { exact: true })
    .click();
  await expect(page.locator(".vision-feature")).toHaveCount(5);
  for (const observation of state.report!.observations) {
    await expect(
      page.locator(".vision-feature").filter({
        has: page.getByRole("heading", {
          name: observation.label,
          exact: true,
        }),
      }),
    ).toContainText(observation.interpretation);
  }
  await expect(
    page.getByText(
      /Relative model outputs|Experimental model outputs|Confidence score/,
    ),
  ).toHaveCount(0);
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`consultation-${viewport.width}.png`),
      fullPage: true,
    });
  }
  expect(state.imageCalls).toBe(1);
  expect(state.explanationCalls).toBe(0);
  await page.getByRole("button", { name: "Finish & clear session" }).click();
  await expect(page.getByLabel("Personal skin consultation")).toHaveCount(0);
  expect(state.finishCalls).toBe(1);
});

test("empty store catalog still gives a professional consultation and ingredient guide", async ({
  page,
}) => {
  const state = await setup(page, "usable", true);
  await expect(page.locator(".consultation-lead")).toHaveText(
    state.report!.summary,
  );
  await expect(page.locator(".consultation-ingredient")).toHaveCount(2);
  await expect(page.locator(".consultation-unavailable")).toHaveCount(2);
  await expect(page.locator(".product-card")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /store match/ })).toHaveCount(0);
  await expect(
    page.getByText(/No available products meet all your preferences/),
  ).toBeVisible();
});

for (const quality of ["limited", "not_assessable", "no_photo"] as const) {
  test(`${quality} consultation keeps selected priorities and does not invent photo-based recommendations`, async ({
    page,
  }) => {
    const state = await setup(page, quality);
    await expect(page.locator(".consultation-priority")).toHaveCount(1);
    await expect(page.locator(".consultation-priorities")).not.toContainText(
      "Visible in your photo",
    );
    await expect(page.locator(".consultation-ingredient")).toHaveCount(1);
    await expect(page.locator(".consultation-ingredients")).not.toContainText(
      "Niacinamide",
    );
    await expect(page.locator(".consultation-ingredients")).toContainText(
      "Palmitoyl Tripeptide-1",
    );
    await expect(page.locator(".product-card")).toHaveCount(0);
    await expect(page.locator(".consultation-lead")).toHaveText(
      state.report!.summary,
    );
    expect(state.imageCalls).toBe(quality === "no_photo" ? 0 : 1);
    expect(state.explanationCalls).toBe(0);
    if (quality === "no_photo")
      await expect(page.locator(".vision-feature")).toHaveCount(0);
    else {
      await page
        .getByText("Explore your five photo observations", { exact: true })
        .click();
      await expect(page.locator(".vision-feature")).toHaveCount(5);
      await expect(
        page.getByRole("list", { name: "Photo limitations" }),
      ).toBeVisible();
    }
  });
}
