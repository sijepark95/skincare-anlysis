import { expect, test, type Page } from "@playwright/test";
import {
  buildBeautyGuide,
  type BeautyPreferences,
} from "../../src/domain/beauty";
import type { SavedBeautyResult } from "../../src/application/beauty-consultations";
import type { ColorMatch } from "../../src/domain/personal-color";
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
const match: ColorMatch = {
  product: {
    id: "44444444-4444-4444-8444-444444444444",
    organizationId: device.organizationId,
    storeId: device.storeId,
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
  },
  shade: {
    variantId: "44444444-4444-4444-8444-444444444444",
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
  },
  reasons: [
    "You confirmed soft warmth.",
    "The store reviewed this warm soft satin shade.",
  ],
};
const token = "testSavedGuideToken1234567890abcdefghijklmno";
async function savedFixture(page: Page, expired = false) {
  const value: SavedBeautyResult = {
    guideVersion: "beauty-style-guide-v1",
    guide: buildBeautyGuide(preferences)!,
    preferences,
    expiresAt: "2026-10-12T18:00:00Z",
    products: [
      {
        variantId: match.product.id,
        shadeVersionId: match.shade.versionId,
        name: match.product.name,
        brand: match.product.brand,
        priceMinor: null,
        currency: null,
        shadeName: match.shade.shadeName,
        hueFamily: match.shade.hueFamily,
        undertone: match.shade.undertone,
        intensity: match.shade.intensity,
        finish: match.shade.finish,
        swatchHex: match.shade.swatchHex,
        available: false,
      },
    ],
  };
  const calls = { read: 0, revoke: 0 };
  await page.route("**/api/v1/shared-results/**", async (route) => {
    expect(new URL(page.url()).hash).toBe("");
    expect(new URL(route.request().url()).search).toBe("");
    expect(route.request().postDataJSON()).toEqual({ token });
    if (route.request().url().endsWith("/revoke")) {
      calls.revoke++;
      return route.fulfill({ json: { ok: true } });
    }
    calls.read++;
    return expired
      ? route.fulfill({
          status: 404,
          json: {
            error: {
              code: "expired",
              message: "This saved guide is unavailable or expired.",
            },
          },
        })
      : route.fulfill({ json: value });
  });
  return { calls, value };
}

test("saved link strips fragment before read, survives effect replay, and supports deletion", async ({
  page,
}) => {
  const { calls } = await savedFixture(page);
  await page.goto(`/result#${token}`);
  await expect(
    page.getByRole("heading", { name: "Your lip color match." }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/result$/);
  await expect(page.getByText(/Currently unavailable/)).toBeVisible();
  await expect(page.getByText("$24.00")).toHaveCount(0);
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
  expect(calls.read).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Delete saved guide" }).click();
  await expect(page.getByRole("status")).toContainText("was deleted");
  await expect(page.getByLabel("Your beauty book")).toHaveCount(0);
  expect(calls.revoke).toBe(1);
});

test("missing and expired saved links show honest recovery without exposing a token", async ({
  page,
}) => {
  await page.goto("/result");
  await expect(page.locator(".beauty-shell [role=alert]")).toContainText(
    "missing or invalid",
  );
  await savedFixture(page, true);
  await page.goto(`/result#${token}`);
  await expect(page.locator(".beauty-shell [role=alert]")).toContainText(
    "unavailable or expired",
  );
  await expect(page).toHaveURL(/\/result$/);
});
