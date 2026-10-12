import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { demoProducts } from "../../src/domain/demo-catalog";

const codes = {
  sensitivity: ["NS", "S"],
  pigmentation: ["P0", "P1", "P2"],
  wrinkles: ["W0", "W1", "W2"],
  acne: ["NA", "A"],
  pores: ["NVP", "VP"],
  sagging: ["NSA", "SA"],
  keratin: ["ND", "D"],
  redness: ["NR", "R"],
};
async function prepare(page: Page, includePhoto = true) {
  await page.route("**/api/v1/context", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), analysisMode: "experimental" },
    });
  });
  await page.goto("/kiosk/skin");
  await page.getByRole("button", { name: "Let's get started" }).click();
  await expect(
    page.getByText(/sent to this installation's private analysis service/),
  ).toBeVisible();
  await expect(
    page.getByText(/answers and supported codes from your optional photo/),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: /I agree to this temporary session/ })
    .check();
  await page.getByRole("button", { name: "I agree, let's begin" }).click();
  await page
    .getByRole("button", { name: /Dry Often feels tight or dry/ })
    .click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Fine lines", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue to photo" }).click();
  if (!includePhoto) return;
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic.png",
    mimeType: "image/png",
    buffer: Buffer.from(base64, "base64"),
  });
  await expect(
    page.getByRole("img", { name: "Your temporary photo preview" }),
  ).toBeVisible();
}
function model(id: string, inputCoverage = ["partial_questionnaire_features"]) {
  return {
    request_id: id,
    mode: "experimental",
    quality_status: "experimental",
    model_version: "synthetic-ui-fixture",
    observations: [],
    disclaimer: "Experimental model fixture; not a diagnosis.",
    visual: {
      model_version: "synthetic-visual",
      heads: Object.entries(codes).map(([key, values]) => ({
        key,
        label: key,
        predicted_code: values[0],
        probabilities: values.map((code, i) => ({
          code,
          probability: i === 0 ? 0.8 : 0.2 / (values.length - 1),
        })),
      })),
    },
    ingredients: {
      model_version: "synthetic-ingredients",
      candidates: [{ ingredient: "Niacinamide", score: 0.7 }],
      input_coverage: inputCoverage,
    },
  };
}

test("experimental photo errors retain the preview and allow choosing another photo or retrying", async ({
  page,
}) => {
  let attempts = 0;
  await page.route("**/api/v1/kiosk/sessions/*/analysis", async (route) => {
    expect(route.request().headers()["content-type"]).toBe("image/png");
    expect(route.request().postDataBuffer()?.length).toBeGreaterThan(0);
    if (++attempts === 1) {
      await route.fulfill({
        status: 422,
        json: {
          error: {
            code: "photo_not_supported",
            message: "Choose another clear photo and try again.",
          },
        },
      });
      return;
    }
    const session = await (
      await page.request.get(
        route
          .request()
          .url()
          .replace(/\/analysis$/, ""),
      )
    ).json();
    await route.fulfill({
      json: { ...session, analysis: model(session.id), recommendations: [] },
    });
  });
  await prepare(page);
  await page.getByRole("button", { name: "Analyze my photo" }).click();
  await expect(page.locator(".notice.error")).toContainText(
    "Choose another clear photo",
  );
  await expect(
    page.getByRole("button", { name: "Choose a photo" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("img", { name: "Your temporary photo preview" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Analyze my photo" }).click();
  await expect(page.getByText(/Experimental results ·/)).toBeVisible();
  await expect(page.locator(".model-code")).toHaveCount(8);
  await expect(
    page.getByRole("img", { name: "Your temporary photo preview" }),
  ).toHaveCount(0);
  await expect(
    page.getByText(/Photo codes were not used in this ranking/),
  ).toBeVisible();
  await expect(
    page.getByText("Photo-informed ingredient ranking", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Finish & clear session" }).click();
  await expect(
    page.getByRole("button", { name: "Let's get started" }),
  ).toBeVisible();
});

test("photo-informed candidate ranking is explained without changing the store-policy product reason", async ({
  page,
}) => {
  await page.route("**/api/v1/kiosk/sessions/*/analysis", async (route) => {
    const session = await (
      await page.request.get(
        route
          .request()
          .url()
          .replace(/\/analysis$/, ""),
      )
    ).json();
    const product = demoProducts.find((item) => item.sku === "SEN-TONE-01")!;
    await route.fulfill({
      json: {
        ...session,
        analysis: model(session.id, [
          "partial_questionnaire_features",
          "visual_condition_used_source_contract_v1",
        ]),
        recommendations: [
          {
            product,
            score: 1.4,
            matchedIngredients: ["Niacinamide"],
            reasons: [
              {
                concern: "fine_lines",
                ingredient: "Niacinamide",
                relevance: 2,
              },
            ],
          },
        ],
      },
    });
  });
  await prepare(page);
  await page.getByRole("button", { name: "Analyze my photo" }).click();
  await expect(
    page.getByText("Photo-informed ingredient ranking", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Your photo's source codes are included in ingredient candidate ranking/,
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      /selected goals, the store's policy and excluded ingredients/,
    ),
  ).toBeVisible();
  await expect(page.locator(".product-card")).toContainText(
    "Matched to fine lines through the store's ingredient policy. Photo codes contributed to ingredient candidate ranking.",
  );
  await page
    .getByText("About this recommendation model", { exact: true })
    .click();
  await expect(
    page.getByText(/Your selected skin type takes precedence/),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Photo codes do not change your goals, sensitivity preference or exclusions/,
    ),
  ).toBeVisible();
  for (const width of [1024, 768, 390]) {
    await page.setViewportSize({ width, height: 768 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
  await page.getByRole("button", { name: "Finish & clear session" }).click();
});

test("an unseen photo-code combination clearly keeps ingredient ranking questionnaire-only", async ({
  page,
}) => {
  await page.route("**/api/v1/kiosk/sessions/*/analysis", async (route) => {
    const session = await (
      await page.request.get(
        route
          .request()
          .url()
          .replace(/\/analysis$/, ""),
      )
    ).json();
    await route.fulfill({
      json: {
        ...session,
        analysis: model(session.id, [
          "partial_questionnaire_features",
          "visual_condition_unseen_in_training_omitted",
        ]),
        recommendations: [],
      },
    });
  });
  await prepare(page);
  await page.getByRole("button", { name: "Analyze my photo" }).click();
  await expect(page.locator(".model-code")).toHaveCount(8);
  await expect(
    page.getByText(
      /code combination was not present in recommendation training, so photo codes were omitted/,
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Photo-informed ingredient ranking", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".ingredient-candidates")).not.toContainText(
    "Your photo's source codes are included",
  );
  await page.getByRole("button", { name: "Finish & clear session" }).click();
});

test("photo-free experimental results make no photo-informed recommendation claim", async ({
  page,
}) => {
  await page.route("**/api/v1/kiosk/sessions/*/analysis", async (route) => {
    expect(route.request().postData()).toBe("{}");
    const session = await (
      await page.request.get(
        route
          .request()
          .url()
          .replace(/\/analysis$/, ""),
      )
    ).json();
    await route.fulfill({
      json: {
        ...session,
        analysis: { ...model(session.id), visual: null },
        recommendations: [],
      },
    });
  });
  await prepare(page, false);
  await page.getByRole("button", { name: /Continue without/ }).click();
  await expect(page.getByText(/You continued without a photo/)).toBeVisible();
  await expect(
    page.getByText(/Photo codes were not used in this ranking/),
  ).toBeVisible();
  await expect(
    page.getByText("Photo-informed ingredient ranking", { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".model-code")).toHaveCount(0);
  await page.getByRole("button", { name: "Finish & clear session" }).click();
});

test("ending an experimental photo request aborts it and a late response cannot restore customer state", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received!: () => void;
  const upload = new Promise<void>((resolve) => {
    received = resolve;
  });
  let finished!: () => void;
  const delivery = new Promise<void>((resolve) => {
    finished = resolve;
  });
  await page.route("**/api/v1/kiosk/sessions/*/analysis", async (route) => {
    const session = await (
      await page.request.get(
        route
          .request()
          .url()
          .replace(/\/analysis$/, ""),
      )
    ).json();
    received();
    await gate;
    await route
      .fulfill({
        json: { ...session, analysis: model(session.id), recommendations: [] },
      })
      .catch(() => undefined);
    finished();
  });
  await prepare(page);
  await page.getByRole("button", { name: "Analyze my photo" }).click();
  await upload;
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Let's get started" }),
  ).toBeVisible();
  release();
  await delivery;
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(page.locator(".model-code")).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: "Your temporary photo preview" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Let's get started" }),
  ).toBeVisible();
});
