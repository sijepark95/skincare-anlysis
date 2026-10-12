import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const sessionId = "77777777-7777-4777-8777-777777777777";
const device = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  storeId: "22222222-2222-4222-8222-222222222222",
  deviceId: "33333333-3333-4333-8333-333333333333",
};
type Quality = "usable" | "limited" | "not_assessable";

// Generated canvas input and intercepted responses only: no external vision,
// Supabase, Auth, customer image, model training or email delivery.
async function prepare(page: Page, quality: Quality = "usable") {
  const state = {
    analysisCalls: 0,
    explanationCalls: 0,
    imageCalls: 0,
    finishCalls: 0,
    consent: false,
    visionAccepted: false,
    failPhoto: false,
    analysisGate: null as Promise<void> | null,
    answers: {
      skinType: "unsure",
      concerns: [] as string[],
      sensitive: false,
      excludedIngredients: [] as string[],
    },
  };
  await page.addInitScript(() => {
    const audit = { requested: 0 };
    Object.defineProperty(window, "__openaiCameraAudit", { value: audit });
    navigator.mediaDevices.getUserMedia = async () => {
      audit.requested++;
      throw new DOMException("Synthetic denied camera", "NotAllowedError");
    };
  });
  await page.route("**/api/v1/context", (route) =>
    route.fulfill({
      json: {
        device,
        staff: null,
        mode: "demo",
        analysisMode: "openai",
        // Even a stale context cannot expose the old product-only LLM option.
        explanationAvailable: true,
      },
    }),
  );
  await page.route("**/api/v1/kiosk/sessions**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/consent")) {
      const body = request.postDataJSON();
      expect(Object.keys(body).sort()).toEqual(["accepted", "visionAccepted"]);
      state.consent = body.accepted;
      state.visionAccepted = body.visionAccepted;
    }
    if (pathname.endsWith("/answers")) state.answers = request.postDataJSON();
    if (pathname.endsWith("/explanation")) state.explanationCalls++;
    if (pathname.endsWith("/finish")) state.finishCalls++;
    let analysis = null;
    if (pathname.endsWith("/analysis")) {
      state.analysisCalls++;
      if (state.analysisGate) await state.analysisGate;
      const photo = request.headers()["content-type"]?.startsWith("image/");
      if (photo) state.imageCalls++;
      else expect(request.postDataJSON()).toEqual({});
      if (photo && state.failPhoto) {
        await route.fulfill({
          status: 503,
          json: {
            error: {
              code: "analysis_unavailable",
              message:
                "Photo analysis is unavailable. Continue without a photo.",
            },
          },
        });
        return;
      }
      analysis = {
        request_id: sessionId,
        mode: "openai",
        model_version: "gpt-4.1-mini-2025-04-14",
        quality_status: photo ? quality : "not_provided",
        observations: [],
        disclaimer: "Unvalidated cosmetic photo observations; not a diagnosis.",
        vision: photo
          ? {
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
                visible_flaking:
                  quality === "not_assessable"
                    ? "not_assessable"
                    : "not_visible",
              },
            }
          : null,
      };
    }
    await route.fulfill({
      json: {
        id: sessionId,
        ...device,
        createdAt: "2026-10-11T12:00:00Z",
        consent: state.consent,
        consentVersion: "2026-10-openai-v1",
        visionConsent: {
          accepted: state.visionAccepted,
          noticeVersion: "2026-10-openai-photo-v1",
        },
        answers: state.answers,
        analysis,
        recommendations: [],
        explanation: null,
      },
    });
  });
  await page.goto("/kiosk/skin");
  await page.getByRole("button", { name: "Let's get started" }).click();
  return state;
}

async function preferences(page: Page, allowPhoto: boolean) {
  await expect(
    page.getByRole("checkbox", {
      name: "Analyze my photo with OpenAI (optional)",
    }),
  ).not.toBeChecked();
  await expect(
    page.getByText(/I am an adult and the only person/),
  ).toBeVisible();
  await expect(
    page.getByText(/up to 30 days, even with response storage/),
  ).toBeVisible();
  await expect(
    page.getByRole("checkbox", { name: "Add an AI explanation (optional)" }),
  ).toHaveCount(0);
  await page
    .getByRole("checkbox", { name: /I agree to this temporary session/ })
    .check();
  if (allowPhoto)
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
}

async function selectSyntheticPhoto(page: Page) {
  await page.getByRole("button", { name: "Continue to photo" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __openaiCameraAudit: { requested: number } })
            .__openaiCameraAudit.requested,
      ),
    )
    .toBe(1);
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "generated-interface-test.png",
    mimeType: "image/png",
    buffer: Buffer.from(base64, "base64"),
  });
}

test("declining external photo analysis never opens the camera or uploads pixels", async ({
  page,
}) => {
  const state = await prepare(page);
  await preferences(page, false);
  await page.getByRole("button", { name: "See my store matches" }).click();
  await expect(
    page.getByRole("heading", { name: "Your photo-free experience." }),
  ).toBeVisible();
  await expect(page.getByText(/No new photo request is made/)).toBeVisible();
  await expect(page.locator(".vision-feature")).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  expect(state.visionAccepted).toBe(false);
  expect(state.imageCalls).toBe(0);
  expect(state.explanationCalls).toBe(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __openaiCameraAudit: { requested: number } })
          .__openaiCameraAudit.requested,
    ),
  ).toBe(0);
});

test("OpenAI observations appear before an empty product catalog without code scores", async ({
  page,
}, testInfo) => {
  const state = await prepare(page);
  await preferences(page, true);
  await selectSyntheticPhoto(page);
  await page
    .getByRole("button", { name: "Analyze my photo", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "What OpenAI observed." }),
  ).toBeVisible();
  await expect(page.locator(".vision-feature")).toHaveCount(5);
  await expect(page.locator(".vision-feature").first()).toContainText(
    "Visible in this photo",
  );
  await expect(
    page.getByText(/No available products meet all your preferences/),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Relative model outputs|Ingredient candidates\.|Experimental model outputs/,
    ),
  ).toHaveCount(0);
  await expect(page.locator(".model-code")).toHaveCount(0);
  const positions = await page.evaluate(() => ({
    vision: document.querySelector(".vision-results")!.getBoundingClientRect()
      .top,
    products: Array.from(document.querySelectorAll(".section-heading"))
      .find((element) =>
        element.textContent?.includes("A thoughtful starting routine"),
      )!
      .getBoundingClientRect().top,
  }));
  expect(positions.vision).toBeLessThan(positions.products);
  expect(state.imageCalls).toBe(1);
  expect(state.explanationCalls).toBe(0);
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
      path: testInfo.outputPath(`openai-results-${viewport.width}.png`),
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Finish & clear session" }).click();
  await expect(page.locator(".vision-feature")).toHaveCount(0);
  await page.getByRole("button", { name: "Let's get started" }).click();
  await expect(
    page.getByRole("checkbox", {
      name: "Analyze my photo with OpenAI (optional)",
    }),
  ).not.toBeChecked();
  expect(state.finishCalls).toBe(1);
});

for (const quality of ["limited", "not_assessable"] as const) {
  test(`${quality} photo results describe limitations without adding photo matching goals`, async ({
    page,
  }) => {
    const state = await prepare(page, quality);
    await preferences(page, true);
    await selectSyntheticPhoto(page);
    await page
      .getByRole("button", { name: "Analyze my photo", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "What OpenAI observed." }),
    ).toBeVisible();
    await expect(
      page.getByText(/Photo features were omitted from matching/),
    ).toBeVisible();
    await expect(page.locator(".vision-feature")).toHaveCount(5);
    await expect(
      page.getByRole("list", { name: "Photo limitations" }),
    ).toBeVisible();
    expect(state.analysisCalls).toBe(1);
    expect(state.explanationCalls).toBe(0);
  });
}

test("photo-free continuation clears a selected image before requesting results", async ({
  page,
}) => {
  const state = await prepare(page);
  await preferences(page, true);
  await selectSyntheticPhoto(page);
  await page
    .getByRole("button", { name: "Continue without a photo", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your photo-free experience." }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Your temporary photo preview" }),
  ).toHaveCount(0);
  expect(state.imageCalls).toBe(0);
});

test("unavailable OpenAI analysis keeps a usable photo-free path and never substitutes local results", async ({
  page,
}) => {
  const state = await prepare(page);
  state.failPhoto = true;
  await preferences(page, true);
  await selectSyntheticPhoto(page);
  await page
    .getByRole("button", { name: "Analyze my photo", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Analyze my photo", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Choose a photo", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("img", { name: "Your temporary photo preview" }),
  ).toBeVisible();
  await expect(page.locator(".model-code, .vision-feature")).toHaveCount(0);
  expect(state.imageCalls).toBe(1);
  await page
    .getByRole("button", { name: "Continue without a photo", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your photo-free experience." }),
  ).toBeVisible();
  expect(state.imageCalls).toBe(1);
  await expect(
    page.getByText(/that photo may already have reached OpenAI/),
  ).toBeVisible();
  await expect(page.getByText(/No photo was sent to OpenAI/)).toHaveCount(0);
  expect(state.explanationCalls).toBe(0);
});

test("ending a session during OpenAI analysis cannot restore observations", async ({
  page,
}) => {
  const state = await prepare(page);
  let release!: () => void;
  state.analysisGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await preferences(page, true);
  await selectSyntheticPhoto(page);
  await page
    .getByRole("button", { name: "Analyze my photo", exact: true })
    .click();
  await expect.poll(() => state.analysisCalls).toBe(1);
  await page.getByRole("button", { name: "End session", exact: true }).click();
  release();
  await expect(
    page.getByRole("heading", { name: /A little insight/ }),
  ).toBeVisible();
  await expect(page.locator(".vision-feature")).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: "Your temporary photo preview" }),
  ).toHaveCount(0);
  expect(state.imageCalls).toBe(1);
});

test("management identifies the active OpenAI provider and separate photo privacy", async ({
  page,
}) => {
  await page.route("**/api/v1/context", (route) =>
    route.fulfill({
      json: {
        device,
        staff: {
          organizationId: device.organizationId,
          organizationName: "Synthetic vision workspace",
          role: "owner",
          stores: [
            {
              id: device.storeId,
              name: "Synthetic store",
              location: "Test",
              currency: "USD",
            },
          ],
        },
        mode: "supabase",
        analysisMode: "openai",
        explanationAvailable: true,
      },
    }),
  );
  await page.route("**/api/v1/management/overview?**", (route) =>
    route.fulfill({
      json: {
        products: [],
        metrics: { started: 0, completed: 0, analyzed: 0 },
        devices: [],
      },
    }),
  );
  await page.goto("/management/settings");
  await expect(
    page.getByText("OpenAI · visible photo features", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("OpenAI · separate optional adult consent", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("OpenAI abuse logs · up to 30 days", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Simulated · mock provider", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(/gpt-4.1-mini-2025-04-14/)).toBeVisible();
  await expect(
    page.getByText(/redness, visible spots, pores, fine lines and flaking/),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
