import { describe, expect, it, vi } from "vitest";
import { readSkinConsultation } from "@/application/skin-consultation";
import {
  AppError,
  type Consultation,
  type DeviceContext,
  type OpenAIAnalysis,
  type Policy,
  type Repository,
} from "@/application/contracts";
import {
  OPENAI_CONSENT_VERSION,
  OPENAI_SKIN_DISCLAIMER,
  OPENAI_SKIN_MODEL,
  OPENAI_SKIN_PROMPT_VERSION,
} from "@/domain/skin-vision";
import type { Product, Recommendation } from "@/domain/types";

const id = "44444444-4444-4444-8444-444444444444";
const device: DeviceContext = {
  organizationId: "verified-org",
  storeId: "verified-store",
  deviceId: "paired-device",
};
const policy: Policy = {
  id: "pinned-policy",
  version: "published-v2",
  source: "operator-configured",
  rules: [
    { concern: "dehydration", ingredient: "Glycerin", relevance: 3 },
    { concern: "dehydration", ingredient: "Panthenol", relevance: 2 },
    { concern: "texture", ingredient: "Niacinamide", relevance: 2 },
  ],
};
function product(key: string, ingredient: string): Product {
  return {
    id: key,
    organizationId: device.organizationId,
    storeId: device.storeId,
    sku: key,
    brand: "Registered brand",
    name: `Registered ${key}`,
    category: "serum",
    priceMinor: 2500,
    currency: "USD",
    stock: 4,
    visible: true,
    ingredients: ["Aqua", ingredient],
    formulaComplete: true,
    suitableSkinTypes: ["dry"],
    status: "published",
  };
}
const hydrationProduct = product("HYDRATION", "Glycerin");
const textureProduct = product("TEXTURE", "Niacinamide");
const hydrationMatch: Recommendation = {
  product: hydrationProduct,
  score: 3,
  matchedIngredients: ["Glycerin"],
  reasons: [{ concern: "dehydration", ingredient: "Glycerin", relevance: 3 }],
};
const textureMatch: Recommendation = {
  product: textureProduct,
  score: 2,
  matchedIngredients: ["Niacinamide"],
  reasons: [{ concern: "texture", ingredient: "Niacinamide", relevance: 2 }],
};
function analysis(): OpenAIAnalysis {
  return {
    request_id: id,
    mode: "openai",
    model_version: OPENAI_SKIN_MODEL,
    quality_status: "usable",
    observations: [],
    disclaimer: OPENAI_SKIN_DISCLAIMER,
    vision: {
      prompt_version: OPENAI_SKIN_PROMPT_VERSION,
      image_quality: "usable",
      quality_flags: [],
      observed_features: {
        visible_redness: "not_visible",
        visible_spots: "not_visible",
        visible_pores: "visible",
        visible_fine_lines: "not_visible",
        visible_flaking: "not_visible",
      },
    },
  };
}
function session(changes: Partial<Consultation> = {}): Consultation {
  return {
    id,
    ...device,
    createdAt: "2026-10-11T17:00:00.000Z",
    consent: true,
    consentVersion: OPENAI_CONSENT_VERSION,
    answers: {
      skinType: "dry",
      concerns: ["dehydration"],
      sensitive: false,
      excludedIngredients: ["Parfum"],
    },
    analysis: analysis(),
    recommendations: [hydrationMatch, textureMatch],
    ...changes,
  };
}
function fixture({
  initial = session(),
  current = initial,
  catalog = [hydrationProduct, textureProduct],
}: {
  initial?: Consultation;
  current?: Consultation;
  catalog?: Product[];
} = {}) {
  const sessionRead = vi
    .fn<Repository["session"]>()
    .mockResolvedValueOnce(initial)
    .mockResolvedValue(current);
  const policyRead = vi.fn<Repository["policy"]>().mockResolvedValue(policy);
  const productsRead = vi
    .fn<Repository["products"]>()
    .mockResolvedValue(catalog);
  const methods = {
    session: sessionRead,
    policy: policyRead,
    products: productsRead,
  };
  // Any unexpected writer, analysis claim or other port call fails this read-only fixture.
  const repository = new Proxy(methods, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      throw new Error(`Unexpected read-model port: ${String(property)}`);
    },
  }) as unknown as Repository;
  return { repository, sessionRead, policyRead, productsRead };
}

describe("saved OpenAI skin consultation read model", () => {
  it("explains saved vision using the pinned session policy and actual registered products", async () => {
    const f = fixture();
    const result = await readSkinConsultation(f.repository, id, device);
    expect(f.policyRead).toHaveBeenCalledExactlyOnceWith(device, id);
    expect(f.productsRead).toHaveBeenCalledExactlyOnceWith(device.storeId);
    expect(f.sessionRead).toHaveBeenCalledTimes(2);
    expect(result.skinConsultation).toMatchObject({
      status: "photo_based",
      policyVersion: policy.version,
      summary: expect.stringContaining("pores"),
    });
    expect(result.skinConsultation?.goals).toEqual([
      expect.objectContaining({ concern: "dehydration", source: "selected" }),
      expect.objectContaining({ concern: "texture", source: "photo" }),
    ]);
    expect(
      result.skinConsultation?.ingredients.find(
        (item) => item.ingredient === "Glycerin",
      )?.rationale,
    ).toContain("humectant");
    expect(
      result.skinConsultation?.products.map((item) => item.productId),
    ).toEqual([hydrationProduct.id, textureProduct.id]);
    expect(result.skinConsultation?.products[1].reasons[0]).toMatchObject({
      ingredient: "Niacinamide",
      source: "photo",
    });
  });

  it("still recommends ingredients and explains skin when no eligible store product matches", async () => {
    const f = fixture({
      initial: session({ recommendations: [] }),
      catalog: [],
    });
    const result = await readSkinConsultation(f.repository, id, device);
    expect(result.recommendations).toEqual([]);
    expect(result.skinConsultation?.observations).toHaveLength(5);
    expect(
      result.skinConsultation?.ingredients.map((item) => item.ingredient),
    ).toEqual(["Glycerin", "Niacinamide", "Panthenol"]);
    expect(
      result.skinConsultation?.ingredients.every(
        (item) => !item.availableInMatchedProducts,
      ),
    ).toBe(true);
    expect(result.skinConsultation?.products).toEqual([]);
  });

  it("derives a photo-free report from answers without claiming photo findings", async () => {
    const f = fixture({
      initial: session({
        analysis: {
          ...analysis(),
          quality_status: "not_provided",
          vision: null,
        },
      }),
    });
    const result = await readSkinConsultation(f.repository, id, device);
    expect(result.skinConsultation?.status).toBe("questionnaire_only");
    expect(result.skinConsultation?.observations).toEqual([]);
    expect(
      result.skinConsultation?.goals.every(
        (goal) => goal.source === "selected",
      ),
    ).toBe(true);
    expect(result.recommendations?.map((item) => item.product.id)).toEqual([
      hydrationProduct.id,
    ]);
  });

  it("removes matches made unavailable by current publication, formula, exclusion or scope changes", async () => {
    const changes: Partial<Product>[] = [
      { status: "draft" },
      { visible: false },
      { stock: 0 },
      { ingredients: ["Aqua", "Glycerin", "Parfum"] },
      { organizationId: "other-organization" },
      { storeId: "other-store" },
      { ingredients: ["Aqua", "Panthenol"] },
      { formulaComplete: false },
    ];
    for (const change of changes) {
      const f = fixture({
        catalog: [{ ...hydrationProduct, ...change }, textureProduct],
      });
      const result = await readSkinConsultation(f.repository, id, device);
      expect(result.recommendations?.map((item) => item.product.id)).toEqual([
        textureProduct.id,
      ]);
      expect(
        result.skinConsultation?.products.map((item) => item.productId),
      ).toEqual([textureProduct.id]);
      expect(
        result.skinConsultation?.ingredients.find(
          (item) => item.ingredient === "Glycerin",
        )?.matchedProductIds,
      ).toEqual([]);
    }
  });

  it("refreshes catalog fields while preserving saved match order and scores and never adds new products", async () => {
    const initial = session({
      recommendations: [textureMatch, hydrationMatch],
    });
    const latestHydration = {
      ...hydrationProduct,
      name: "Current registered name",
      priceMinor: 3300,
      stock: 2,
    };
    const f = fixture({
      initial,
      current: session({
        recommendations: [
          { ...hydrationMatch, product: latestHydration, score: 100 },
          { ...textureMatch, score: 200 },
        ],
      }),
      catalog: [
        latestHydration,
        product("NEW-MATCH", "Glycerin"),
        textureProduct,
      ],
    });
    const result = await readSkinConsultation(f.repository, id, device);
    expect(
      result.recommendations?.map((item) => [item.product.id, item.score]),
    ).toEqual([
      [textureProduct.id, 2],
      [hydrationProduct.id, 3],
    ]);
    expect(result.recommendations?.[1].product).toMatchObject({
      name: "Current registered name",
      priceMinor: 3300,
      stock: 2,
    });
    expect(
      result.skinConsultation?.products.map((item) => item.productId),
    ).toEqual([textureProduct.id, hydrationProduct.id]);
  });

  it("uses the final live session snapshot without resurrecting a product removed during assembly", async () => {
    const latestProduct = {
      ...hydrationProduct,
      name: "Final live name",
      priceMinor: 3900,
      stock: 1,
    };
    const current = session({
      createdAt: "2026-10-11T17:00:01.000Z",
      recommendations: [{ ...hydrationMatch, product: latestProduct }],
    });
    const f = fixture({ current });
    const result = await readSkinConsultation(f.repository, id, device);
    expect(result.createdAt).toBe(current.createdAt);
    expect(result.recommendations?.map((item) => item.product.id)).toEqual([
      hydrationProduct.id,
    ]);
    expect(result.recommendations?.[0].product).toMatchObject({
      name: "Final live name",
      priceMinor: 3900,
      stock: 1,
    });
    expect(
      result.skinConsultation?.products.map((item) => item.productId),
    ).toEqual([hydrationProduct.id]);
    expect(
      result.skinConsultation?.ingredients.find(
        (item) => item.ingredient === "Niacinamide",
      )?.availableInMatchedProducts,
    ).toBe(false);
  });

  it("rejects a report if the consultation finishes during assembly", async () => {
    const f = fixture();
    f.sessionRead
      .mockReset()
      .mockResolvedValueOnce(session())
      .mockRejectedValue(
        new AppError(404, "session_not_found", "This consultation has ended."),
      );
    await expect(
      readSkinConsultation(f.repository, id, device),
    ).rejects.toMatchObject({ code: "session_not_found" });
  });

  it("rejects a report if the device is revoked during assembly", async () => {
    const f = fixture();
    f.sessionRead
      .mockReset()
      .mockResolvedValueOnce(session())
      .mockRejectedValue(
        new AppError(403, "device_revoked", "This device is no longer paired."),
      );
    await expect(
      readSkinConsultation(f.repository, id, device),
    ).rejects.toMatchObject({ code: "device_revoked" });
  });

  it("rejects consent withdrawal or a different analysis on the final session read", async () => {
    for (const current of [
      session({ consent: false }),
      session({
        analysis: {
          ...analysis(),
          request_id: "55555555-5555-4555-8555-555555555555",
        },
      }),
      session({ analysis: null }),
    ]) {
      const f = fixture({ current });
      await expect(
        readSkinConsultation(f.repository, id, device),
      ).rejects.toMatchObject({ code: "consultation_changed" });
    }
  });

  it("fails closed on an invalid saved vision protocol before reading policy or catalog", async () => {
    const f = fixture({
      initial: session({
        analysis: {
          ...analysis(),
          disclaimer: "Untrusted arbitrary medical claims",
        },
      }),
    });
    await expect(
      readSkinConsultation(f.repository, id, device),
    ).rejects.toMatchObject({ code: "invalid_analysis" });
    expect(f.policyRead).not.toHaveBeenCalled();
    expect(f.productsRead).not.toHaveBeenCalled();
  });

  it("does not invent a completed report before answers and saved recommendations exist", async () => {
    for (const initial of [
      session({ answers: null }),
      session({ recommendations: null }),
    ]) {
      const f = fixture({ initial });
      expect(
        (await readSkinConsultation(f.repository, id, device)).skinConsultation,
      ).toBeNull();
      expect(f.policyRead).not.toHaveBeenCalled();
      expect(f.productsRead).not.toHaveBeenCalled();
    }
  });

  it("leaves a legacy mock consultation untouched with no new analysis or recommendation work", async () => {
    const initial = session({
      analysis: {
        request_id: id,
        mode: "mock",
        model_version: "demo",
        quality_status: "demo",
        observations: [],
        disclaimer: "Mock demonstration",
      },
    });
    const f = fixture({ initial });
    expect(await readSkinConsultation(f.repository, id, device)).toBe(initial);
    expect(f.policyRead).not.toHaveBeenCalled();
    expect(f.productsRead).not.toHaveBeenCalled();
    expect(f.sessionRead).toHaveBeenCalledTimes(1);
  });
});
