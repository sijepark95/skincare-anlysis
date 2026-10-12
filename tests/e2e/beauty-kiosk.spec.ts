import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
import type { CompleteBeautyView } from "../../src/application/beauty-complete";
import {
  guestAgeBands,
  type BeautyLocale,
  type GuestAgeBand,
  type CompleteSavedGuide,
} from "../../src/application/beauty-complete-contracts";
import {
  buildBeautyGuide,
  type BeautyPreferences,
} from "../../src/domain/beauty";
import type { BeautyCompleteAnalysis } from "../../src/domain/beauty-complete";
import { BEAUTY_MAKEUP_MODEL_VERSION } from "../../src/domain/beauty-makeup";
import { buildSkinConsultation } from "../../src/domain/skin-consultation";
import type { CosmeticMatch } from "../../src/domain/cosmetic-shades";
import type { FaceRatios } from "../../src/domain/face-ratios";
import type { Product, Recommendation } from "../../src/domain/types";
import { bt, beautyLabel } from "../../src/ui/beauty-i18n";

const sessionId = "77777777-7777-4777-8777-777777777777";
const device = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  storeId: "22222222-2222-4222-8222-222222222222",
  deviceId: "33333333-3333-4333-8333-333333333333",
};
const preferences: BeautyPreferences = {
  paletteId: "warm_soft",
  faceShape: "oval",
  hairLength: "any",
  mood: "soft",
  finish: "any",
};
const analysis: BeautyCompleteAnalysis = {
  request_id: sessionId,
  mode: "openai_beauty_complete",
  model_version: "gpt-4.1-mini-2025-04-14",
  prompt_version: "beauty-complete-v1",
  beauty: {
    request_id: sessionId,
    mode: "openai_beauty",
    model_version: "gpt-4.1-mini-2025-04-14",
    prompt_version: "beauty-style-suggestion-v2",
    image_quality: "usable",
    undertone: "warm",
    chroma: "soft",
    face_shape: "oval",
    eye_shape: "almond",
    nose_shape: "medium",
    lip_fullness: "full",
    quality_flags: [],
  },
  skin: {
    prompt_version: "visible-appearance-eval-v1",
    image_quality: "usable",
    quality_flags: [],
    observed_features: {
      visible_pores: "visible",
      visible_spots: "not_visible",
      visible_fine_lines: "uncertain",
      visible_redness: "visible",
      visible_flaking: "uncertain",
    },
  },
  animalVibe: "cat",
  baseDepth: "medium",
};
const product: Product = {
  id: "44444444-4444-4444-8444-444444444444",
  organizationId: device.organizationId,
  storeId: device.storeId,
  sku: "TEXTURE-01",
  brand: "Registered merchant",
  name: "Reviewed Texture Serum",
  category: "serum",
  priceMinor: 2400,
  currency: "USD",
  stock: 5,
  visible: true,
  ingredients: ["Aqua", "Niacinamide"],
  formulaComplete: true,
  suitableSkinTypes: ["normal", "dry", "oily", "combination", "unsure"],
  status: "published",
};
const recommendation: Recommendation = {
  product,
  score: 3,
  matchedIngredients: ["Niacinamide"],
  reasons: [{ concern: "texture", ingredient: "Niacinamide", relevance: 3 }],
};
const lipProduct: Product = {
  ...product,
  id: "44444444-4444-4444-8444-444444444445",
  sku: "LIP-01",
  name: "Registered Rose Lip Color",
  category: "lip_color",
  ingredients: ["Aqua", "Glycerin"],
};
const token = "testSavedGuideToken1234567890abcdefghijklmno";
const qr =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cB9sAAAAASUVORK5CYII=";
function savedGuide(locale: BeautyLocale = "en"): CompleteSavedGuide {
  return {
    version: "beauty-complete-guide-v1",
    locale,
    expiresAt: "2099-10-12T18:00:00Z",
    preferences,
    products: [
      {
        variantId: product.id,
        category: product.category,
        formulationVersionId: "55555555-5555-4555-8555-555555555551",
        shadeVersionId: null,
        name: product.name,
        brand: product.brand,
        shadeName: null,
        swatchHex: null,
        priceMinor: 2400,
        currency: "USD",
        available: true,
      },
      {
        variantId: lipProduct.id,
        category: "lip_color",
        formulationVersionId: "55555555-5555-4555-8555-555555555552",
        shadeVersionId: "55555555-5555-4555-8555-555555555553",
        name: lipProduct.name,
        brand: lipProduct.brand,
        shadeName: "Rose Clay",
        swatchHex: "#B98788",
        priceMinor: null,
        currency: null,
        available: false,
      },
    ],
  };
}
type BrowserMedia = {
  stopped: number;
  opened: number;
  activeUrls: string[];
  events: string[];
};
async function fixture(
  page: Page,
  options: {
    failSlot?: number;
    holdSlot?: number;
    hold?: Promise<void>;
    analysisFailure?: boolean;
    beautyQuality?: "limited" | "not_assessable";
    sharing?: boolean;
    baseCatalog?: boolean;
    ratios?: FaceRatios;
  } = {},
) {
  const calls = {
    analysis: 0,
    slots: [] as number[],
    bodies: [] as Buffer[],
    events: [] as string[],
    contexts: [] as unknown[],
    finish: [] as unknown[],
    cancel: 0,
    share: [] as unknown[],
    previewHeaders: [] as Record<string, string>[],
    jsonBodies: [] as { action: string; body: unknown }[],
    unexpected: [] as string[],
  };
  const value: CompleteBeautyView = {
    beauty: {
      consent: false,
      attempted: false,
      analysis: null,
      preferences: null,
      excludedIngredients: [],
      guide: null,
      recommendations: [],
      ingredients: ["Aqua", "Glycerin", "Niacinamide"],
      photoAvailable: true,
      sharingAvailable: !!options.sharing,
      shareUnavailableReason:
        "Phone QR saving needs a configured public HTTPS address. Download your guide here.",
    },
    analysis: null,
    context: null,
    completeConsent: false,
    attempted: false,
    skinProfile: { skinType: "unsure", concerns: [], excludedIngredients: [] },
    base: { depth: "unknown", undertone: "unknown", concealerPurpose: "match" },
    skinReport: null,
    skinRecommendations: [],
    cosmetics: [],
    baseCandidates: [],
    preview: { consent: false, available: true, slots: [], deadline: null },
    teenPhotoEnabled: false,
  };
  await page.addInitScript(
    ({ ratioResult }) => {
      // Exercise the local-worker presentation contract with deterministic geometry.
      // Neither customer imagery nor the external analysis response supplies ratios.
      if (ratioResult)
        window.Worker = new Proxy(window.Worker, {
          construct(Target, args) {
            if (!String(args[0]).includes("face-ratios"))
              return Reflect.construct(Target, args);
            let stopped = false;
            const task: {
              onmessage: ((event: MessageEvent<FaceRatios>) => void) | null;
              onerror: (() => void) | null;
              postMessage: (message: { bitmap: ImageBitmap }) => void;
              terminate: () => void;
            } = {
              onmessage: null,
              onerror: null,
              postMessage(message) {
                message.bitmap.close();
                queueMicrotask(() => {
                  if (!stopped)
                    task.onmessage?.(
                      new MessageEvent("message", { data: ratioResult }),
                    );
                });
              },
              terminate() {
                stopped = true;
              },
            };
            return task;
          },
        });
      const state: BrowserMedia = {
        stopped: 0,
        opened: 0,
        activeUrls: [],
        events: [],
      };
      Object.assign(window, { completeMedia: state });
      const stop = MediaStreamTrack.prototype.stop;
      MediaStreamTrack.prototype.stop = function () {
        state.stopped++;
        stop.call(this);
      };
      const get = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = function (c) {
        state.opened++;
        state.events.push("camera");
        return get(c);
      };
      const create = URL.createObjectURL,
        revoke = URL.revokeObjectURL;
      URL.createObjectURL = function (blob) {
        const url = create.call(URL, blob);
        state.activeUrls.push(url);
        return url;
      };
      URL.revokeObjectURL = function (url) {
        state.activeUrls = state.activeUrls.filter((x) => x !== url);
        revoke.call(URL, url);
      };
      const send = window.fetch.bind(window);
      window.fetch = function (input, init) {
        const url = String(input);
        if (url.includes("/api/v1/")) state.events.push(url.split("/").at(-1)!);
        return send(input, init);
      };
    },
    { ratioResult: options.ratios ?? null },
  );
  // Synthetic fields exercise transport only. No face or customer image is used.
  const image = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 256;
    const x = c.getContext("2d")!;
    x.fillStyle = "#e8e4e1";
    x.fillRect(0, 0, 256, 256);
    return {
      png: c.toDataURL("image/png").split(",")[1],
      jpeg: c.toDataURL("image/jpeg").split(",")[1],
    };
  });
  const refresh = () => {
    value.beauty.guide = value.beauty.preferences
      ? buildBeautyGuide(value.beauty.preferences)
      : null;
    value.beauty.analysis = value.analysis?.beauty ?? null;
    if (value.analysis || value.skinProfile.concerns.length) {
      value.skinRecommendations =
        value.skinProfile.excludedIngredients.includes("Niacinamide")
          ? []
          : [recommendation];
      value.skinReport = buildSkinConsultation({
        vision: value.analysis?.skin ?? null,
        context: {
          skinType: value.skinProfile.skinType,
          selectedConcerns: value.skinProfile.concerns,
          photoConcerns: value.analysis ? ["texture"] : [],
          excludedIngredients: value.skinProfile.excludedIngredients,
        },
        rules: [
          { concern: "texture", ingredient: "Niacinamide", relevance: 3 },
        ],
        recommendations: value.skinRecommendations,
        policyVersion: "reviewed-fixture-v1",
      });
    }
    if (value.beauty.preferences)
      value.cosmetics = [
        {
          product: lipProduct,
          shade: {
            organizationId: device.organizationId,
            variantId: lipProduct.id,
            versionId: "55555555-5555-4555-8555-555555555553",
            version: 1,
            category: "lip_color",
            shadeName: "Rose Clay",
            swatchHex: "#B98788",
            undertone: "warm",
            hueFamily: "rose",
            intensity: "soft",
            finish: "satin",
            reviewed: true,
          },
          reasonCodes: ["palette_tone", "palette_intensity"],
        },
      ];
    if (value.beauty.preferences && options.baseCatalog)
      value.cosmetics.push(
        ...(["foundation", "concealer"] as const).flatMap((category) =>
          Array.from({ length: 4 }, (_, index): CosmeticMatch => {
            const suffix = `${category === "foundation" ? "6" : "7"}${index}`;
            const variantId = `44444444-4444-4444-8444-4444444444${suffix}`;
            return {
              product: {
                ...product,
                id: variantId,
                sku: `${category}-${index + 1}`,
                name: `Registered ${category} candidate ${index + 1}`,
                category,
              },
              shade: {
                organizationId: device.organizationId,
                variantId,
                versionId: `55555555-5555-4555-8555-5555555555${suffix}`,
                version: 1,
                category,
                shadeName: `Medium warm ${index + 1}`,
                swatchHex: "#BF9474",
                undertone: "warm",
                depth: "medium",
                finish: "natural",
                coverage: "medium",
                reviewed: true,
              },
              reasonCodes: ["base_tone", "base_depth"],
            };
          }),
        ),
      );
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      action = url.pathname.split("/").at(-1)!;
    calls.events.push(action);
    if (
      request.method() === "POST" &&
      request.headers()["content-type"]?.includes("application/json")
    ) {
      calls.jsonBodies.push({ action, body: request.postDataJSON() });
    }
    const jsonBody = () => request.postDataJSON();
    const respond = () => {
      refresh();
      return route.fulfill({ json: value });
    };
    if (action === "context")
      return route.fulfill({
        json: {
          device,
          staff: null,
          mode: "supabase",
          analysisMode: "openai",
          explanationAvailable: false,
        },
      });
    if (action === "sessions" && request.method() === "POST")
      return route.fulfill({
        json: {
          id: sessionId,
          ...device,
          consent: false,
          consentVersion: "2026-10-openai-v1",
          createdAt: new Date().toISOString(),
          answers: null,
          analysis: null,
        },
      });
    if (action === "beauty-context") {
      const body = jsonBody();
      calls.contexts.push(body);
      value.context = body;
      value.beauty.photoAvailable = !["under13", "13-15", "16-17"].includes(
        body.ageBand,
      );
      return respond();
    }
    if (action === "consent") {
      expect(jsonBody()).toEqual({ accepted: true, visionAccepted: false });
      return route.fulfill({ json: { ok: true } });
    }
    if (action === "beauty-complete") return respond();
    if (action === "beauty-complete-consent") {
      expect(jsonBody().noticeVersion).toBe("2026-10-beauty-complete-photo-v1");
      value.completeConsent = jsonBody().accepted;
      value.beauty.consent = value.completeConsent;
      if (!value.completeConsent) value.analysis = null;
      return respond();
    }
    if (action === "beauty-preview-consent") {
      expect(value.completeConsent).toBe(true);
      expect(jsonBody()).toEqual({
        accepted: true,
        noticeVersion: "2026-10-beauty-preview-v1",
      });
      value.preview.consent = true;
      return respond();
    }
    if (action === "beauty-complete-analysis") {
      calls.analysis++;
      expect(value.completeConsent).toBe(true);
      expect(value.attempted).toBe(false);
      value.attempted = true;
      value.beauty.attempted = true;
      calls.bodies.push(request.postDataBuffer()!);
      if (options.analysisFailure)
        return route.fulfill({
          status: 503,
          json: { error: { code: "unavailable", message: "Unavailable" } },
        });
      value.analysis = structuredClone(analysis);
      if (options.beautyQuality) {
        value.analysis.beauty = {
          ...value.analysis.beauty,
          image_quality: options.beautyQuality,
          quality_flags: ["uneven_lighting"],
          undertone: "uncertain",
          chroma: "uncertain",
          face_shape: "uncertain",
          eye_shape: "uncertain",
          nose_shape: "uncertain",
          lip_fullness: "uncertain",
        };
        value.analysis.animalVibe = "uncertain";
        value.analysis.baseDepth = "uncertain";
      }
      return respond();
    }
    if (action === "beauty-complete-preferences") {
      const body = jsonBody();
      value.beauty.preferences = body.preferences;
      value.base = {
        depth: body.baseDepth,
        undertone: body.baseUndertone,
        concealerPurpose: body.concealerPurpose,
      };
      return respond();
    }
    if (action === "beauty-complete-skin") {
      value.skinProfile = jsonBody();
      return respond();
    }
    if (/\/beauty-preview\/\d$/.test(url.pathname)) {
      const slot = Number(action);
      expect(value.preview.consent).toBe(true);
      expect(value.beauty.preferences).not.toBe(null);
      calls.slots.push(slot);
      calls.previewHeaders.push(request.headers());
      calls.bodies.push(request.postDataBuffer()!);
      if (options.holdSlot === slot) await options.hold;
      if (options.failSlot === slot)
        return route.fulfill({
          status: 503,
          json: { error: { code: "unavailable", message: "Unavailable" } },
        });
      return route.fulfill({
        json: {
          request_id: sessionId,
          kind: slot < 3 ? "makeup" : slot < 6 ? "hair_style" : "hair_color",
          index: slot % 3,
          mime_type: "image/jpeg",
          image_base64: image.jpeg,
          model_version: BEAUTY_MAKEUP_MODEL_VERSION,
          prompt_version: "beauty-preview-v1",
        },
      });
    }
    if (action === "beauty-preview-cancel") {
      calls.cancel++;
      return route.fulfill({ json: { ok: true } });
    }
    if (action === "beauty-complete-finish" || action === "finish") {
      calls.finish.push(jsonBody());
      return route.fulfill({ json: { ok: true } });
    }
    if (action === "beauty-complete-share") {
      calls.share.push(jsonBody());
      return route.fulfill({
        json: {
          url: `https://beauty.example/result#${token}`,
          expiresAt: "2099-10-12T18:00:00Z",
          qrDataUrl: qr,
        },
      });
    }
    calls.unexpected.push(url.pathname);
    return route.fulfill({
      status: 500,
      json: {
        error: {
          code: "unexpected_test_request",
          message: "Unexpected test request",
        },
      },
    });
  });
  return { calls, value, image };
}
async function begin(
  page: Page,
  age: GuestAgeBand = "18-24",
  locale: BeautyLocale = "en",
) {
  await page.goto("/kiosk");
  if (locale !== "en")
    await page.getByLabel("Language / 언어 / Idioma").selectOption(locale);
  await page
    .getByRole("button", { name: bt(locale, "start"), exact: true })
    .click();
  await page
    .getByRole("button", {
      name: age === "under13" ? bt(locale, "under13") : age,
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: bt(locale, "next"), exact: true })
    .click();
}
async function beginWithGender(page: Page, gender: "man" | "woman" | null) {
  if (gender === null) return begin(page);
  await page.goto("/kiosk");
  await page
    .getByRole("button", { name: bt("en", "start"), exact: true })
    .click();
  await page.getByRole("button", { name: "25-34", exact: true }).click();
  await page.locator("summary", { hasText: bt("en", "gender") }).click();
  await page
    .getByRole("combobox", { name: bt("en", "gender"), exact: true })
    .selectOption(gender);
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await page
    .getByRole("button", { name: bt("en", "next"), exact: true })
    .click();
}
async function privacy(
  page: Page,
  options: { photo?: boolean; preview?: boolean; locale?: BeautyLocale } = {},
) {
  const locale = options.locale ?? "en";
  // Await the asynchronous age submission before locating its next-step controls.
  // An already checked analytics box on the preceding screen is not photo consent.
  await expect(
    page.getByRole("heading", { name: bt(locale, "privacyTitle") }),
  ).toBeVisible();
  await page.getByRole("checkbox").first().check();
  if (options.preview) await page.getByRole("checkbox").nth(1).check();
  if (options.photo) await page.getByRole("checkbox").nth(2).check();
  await page
    .getByRole("button", { name: bt(locale, "next"), exact: true })
    .click();
}
async function upload(
  page: Page,
  image: { png: string },
  locale: BeautyLocale = "en",
) {
  await page.getByLabel(bt(locale, "upload")).setInputFiles({
    name: "synthetic-geometry.png",
    mimeType: "image/png",
    buffer: Buffer.from(image.png, "base64"),
  });
  await page
    .getByRole("button", { name: bt(locale, "analyze"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: bt(locale, "confirmTitle") }),
  ).toBeVisible();
}
async function confirm(page: Page, locale: BeautyLocale = "en") {
  await page
    .getByRole("button", { name: bt(locale, "confirm"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: bt(locale, "reportTitle") }),
  ).toBeVisible();
}
async function media(page: Page) {
  return page.evaluate(
    () => (window as unknown as { completeMedia: BrowserMedia }).completeMedia,
  );
}

for (const age of guestAgeBands) {
  test(`age ${age} has the correct photo eligibility and no mandatory Gender`, async ({
    page,
  }) => {
    const { calls } = await fixture(page);
    await begin(page, age);
    const eligible = !["under13", "13-15", "16-17"].includes(age);
    await expect(page.getByRole("checkbox")).toHaveCount(eligible ? 3 : 1);
    for (const checkbox of await page.getByRole("checkbox").all())
      await expect(checkbox).not.toBeChecked();
    expect(calls.contexts).toEqual([
      { ageBand: age, locale: "en", analyticsConsent: false },
    ]);
    if (!eligible)
      await expect(
        page.getByText(
          bt("en", age === "under13" ? "childNoPhoto" : "teenDisabled"),
        ),
      ).toBeVisible();
    await privacy(page);
    await confirm(page);
    expect(calls.analysis).toBe(0);
    expect((await media(page)).opened).toBe(0);
    expect(calls.unexpected).toEqual([]);
  });
}
for (const locale of ["en", "ko", "es"] as const) {
  test(`${locale} preserves photo results and choices without another AI request`, async ({
    page,
  }) => {
    const { calls, image, value } = await fixture(page);
    await begin(page, "25-34", locale);
    await privacy(page, { photo: true, locale });
    await upload(page, image, locale);
    await confirm(page, locale);
    const other = locale === "en" ? "ko" : "en";
    await page.getByLabel("Language / 언어 / Idioma").selectOption(other);
    await expect(
      page.getByRole("heading", { name: bt(other, "reportTitle") }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: product.name }),
    ).toBeVisible();
    expect(value.beauty.preferences?.paletteId).toBe("warm_soft");
    expect(calls.analysis).toBe(1);
    expect(calls.slots).toEqual([]);
    expect(calls.contexts.at(-1)).toEqual({
      ageBand: "25-34",
      locale: other,
      analyticsConsent: false,
    });
    expect(calls.unexpected).toEqual([]);
  });
}
test("both unticked external purposes persist before automatic camera opening; pausing sends no photo", async ({
  page,
}) => {
  const { calls } = await fixture(page);
  await begin(page);
  for (const checkbox of await page.getByRole("checkbox").all())
    await expect(checkbox).not.toBeChecked();
  await privacy(page, { photo: true, preview: true });
  await expect(
    page.getByRole("button", { name: bt("en", "pauseCamera") }),
  ).toBeVisible();
  await expect.poll(async () => (await media(page)).opened).toBeGreaterThan(0);
  const events = (await media(page)).events;
  expect(events.indexOf("beauty-complete-consent")).toBeLessThan(
    events.indexOf("beauty-preview-consent"),
  );
  expect(events.indexOf("beauty-preview-consent")).toBeLessThan(
    events.indexOf("camera"),
  );
  await page.getByRole("button", { name: bt("en", "pauseCamera") }).click();
  await expect.poll(async () => (await media(page)).stopped).toBeGreaterThan(0);
  expect(calls.analysis).toBe(0);
  expect(calls.slots).toEqual([]);
});
test("skin comes first and visible pores connect to texture ingredients and registered skincare", async ({
  page,
}) => {
  const { calls, image } = await fixture(page);
  await begin(page);
  await privacy(page, { photo: true });
  await upload(page, image);
  await confirm(page);
  await expect(
    page.locator(".complete-book > section").first(),
  ).toHaveAttribute("aria-label", bt("en", "skinTitle"));
  const skin = page.getByRole("region", { name: bt("en", "skinTitle") });
  await expect(skin.getByText("Pores", { exact: true })).toBeVisible();
  await expect(skin.getByRole("heading", { name: product.name })).toBeVisible();
  await expect(skin.locator(".complete-ingredients")).toContainText(
    "Niacinamide",
  );
  await expect(skin.getByText(lipProduct.name)).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: bt("en", "makeupTitle") })
      .getByRole("heading", { name: lipProduct.name }),
  ).toBeVisible();
  await expect(page.getByText(bt("en", "ratiosUnavailable"))).toBeVisible();
  expect(calls.analysis).toBe(1);
});
test("base candidates show up to three foundations and three concealers independently", async ({
  page,
}) => {
  const { calls, image } = await fixture(page, { baseCatalog: true });
  await begin(page);
  await privacy(page, { photo: true });
  await upload(page, image);
  await confirm(page);
  const face = page.getByRole("region", { name: bt("en", "faceTitle") });
  await expect(face.locator(".complete-product")).toHaveCount(6);
  for (const category of ["foundation", "concealer"] as const) {
    for (const index of [1, 2, 3])
      await expect(
        face.getByRole("heading", {
          name: `Registered ${category} candidate ${index}`,
          exact: true,
        }),
      ).toBeVisible();
    await expect(
      face.getByRole("heading", {
        name: `Registered ${category} candidate 4`,
        exact: true,
      }),
    ).toHaveCount(0);
  }
  await expect(
    page
      .getByRole("region", { name: bt("en", "skinTitle") })
      .getByText(/Registered (foundation|concealer) candidate/),
  ).toHaveCount(0);
  expect(calls.analysis).toBe(1);
  expect(calls.slots).toEqual([]);
});
test("unavailable local geometry shows no numeric meter while confirmed colors replace photo suggestions", async ({
  page,
}) => {
  const { calls, image, value } = await fixture(page, {
    ratios: { status: "unavailable", reason: "expression" },
  });
  await begin(page);
  await privacy(page, { photo: true });
  await upload(page, image);
  await page.locator("summary", { hasText: bt("en", "adjust") }).click();
  await page
    .getByRole("combobox", { name: bt("en", "palette"), exact: true })
    .selectOption("cool_clear");
  await page
    .getByRole("combobox", { name: bt("en", "faceShape"), exact: true })
    .selectOption("round");
  await page
    .getByRole("combobox", { name: bt("en", "depth"), exact: true })
    .selectOption("deep");
  await page
    .getByRole("combobox", { name: bt("en", "undertone"), exact: true })
    .selectOption("cool");
  await confirm(page);
  const rows = page.locator("[data-ratio-key]");
  await expect(rows).toHaveCount(3);
  await expect(rows.getByRole("meter")).toHaveCount(0);
  await expect(rows.locator(".reference-ratio-marker")).toHaveCount(0);
  for (const row of await rows.all()) {
    await expect(row).not.toContainText(/\d+(?:\.\d+)?%/);
    await expect(row).toContainText("—");
  }
  await expect(page.getByText(bt("en", "ratiosUnavailable"))).toBeVisible();
  await expect(page.getByTestId("face-vibe-title")).toContainText(
    `#${beautyLabel("en", "cat")}`,
  );
  await expect(page.getByTestId("face-vibe-title")).toContainText(
    `#${beautyLabel("en", "round")}`,
  );
  for (const [card, expected] of [
    ["palette", beautyLabel("en", "cool_clear")],
    ["undertone", beautyLabel("en", "cool")],
    ["depth", beautyLabel("en", "deep")],
  ]) {
    await expect(page.locator(`[data-color-card="${card}"]`)).toContainText(
      expected,
    );
  }
  await expect(page.locator('[data-color-card="chroma"]')).toContainText(
    /clear|vivid/i,
  );
  expect(value.base).toEqual({
    depth: "deep",
    undertone: "cool",
    concealerPurpose: "match",
  });
  expect(value.beauty.preferences?.paletteId).toBe("cool_clear");
  await expect(page.locator("[data-color-card]")).toHaveCount(4);
  expect(
    (await page.locator("[data-color-card]").allTextContents()).join(" "),
  ).not.toMatch(/\d+(?:\.\d+)?%/);
  await page.getByLabel("Language / 언어 / Idioma").selectOption("ko");
  await expect(page.locator('[data-color-card="palette"]')).toContainText(
    beautyLabel("ko", "cool_clear"),
  );
  await expect(page.locator('[data-color-card="depth"]')).toContainText(
    beautyLabel("ko", "deep"),
  );
  await expect(page.locator('[data-color-card="undertone"]')).toContainText(
    beautyLabel("ko", "cool"),
  );
  await expect(page.getByRole("meter")).toHaveCount(0);
  expect(calls.analysis).toBe(1);
  expect(calls.slots).toEqual([]);
});
test("photo-free result retains unknown base colors and has no portrait, ratios or animal suggestion", async ({
  page,
}) => {
  const { calls, value } = await fixture(page);
  await begin(page);
  await privacy(page);
  await confirm(page);
  await expect(page.getByRole("meter")).toHaveCount(0);
  await expect(page.locator(".reference-portrait img")).toHaveCount(0);
  await expect(page.locator(".reference-ratio-marker")).toHaveCount(0);
  await expect(page.getByText(bt("en", "ratiosUnavailable"))).toBeVisible();
  for (const card of ["depth", "undertone"])
    await expect(page.locator(`[data-color-card="${card}"]`)).toContainText(
      beautyLabel("en", "unknown"),
    );
  await expect(page.getByTestId("face-vibe-title")).not.toContainText(
    beautyLabel("en", "cat"),
  );
  expect(value.base).toEqual({
    depth: "unknown",
    undertone: "unknown",
    concealerPurpose: "match",
  });
  expect(calls.analysis).toBe(0);
  expect(calls.slots).toEqual([]);
});
for (const viewport of [
  { width: 1024, height: 768 },
  { width: 1080, height: 1920 },
  { width: 390, height: 844 },
]) {
  test(`reference result at ${viewport.width} shows local ratios and image cards accessibly without overflow`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const { calls, image } = await fixture(page, {
      ratios: {
        status: "measured",
        eyeHeightWidth: 23.4,
        noseFaceWidth: 34.5,
        lipMouthWidth: 18.6,
      },
    });
    await beginWithGender(page, "man");
    await privacy(page, { photo: true, preview: true });
    await upload(page, image);
    await confirm(page);
    for (const [key, value] of [
      ["eyeHeightWidth", 23.4],
      ["noseFaceWidth", 34.5],
      ["lipMouthWidth", 18.6],
    ] as const) {
      const row = page.locator(`[data-ratio-key="${key}"]`);
      await expect(row.getByRole("meter")).toHaveAttribute(
        "aria-valuenow",
        String(value),
      );
      await expect(row).toContainText(`${value}%`);
      expect(
        await row
          .locator(".reference-ratio-marker")
          .evaluate((node) => (node as HTMLElement).style.left),
      ).toBe(`${value}%`);
      await expect(row.getByRole("meter")).not.toHaveAccessibleName(
        /confidence|accuracy|attractiveness/i,
      );
    }
    await expect(page.locator(".complete-look img")).toHaveCount(9);
    expect(
      await page
        .locator(".complete-generation")
        .evaluate((element) => getComputedStyle(element).position),
    ).not.toMatch(/^(fixed|sticky)$/);
    await expect(
      page
        .getByRole("region", { name: bt("en", "faceTitle") })
        .getByAltText(bt("en", "ownPhoto"), { exact: true }),
    ).toHaveAttribute("src", /^blob:/);
    for (const img of await page.locator(".complete-look img").all())
      await expect(img).toHaveAttribute("src", /^blob:/);
    for (const kind of ["makeupTitle", "hairTitle", "hairColorTitle"] as const)
      await expect(
        page
          .getByRole("region", { name: bt("en", kind) })
          .locator(".complete-look img"),
      ).toHaveCount(3);
    await expect(page.locator("[data-color-card]")).toHaveCount(4);
    expect(
      (await page.locator("[data-color-card]").allTextContents()).join(" "),
    ).not.toMatch(/\d+(?:\.\d+)?%/);
    await page.evaluate(() => document.fonts.ready);
    const geometry = await page
      .locator(".reference-face-grid")
      .evaluate((grid) => {
        const portrait = grid
          .querySelector(".reference-portrait")!
          .getBoundingClientRect();
        const metrics = grid
          .querySelector(".reference-feature-list")!
          .getBoundingClientRect();
        return {
          portrait: {
            left: portrait.left,
            right: portrait.right,
            top: portrait.top,
            bottom: portrait.bottom,
          },
          metrics: {
            left: metrics.left,
            right: metrics.right,
            top: metrics.top,
            bottom: metrics.bottom,
          },
        };
      });
    if (viewport.width >= 700)
      expect(geometry.portrait.right).toBeLessThanOrEqual(
        geometry.metrics.left,
      );
    else
      expect(geometry.portrait.bottom).toBeLessThanOrEqual(
        geometry.metrics.top,
      );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath(`result-full-${viewport.width}.png`),
      fullPage: true,
    });
    await page
      .locator(".reference-face-study")
      .evaluate((element) =>
        window.scrollTo(
          0,
          window.scrollY + element.getBoundingClientRect().top - 48,
        ),
      );
    await page.screenshot({
      path: testInfo.outputPath(`face-${viewport.width}.png`),
    });
    await page.locator(".reference-face-study").screenshot({
      path: testInfo.outputPath(`face-component-${viewport.width}.png`),
    });
    await page.locator('[data-color-card="palette"]').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`color-${viewport.width}.png`),
    });
    await page
      .locator('[data-preview-id="hair-textured-crop"]')
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`hair-${viewport.width}.png`),
    });
    const accessibility = await new AxeBuilder({ page }).analyze();
    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    const review = JSON.stringify(
      {
        viewport,
        dimensions,
        geometry,
        violations: accessibility.violations,
        pageErrors,
      },
      null,
      2,
    );
    await writeFile(testInfo.outputPath("review.json"), review);
    await testInfo.attach("result-visual-review", {
      path: testInfo.outputPath("review.json"),
      contentType: "application/json",
    });
    expect(accessibility.violations).toEqual([]);
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
    expect(pageErrors).toEqual([]);
    expect(calls.analysis).toBe(1);
    expect(calls.slots).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(calls.unexpected).toEqual([]);
    expect(JSON.stringify(calls.jsonBodies)).not.toMatch(
      /blob:|eyeHeightWidth|noseFaceWidth|lipMouthWidth/,
    );
    await page
      .getByRole("button", { name: bt("en", "finish"), exact: true })
      .click();
    await expect(page.getByRole("meter")).toHaveCount(0);
    await expect
      .poll(async () => (await media(page)).activeUrls.length)
      .toBe(0);
  });
}
test("nine edits use the same original, run sequentially, show partial success and never retry", async ({
  page,
}) => {
  const { calls, image } = await fixture(page, { failSlot: 4 });
  await begin(page);
  await privacy(page, { photo: true, preview: true });
  await upload(page, image);
  expect(calls.slots).toEqual([]);
  await confirm(page);
  await expect.poll(() => calls.slots.length).toBe(9);
  expect(calls.slots).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  expect(calls.bodies).toHaveLength(10);
  for (const body of calls.bodies)
    expect(body.equals(Buffer.from(image.png, "base64"))).toBe(true);
  await expect(page.locator(".complete-look img")).toHaveCount(8);
  await expect(
    page
      .getByRole("region", { name: bt("en", "hairTitle") })
      .getByText(bt("en", "failed"), { exact: true }),
  ).toHaveCount(1);
  await page.getByLabel("Language / 언어 / Idioma").selectOption("es");
  await expect(page.locator(".complete-look img")).toHaveCount(8);
  expect(calls.slots).toHaveLength(9);
  await page
    .getByRole("button", { name: bt("es", "finish"), exact: true })
    .click();
  await expect.poll(async () => (await media(page)).activeUrls.length).toBe(0);
  await expect.poll(() => calls.finish.length).toBe(1);
  expect(calls.unexpected).toEqual([]);
});
for (const boundary of ["finish", "hidden", "direction", "cancel"] as const) {
  test(`${boundary} discards a late preview and stops the remaining requests`, async ({
    page,
  }) => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls, image } = await fixture(page, { holdSlot: 1, hold });
    await begin(page);
    await privacy(page, { photo: true, preview: true });
    await upload(page, image);
    await confirm(page);
    await expect.poll(() => calls.slots.length).toBe(2);
    await expect(page.locator(".complete-look img")).toHaveCount(1);
    await expect(page.locator(".complete-generation")).toHaveClass(/is-active/);
    if (boundary === "finish")
      await page
        .getByRole("button", { name: bt("en", "finish"), exact: true })
        .click();
    else if (boundary === "hidden")
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", {
          configurable: true,
          get: () => true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    else if (boundary === "direction")
      await page.locator(".complete-hair-choice").first().click();
    else
      await page
        .getByRole("button", {
          name: bt("en", "cancelGeneration"),
          exact: true,
        })
        .click();
    release();
    await expect.poll(() => calls.cancel).toBeGreaterThan(0);
    await expect(page.locator(".complete-look img")).toHaveCount(0);
    expect(calls.slots).toEqual([0, 1]);
    await expect
      .poll(async () => (await media(page)).activeUrls.length)
      .toBe(boundary === "direction" || boundary === "cancel" ? 1 : 0);
    if (boundary === "cancel") {
      await expect(page.locator(".complete-generation")).not.toHaveClass(
        /is-active/,
      );
      expect(
        await page
          .locator(".complete-generation")
          .evaluate((element) => getComputedStyle(element).position),
      ).not.toMatch(/^(fixed|sticky)$/);
      await expect(
        page.getByRole("button", {
          name: bt("en", "cancelGeneration"),
          exact: true,
        }),
      ).toHaveCount(0);
    }
    expect(calls.analysis).toBe(1);
  });
}
test("failed analysis remains one-attempt and photo-free continuation makes no new call", async ({
  page,
}) => {
  const { calls, image } = await fixture(page, { analysisFailure: true });
  await begin(page);
  await privacy(page, { photo: true });
  await page.getByLabel(bt("en", "upload")).setInputFiles({
    name: "synthetic.png",
    mimeType: "image/png",
    buffer: Buffer.from(image.png, "base64"),
  });
  await page
    .getByRole("button", { name: bt("en", "analyze"), exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel(bt("en", "upload"))).toBeDisabled();
  await page
    .getByRole("button", { name: bt("en", "withoutPhoto"), exact: true })
    .click();
  await confirm(page);
  expect(calls.analysis).toBe(1);
  expect(calls.slots).toEqual([]);
});
test("downloaded guide excludes photos, geometry, animal, Gender and analysis", async ({
  page,
}) => {
  const { calls, image } = await fixture(page);
  await begin(page);
  await privacy(page, { photo: true });
  await upload(page, image);
  await confirm(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: bt("en", "download"), exact: true })
      .click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  expect(text).toContain(product.name);
  expect(text).toContain(lipProduct.name);
  for (const forbidden of [
    "blob:",
    "base64",
    "animalVibe",
    "request_id",
    "observed_features",
    "eyeHeightWidth",
    "Gender",
    "25-34",
  ])
    expect(text).not.toContain(forbidden);
  expect(calls.share).toEqual([]);
});
test("QR opt-in sends only a current notice acknowledgement", async ({
  page,
}) => {
  const { calls } = await fixture(page, { sharing: true });
  await begin(page);
  await privacy(page);
  await confirm(page);
  await page
    .getByRole("button", { name: bt("en", "save"), exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: bt("en", "createQR"), exact: true })
    .click();
  await expect(dialog.getByAltText(bt("en", "save"))).toBeVisible();
  expect(calls.share).toEqual([
    { accepted: true, noticeVersion: "2026-10-complete-save-v1" },
  ]);
});
for (const quality of ["no_photo", "limited", "not_assessable"] as const) {
  test(`staged previews with ${quality} show no false pending count and make no edit call`, async ({
    page,
  }) => {
    const { calls, image } = await fixture(page, {
      ...(quality === "no_photo" ? {} : { beautyQuality: quality }),
    });
    await begin(page);
    await privacy(page, { preview: true, photo: quality !== "no_photo" });
    if (quality !== "no_photo") await upload(page, image);
    await confirm(page);
    await expect(page.locator(".complete-generation")).toHaveCount(0);
    await expect(
      page.getByText(bt("en", "noPreview"), { exact: true }).first(),
    ).toBeVisible();
    expect(calls.slots).toEqual([]);
    expect(calls.analysis).toBe(quality === "no_photo" ? 0 : 1);
    if (quality !== "no_photo")
      await expect(
        page
          .getByRole("region", { name: bt("en", "skinTitle") })
          .getByRole("heading", { name: product.name }),
      ).toBeVisible();
  });
}
for (const choice of [
  { gender: "man", direction: "masculine" },
  { gender: "woman", direction: "feminine" },
  { gender: null, direction: "balanced" },
] as const) {
  test(`${choice.gender ?? "unspecified"} selects ${choice.direction} previews without sharing raw Gender`, async ({
    page,
  }) => {
    const { calls, image } = await fixture(page, { sharing: true });
    await beginWithGender(page, choice.gender);
    await privacy(page, { photo: true, preview: true });
    await upload(page, image);
    await confirm(page);
    await expect.poll(() => calls.previewHeaders.length).toBe(9);
    await expect(page.locator(".complete-look img")).toHaveCount(9);
    for (const headers of calls.previewHeaders) {
      expect(headers["x-beauty-styling-direction"] ?? "balanced").toBe(
        choice.direction,
      );
      expect(
        Object.keys(headers).some((key) =>
          key.toLowerCase().includes("gender"),
        ),
      ).toBe(false);
      expect(Object.values(headers)).not.toContain("man");
      expect(Object.values(headers)).not.toContain("woman");
    }
    const makeupIds =
      choice.direction === "masculine"
        ? ["makeup-natural", "makeup-groomed", "makeup-definition"]
        : ["soft", "fresh", "defined"];
    const hairIds =
      choice.direction === "masculine"
        ? ["hair-textured-crop", "hair-curtain-part", "hair-soft-quiff"]
        : ["hairShort", "hairMedium", "hairLong"];
    for (const [section, ids] of [
      ["makeupTitle", makeupIds],
      ["hairTitle", hairIds],
    ] as const) {
      for (const id of ids) {
        const name = beautyLabel("en", id);
        expect(name).not.toBe(id);
        await expect(
          page
            .getByRole("region", { name: bt("en", section) })
            .getByRole("heading", { name, exact: true }),
        ).toBeVisible();
      }
    }
    await page.getByLabel("Language / 언어 / Idioma").selectOption("ko");
    for (const id of hairIds) {
      await expect(
        page
          .getByRole("region", { name: bt("ko", "hairTitle") })
          .getByRole("heading", { name: beautyLabel("ko", id), exact: true }),
      ).toBeVisible();
    }
    expect(calls.analysis).toBe(1);
    expect(calls.slots).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    await page.getByLabel("Language / 언어 / Idioma").selectOption("en");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page
        .getByRole("button", { name: bt("en", "download"), exact: true })
        .click(),
    ]);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).not.toMatch(
      /\b(?:gender|masculine|feminine|man|woman)\b/i,
    );
    await page
      .getByRole("button", { name: bt("en", "save"), exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox").check();
    await dialog
      .getByRole("button", { name: bt("en", "createQR"), exact: true })
      .click();
    await expect(dialog.getByAltText(bt("en", "save"))).toBeVisible();
    expect(calls.share).toEqual([
      { accepted: true, noticeVersion: "2026-10-complete-save-v1" },
    ]);
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: bt("en", "finish"), exact: true })
      .click();
    await expect.poll(() => calls.finish.length).toBe(1);
    expect(calls.finish).toEqual([{ gender: null }]);
    const ordinaryRequests = calls.jsonBodies.filter(
      ({ action }) => action !== "beauty-complete-finish",
    );
    expect(JSON.stringify(ordinaryRequests)).not.toMatch(
      /"(?:gender|stylingDirection)"\s*:|"(?:man|woman|masculine|feminine)"/i,
    );
    expect(calls.unexpected).toEqual([]);
  });
}
test("optional Gender stays out of context and is sent only on an opted-in adult Finish", async ({
  page,
}) => {
  const { calls } = await fixture(page);
  await page.goto("/kiosk");
  await page
    .getByRole("button", { name: bt("en", "start"), exact: true })
    .click();
  await page.getByRole("button", { name: "25-34", exact: true }).click();
  await page.locator("summary", { hasText: bt("en", "gender") }).click();
  await page
    .getByRole("combobox", { name: bt("en", "gender"), exact: true })
    .selectOption("prefer_not_to_say");
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: bt("en", "next"), exact: true })
    .click();
  expect(calls.contexts).toEqual([
    { ageBand: "25-34", locale: "en", analyticsConsent: true },
  ]);
  await privacy(page);
  await confirm(page);
  await page
    .getByRole("button", { name: bt("en", "finish"), exact: true })
    .click();
  await expect.poll(() => calls.finish.length).toBe(1);
  expect(calls.finish).toEqual([{ gender: "prefer_not_to_say" }]);
});
test("absolute session expiry clears an active preview and rejects its late result", async ({
  page,
}) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { calls, image } = await fixture(page, { holdSlot: 1, hold });
  await page.clock.install();
  await begin(page);
  await privacy(page, { photo: true, preview: true });
  await upload(page, image);
  await confirm(page);
  await expect.poll(() => calls.slots.length).toBe(2);
  await expect(page.locator(".complete-look img")).toHaveCount(1);
  await page.clock.fastForward(15 * 60 * 1000 + 1000);
  release();
  await expect(
    page.getByRole("button", { name: bt("en", "start"), exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await media(page)).activeUrls.length).toBe(0);
  expect(calls.slots).toEqual([0, 1]);
  await expect.poll(() => calls.finish.length).toBe(1);
});
test("new phone guide strips the bearer fragment, preserves original products and supports revocation", async ({
  page,
}) => {
  const calls = { read: 0, revoke: 0 };
  await page.route("**/api/v1/**", async (route) => {
    expect(new URL(page.url()).hash).toBe("");
    expect(new URL(route.request().url()).search).toBe("");
    expect(route.request().postDataJSON()).toEqual({ token });
    if (route.request().url().endsWith("/complete-revoke")) {
      calls.revoke++;
      return route.fulfill({ json: { ok: true } });
    }
    calls.read++;
    return route.fulfill({ json: savedGuide("ko") });
  });
  await page.goto(`/result#${token}`);
  await expect(page).toHaveURL(/\/result$/);
  await expect(
    page.getByRole("heading", { name: bt("ko", "reportTitle") }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: product.name })).toBeVisible();
  await page.getByLabel("Language / 언어 / Idioma").selectOption("es");
  await expect(
    page.getByRole("heading", { name: bt("es", "reportTitle") }),
  ).toBeVisible();
  expect(calls.read).toBeGreaterThan(0);
  const storage = await page.evaluate(
    (secret) => ({
      local: JSON.stringify(localStorage),
      session: JSON.stringify(sessionStorage),
      html: document.documentElement.outerHTML.includes(secret),
    }),
    token,
  );
  expect(storage.local).not.toContain(token);
  expect(storage.session).not.toContain(token);
  expect(storage.html).toBe(false);
  await page
    .getByRole("button", { name: bt("es", "delete"), exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    bt("es", "savedDeleted"),
  );
  expect(calls.revoke).toBe(1);
});
