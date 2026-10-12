import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  COLOR_PHOTO_NOTICE_VERSION,
  type ColorAnalysis,
} from "../../src/domain/color-analysis";
import type {
  ColorMatch,
  ColorPreferences,
  LipShade,
} from "../../src/domain/personal-color";
import type { Product } from "../../src/domain";

const sessionId = "77777777-7777-4777-8777-777777777777";
const device = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  storeId: "22222222-2222-4222-8222-222222222222",
  deviceId: "33333333-3333-4333-8333-333333333333",
};
const product: Product = {
  id: "44444444-4444-4444-8444-444444444444",
  ...device,
  sku: "LIP-REAL-01",
  brand: "Registered merchant",
  name: "Registered Rose Lip Color",
  category: "lip_color",
  priceMinor: 2400,
  currency: "USD",
  stock: 3,
  visible: true,
  ingredients: ["Aqua", "Glycerin"],
  formulaComplete: true,
  suitableSkinTypes: ["normal", "dry", "oily", "combination", "unsure"],
  status: "published",
};
const shade: LipShade = {
  variantId: product.id,
  organizationId: device.organizationId,
  versionId: "55555555-5555-4555-8555-555555555555",
  version: 1,
  shadeName: "Rose Clay",
  hueFamily: "rose",
  undertone: "warm",
  intensity: "soft",
  finish: "satin",
  swatchHex: "#B98788",
  reviewed: true,
};
const observation: ColorAnalysis = {
  request_id: sessionId,
  mode: "openai_color",
  model_version: "gpt-4.1-mini-2025-04-14",
  prompt_version: "personal-color-suggestion-v1",
  image_quality: "usable",
  undertone: "warm",
  chroma: "soft",
  quality_flags: [],
};

async function kiosk(
  page: Page,
  options: {
    limited?: boolean;
    failure?: boolean;
    empty?: boolean;
    delayed?: Promise<void>;
    unavailable?: boolean;
  } = {},
) {
  const state = {
    consent: false,
    attempted: false,
    photoAvailable: !options.unavailable,
    analysis: null as ColorAnalysis | null,
    preferences: null as ColorPreferences | null,
    recommendations: [] as ColorMatch[],
    imageCalls: 0,
    preferenceCalls: 0,
    consentBodies: [] as unknown[],
    finishCalls: 0,
  };
  let answers = {
    skinType: "dry",
    concerns: ["fine_lines"],
    sensitive: false,
    excludedIngredients: [],
  };
  await page.addInitScript(() => {
    const originalStop = MediaStreamTrack.prototype.stop;
    const originalRevoke = URL.revokeObjectURL;
    Object.assign(window, { colorStopped: 0, colorRevoked: 0 });
    MediaStreamTrack.prototype.stop = function () {
      (window as unknown as { colorStopped: number }).colorStopped++;
      originalStop.call(this);
    };
    URL.revokeObjectURL = function (url) {
      (window as unknown as { colorRevoked: number }).colorRevoked++;
      originalRevoke.call(URL, url);
    };
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/context"))
      return route.fulfill({
        json: {
          device,
          staff: null,
          mode: "demo",
          analysisMode: "openai",
          explanationAvailable: false,
        },
      });
    if (pathname.endsWith("/color-consent")) {
      const body = request.postDataJSON();
      state.consentBodies.push(body);
      state.consent = body.accepted;
      if (!body.accepted) {
        state.analysis = null;
        state.preferences = null;
        state.recommendations = [];
      }
      return route.fulfill({ json: state });
    }
    if (pathname.endsWith("/color-analysis")) {
      state.imageCalls++;
      state.attempted = true;
      expect(request.headers()["content-type"]).toMatch(/^image\/(png|jpeg)$/);
      expect(request.postDataBuffer()!.length).toBeGreaterThan(100);
      if (options.delayed) await options.delayed;
      if (options.failure)
        return route.fulfill({
          status: 502,
          json: {
            error: {
              code: "color_unavailable",
              message:
                "Photo suggestion unavailable. Choose a palette yourself.",
            },
          },
        });
      state.analysis = options.limited
        ? {
            ...observation,
            image_quality: "limited",
            undertone: "uncertain",
            chroma: "uncertain",
            quality_flags: ["uneven_lighting"],
          }
        : observation;
      return route.fulfill({ json: state }).catch(() => {});
    }
    if (pathname.endsWith("/color-preferences")) {
      state.preferenceCalls++;
      state.preferences = request.postDataJSON();
      state.recommendations =
        options.empty || state.preferences?.finish === "matte"
          ? []
          : [
              {
                product,
                shade,
                reasons: [
                  "You confirmed the soft warmth palette.",
                  "The store describes Rose Clay as warm, soft and satin.",
                ],
              },
            ];
      return route.fulfill({ json: state });
    }
    if (pathname.endsWith("/color")) return route.fulfill({ json: state });
    if (pathname.endsWith("/answers")) answers = request.postDataJSON();
    if (pathname.endsWith("/finish")) state.finishCalls++;
    return route.fulfill({
      json: {
        id: sessionId,
        ...device,
        createdAt: "2026-10-11T12:00:00Z",
        consent: true,
        consentVersion: "2026-10-openai-v1",
        answers,
        analysis: pathname.endsWith("/analysis")
          ? {
              request_id: sessionId,
              mode: "openai",
              model_version: observation.model_version,
              quality_status: "not_provided",
              observations: [],
              disclaimer: "Photo-free discovery.",
              vision: null,
            }
          : null,
        recommendations: [],
      },
    });
  });
  await page.goto("/kiosk/skin");
  await page.getByRole("button", { name: "Let's get started" }).click();
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
  await page.getByRole("button", { name: "See my store matches" }).click();
  await page.getByRole("button", { name: "Explore lip colors" }).click();
  const dialog = page.getByRole("dialog", { name: "Find your lip colors" });
  await expect(
    dialog.getByRole("radio", { name: /Soft warmth/ }),
  ).toBeEnabled();
  return { state, dialog };
}

async function freshPhoto(page: Page) {
  await page.getByText("Optional photo suggestion", { exact: true }).click();
  const consent = page.getByRole("checkbox", {
    name: /Send a new photo to OpenAI/,
  });
  await expect(consent).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Open camera", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("New photo for color suggestion"),
  ).toBeDisabled();
  await consent.check();
  await expect(page.getByLabel("New photo for color suggestion")).toBeEnabled();
  const image = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.getByLabel("New photo for color suggestion").setInputFiles({
    name: "synthetic-color.png",
    mimeType: "image/png",
    buffer: Buffer.from(image, "base64"),
  });
  await expect(
    page.getByAltText("New color photo preview, not yet sent"),
  ).toBeVisible();
}

test("manual palette confirmation uses only registered store shades and changing finish makes no photo call", async ({
  page,
}, testInfo) => {
  const { state, dialog } = await kiosk(page);
  await page.screenshot({
    path: testInfo.outputPath("personal-color-intro-tablet.png"),
  });
  await expect(
    dialog.getByRole("button", { name: "Confirm palette & find lip shades" }),
  ).toBeDisabled();
  await dialog.getByRole("radio", { name: /Soft warmth/ }).check();
  await dialog.getByLabel("2. Preferred finish").selectOption("satin");
  await dialog
    .getByRole("button", { name: "Confirm palette & find lip shades" })
    .click();
  await expect(
    dialog.getByRole("heading", { name: product.name }),
  ).toBeVisible();
  await expect(dialog.locator(".color-match")).toHaveCount(1);
  await expect(dialog.locator(".color-match")).toContainText("Rose Clay");
  expect(state.preferences).toEqual({
    paletteId: "warm_soft",
    finish: "satin",
  });
  expect(state.imageCalls).toBe(0);
  await dialog.getByLabel("2. Preferred finish").selectOption("matte");
  await expect(dialog.locator(".color-match")).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Confirm palette & find lip shades" })
    .click();
  await expect(dialog.locator(".color-empty")).toContainText(
    "No available registered lip shades",
  );
  expect(state.preferenceCalls).toBe(2);
  expect(state.imageCalls).toBe(0);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("personal-color-tablet.png"),
    fullPage: true,
  });
});

test("new purpose consent and explicit Analyze produce a suggestion that is never automatically confirmed", async ({
  page,
}) => {
  const { state, dialog } = await kiosk(page);
  await freshPhoto(page);
  expect(state.imageCalls).toBe(0);
  expect(state.consentBodies).toEqual([
    { accepted: true, noticeVersion: COLOR_PHOTO_NOTICE_VERSION },
  ]);
  await dialog
    .getByRole("button", { name: "Analyze new photo", exact: true })
    .click();
  await expect(dialog.getByLabel("Photo color suggestion")).toContainText(
    "soft warmth",
  );
  await expect(dialog.locator('input[type="radio"]:checked')).toHaveCount(0);
  await expect(dialog.locator(".color-match")).toHaveCount(0);
  expect(state.preferenceCalls).toBe(0);
  await expect(
    dialog.getByAltText("New color photo preview, not yet sent"),
  ).toHaveCount(0);
  await dialog.getByRole("radio", { name: /Soft cool/ }).check();
  await dialog
    .getByRole("button", { name: "Confirm palette & find lip shades" })
    .click();
  expect(state.preferences?.paletteId).toBe("cool_soft");
  expect(state.imageCalls).toBe(1);
  await dialog
    .getByRole("checkbox", { name: /Send a new photo to OpenAI/ })
    .uncheck();
  await expect(dialog.getByLabel("Photo color suggestion")).toHaveCount(0);
  await expect(dialog.getByLabel("Confirmed store lip shades")).toHaveCount(0);
  expect(state.consentBodies.at(-1)).toEqual({
    accepted: false,
    noticeVersion: COLOR_PHOTO_NOTICE_VERSION,
  });
});

test("limited images offer manual choice and the durable attempt remains locked after closing", async ({
  page,
}) => {
  const { state, dialog } = await kiosk(page, { limited: true });
  await freshPhoto(page);
  await dialog.getByRole("button", { name: "Analyze new photo" }).click();
  await expect(dialog.getByLabel("Photo color suggestion")).toContainText(
    "does not support a clear palette",
  );
  await expect(dialog.getByLabel("Photo color suggestion")).toContainText(
    "uneven lighting",
  );
  await expect(dialog.locator('input[type="radio"]:checked')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Explore lip colors" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Explore lip colors" }).click();
  await dialog.getByText("Optional photo suggestion", { exact: true }).click();
  await expect(
    dialog.getByText(/This session's photo attempt has been used/),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Analyze new photo" }),
  ).toHaveCount(0);
  expect(state.imageCalls).toBe(1);
});

test("failed or unavailable photo suggestions keep manual discovery honest", async ({
  page,
}) => {
  const { state, dialog } = await kiosk(page, { failure: true, empty: true });
  await freshPhoto(page);
  await dialog.getByRole("button", { name: "Analyze new photo" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Photo suggestion unavailable",
  );
  await expect(dialog.getByLabel("Photo color suggestion")).toHaveCount(0);
  await dialog.getByRole("radio", { name: /Clear balance/ }).check();
  await dialog
    .getByRole("button", { name: "Confirm palette & find lip shades" })
    .click();
  await expect(dialog.locator(".color-empty")).toBeVisible();
  expect(state.imageCalls).toBe(1);
  expect(state.preferenceCalls).toBe(1);
});

test("hidden tabs stop camera tracks and revoke unsent previews without a photo call", async ({
  page,
}) => {
  const { state, dialog } = await kiosk(page);
  await dialog.getByText("Optional photo suggestion", { exact: true }).click();
  await dialog
    .getByRole("checkbox", { name: /Send a new photo to OpenAI/ })
    .check();
  await dialog
    .getByRole("button", { name: "Open camera", exact: true })
    .click();
  const video = dialog.getByLabel("Color photo camera preview");
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.videoWidth),
    )
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(video).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { colorStopped: number }).colorStopped,
      ),
    )
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await dialog
    .getByRole("button", { name: "Open camera", exact: true })
    .click();
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.videoWidth),
    )
    .toBeGreaterThan(0);
  await dialog.getByRole("button", { name: "Capture new photo" }).click();
  await expect(
    dialog.getByAltText("New color photo preview, not yet sent"),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { colorStopped: number }).colorStopped,
      ),
    )
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(
    dialog.getByAltText("New color photo preview, not yet sent"),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { colorRevoked: number }).colorRevoked,
    ),
  ).toBeGreaterThan(0);
  expect(state.imageCalls).toBe(0);
});

test("a late photo response cannot restore a finished guest session", async ({
  page,
}) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { state, dialog } = await kiosk(page, { delayed });
  await freshPhoto(page);
  await dialog.getByRole("button", { name: "Analyze new photo" }).click();
  await expect.poll(() => state.imageCalls).toBe(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Finish & clear session" }).click();
  release();
  await expect(
    page.getByRole("button", { name: "Let's get started" }),
  ).toBeVisible();
  await expect(page.getByLabel("Photo color suggestion")).toHaveCount(0);
  await expect(page.getByLabel("Optional lip color discovery")).toHaveCount(0);
});

test("manual palettes remain usable when external color analysis is disabled on the device", async ({
  page,
}) => {
  const { state, dialog } = await kiosk(page, {
    unavailable: true,
    empty: true,
  });
  await dialog.getByText("Optional photo suggestion", { exact: true }).click();
  await expect(
    dialog.getByRole("checkbox", { name: /Send a new photo to OpenAI/ }),
  ).toBeDisabled();
  await dialog.getByRole("radio", { name: /Soft balance/ }).check();
  await dialog
    .getByRole("button", { name: "Confirm palette & find lip shades" })
    .click();
  await expect(dialog.locator(".color-empty")).toBeVisible();
  expect(state.imageCalls).toBe(0);
});

async function management(
  page: Page,
  role: "owner" | "manager",
  item: Product = product,
) {
  const writes: unknown[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/context"))
      return route.fulfill({
        json: {
          mode: "demo",
          analysisMode: "openai",
          explanationAvailable: false,
          staff: {
            ...device,
            userId: "88888888-8888-4888-8888-888888888888",
            organizationName: "Registered merchant",
            role,
            stores: [{ id: device.storeId, name: "Current store" }],
          },
        },
      });
    if (pathname.endsWith("/overview"))
      return route.fulfill({
        json: {
          products: [item],
          devices: [],
          metrics: { started: 0, completed: 0, analyzed: 0 },
        },
      });
    if (pathname.endsWith("/cosmetic-shades"))
      return route.fulfill({
        json: { shades: [{ ...shade, category: item.category }] },
      });
    if (pathname.endsWith(`/products/${item.id}/cosmetic-shade`)) {
      expect(request.method()).toBe("POST");
      expect(new URL(request.url()).searchParams.get("storeId")).toBe(
        device.storeId,
      );
      writes.push(request.postDataJSON());
      return route.fulfill({
        json: { shade: { ...shade, ...request.postDataJSON(), version: 2 } },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/management/catalog");
  await expect(page.getByRole("cell", { name: item.name })).toBeVisible();
  return writes;
}

test("owner publishes a reviewed shade version and every field edit clears review", async ({
  page,
}, testInfo) => {
  const writes = await management(page, "owner");
  await page
    .getByRole("button", { name: "Review cosmetic shade", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Review cosmetic shade" });
  const reviewed = dialog.getByRole("checkbox", {
    name: /I checked this metadata/,
  });
  const publish = dialog.getByRole("button", {
    name: "Publish reviewed shade",
  });
  await expect(dialog.getByLabel("Shade name", { exact: true })).toHaveValue(
    "Rose Clay",
  );
  await expect(
    dialog.getByLabel("Shade name", { exact: true }),
  ).toHaveAttribute("maxlength", "80");
  await expect(reviewed).not.toBeChecked();
  await expect(publish).toBeDisabled();
  await reviewed.check();
  await dialog.getByLabel("Shade name", { exact: true }).fill("Rose Clay 02");
  await expect(reviewed).not.toBeChecked();
  await expect(publish).toBeDisabled();
  await dialog.getByLabel("Screen swatch (hex)").fill("#B98789");
  await reviewed.check();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("review-lip-shade.png"),
    fullPage: true,
  });
  await publish.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("review-lip-shade-publish.png"),
  });
  await publish.click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([
    {
      category: "lip_color",
      shadeName: "Rose Clay 02",
      hueFamily: "rose",
      undertone: "warm",
      intensity: "soft",
      finish: "satin",
      swatchHex: "#B98789",
      reviewed: true,
    },
  ]);
  await expect(
    page.getByText(/Reviewed cosmetic shade published/),
  ).toBeVisible();
});

test("owner base review exposes depth and coverage, with no color-family fields", async ({
  page,
}) => {
  const baseProduct: Product = {
    ...product,
    category: "foundation",
    name: "Registered foundation candidate",
  };
  const writes = await management(page, "owner", baseProduct);
  await page
    .getByRole("button", { name: "Review cosmetic shade", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Review cosmetic shade" });
  await expect(
    dialog.getByRole("combobox", { name: "Registered depth" }),
  ).toHaveValue("medium");
  await expect(
    dialog.getByRole("combobox", { name: "Hue family" }),
  ).toHaveCount(0);
  const review = dialog.getByRole("checkbox", {
    name: /I checked this metadata/,
  });
  await review.check();
  await dialog
    .getByRole("combobox", { name: "Coverage", exact: true })
    .selectOption("full");
  await expect(review).not.toBeChecked();
  await review.check();
  await dialog
    .getByRole("button", { name: "Publish reviewed shade", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([
    {
      category: "foundation",
      shadeName: "Rose Clay",
      undertone: "warm",
      finish: "satin",
      swatchHex: "#B98788",
      reviewed: true,
      depth: "medium",
      coverage: "full",
    },
  ]);
});
test("manager catalog access does not offer owner shade publication", async ({
  page,
}) => {
  const writes = await management(page, "manager");
  await expect(
    page.getByRole("button", { name: "Store listing", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review cosmetic shade", exact: true }),
  ).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("phone palette choices fit the dialog and preserve keyboard access", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { dialog } = await kiosk(page, { unavailable: true, empty: true });
  await page.screenshot({
    path: testInfo.outputPath("personal-color-intro-phone.png"),
  });
  await dialog.getByRole("radio", { name: /Soft warmth/ }).focus();
  await page.keyboard.press("Space");
  await expect(
    dialog.getByRole("radio", { name: /Soft warmth/ }),
  ).toBeChecked();
  await dialog.getByLabel("2. Preferred finish").scrollIntoViewIfNeeded();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("personal-color-phone.png"),
    fullPage: true,
  });
});
