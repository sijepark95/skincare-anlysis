import { describe, expect, it, vi } from "vitest";
import { Consultations } from "../../src/application/consultations";
import {
  type Analysis,
  type Answers,
  type ExperimentalAnalysis,
} from "../../src/application/contracts";
import { DEMO_STORE_ID, demoProducts } from "../../src/domain/demo-catalog";
import { LocalMockAnalysis } from "../../src/infrastructure/analysis";
import { DemoRepository } from "../../src/infrastructure/demo-repository";

const preferences: Answers = {
  skinType: "dry",
  concerns: ["dehydration", "texture"],
  excludedIngredients: [],
  sensitive: false,
};

function setup() {
  let clock = Date.parse("2026-10-10T12:00:00Z");
  const repository = new DemoRepository(false, () => clock);
  const device = repository.ensureDevice("test-device");
  const analyzer = new LocalMockAnalysis();
  const app = new Consultations(repository, analyzer);
  return {
    repository,
    device,
    analyzer,
    app,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}

describe("anonymous consultation lifecycle", () => {
  it("requires the current experimental consent before processing a photo", async () => {
    const { repository, device } = setup();
    const analyze = vi.fn();
    const app = new Consultations(repository, { analyze });
    const session = await app.start(device);
    await app.consent(session.id, device, true);
    await app.answers(session.id, device, preferences);
    await expect(
      app.analyze(
        session.id,
        device,
        new Uint8Array([1]),
        "2026-10-experimental-v1",
      ),
    ).rejects.toMatchObject({ code: "consent_required" });
    expect(analyze).not.toHaveBeenCalled();
    await app.finish(session.id, device);
    const fresh = await app.start(device);
    await app.consent(fresh.id, device, true, "2026-10-experimental-v1");
    expect((await repository.session(fresh.id, device)).consentVersion).toBe(
      "2026-10-experimental-v1",
    );
  });

  it("passes photo bytes only to the analyzer and ranks the resulting experimental ingredients", async () => {
    const { repository, device } = setup();
    const analyze = vi.fn(async (request_id: string): Promise<Analysis> => ({
      request_id,
      mode: "experimental",
      model_version: "local-experimental-1",
      quality_status: "experimental",
      observations: [],
      disclaimer: "Experimental outputs; not clinical measurements.",
      visual: null,
      ingredients: {
        model_version: "linear-1",
        candidates: [
          { ingredient: "Glycerin", score: 0.1 },
          { ingredient: "Panthenol", score: 0.9 },
        ],
        input_coverage: ["skin_type"],
      },
    }));
    const app = new Consultations(repository, { analyze });
    const session = await app.start(device);
    await app.consent(session.id, device, true);
    await app.answers(session.id, device, preferences);
    const image = new Uint8Array([1, 2, 3]);
    const result = await app.analyze(session.id, device, image);
    expect(analyze).toHaveBeenCalledWith(session.id, preferences, image);
    expect(result.analysis?.mode).toBe("experimental");
    expect(result.analysis?.observations).toEqual([]);
    expect(result.recommendations!.length).toBeGreaterThan(0);
    expect(
      result.recommendations!.every(({ reasons }) =>
        reasons.every(({ ingredient }) =>
          ["Glycerin", "Panthenol"].includes(ingredient),
        ),
      ),
    ).toBe(true);
    expect(
      JSON.stringify(await repository.session(session.id, device)),
    ).not.toContain('"image"');
    await app.analyze(session.id, device, new Uint8Array([9]));
    expect(analyze).toHaveBeenCalledTimes(1);
    await app.finish(session.id, device);
    await expect(repository.session(session.id, device)).rejects.toMatchObject({
      code: "session_not_found",
    });
  });

  it("keeps a failed experimental provider fail-closed without substitute results", async () => {
    const { repository, device } = setup();
    const app = new Consultations(repository, {
      analyze: vi.fn().mockRejectedValue(new Error("unavailable")),
    });
    const session = await app.start(device);
    await app.consent(session.id, device, true);
    await app.answers(session.id, device, preferences);
    await expect(
      app.analyze(session.id, device, new Uint8Array([1])),
    ).rejects.toThrow("unavailable");
    expect(await repository.session(session.id, device)).toMatchObject({
      analysis: null,
      recommendations: null,
    });
    expect((await repository.metrics(device.storeId)).analyzed).toBe(0);
  });

  it("lets two photo-derived candidate sets change product order without overriding store policy or selected goals", async () => {
    const { repository, device } = setup();
    const product = (
      sku: string,
      ingredients: string[],
      overrides: Partial<(typeof demoProducts)[number]> = {},
    ) => ({
      ...demoProducts[0],
      id: sku,
      sku,
      ingredients: ["Aqua", ...ingredients],
      ...overrides,
    });
    const products = [
      product("GLYCERIN", ["Glycerin"]),
      product("PANTHENOL", ["Panthenol"]),
      product("OTHER-TENANT", ["Glycerin", "Panthenol"], {
        organizationId: "99999999-9999-4999-8999-999999999999",
      }),
      product("OTHER-STORE", ["Glycerin", "Panthenol"], {
        storeId: "22222222-2222-4222-8222-222222222223",
      }),
      product("NO-STOCK", ["Glycerin", "Panthenol"], { stock: 0 }),
      product("HIDDEN", ["Glycerin", "Panthenol"], { visible: false }),
      product("DRAFT", ["Glycerin", "Panthenol"], { status: "draft" }),
      product("INCOMPLETE", ["Glycerin", "Panthenol"], {
        formulaComplete: false,
      }),
      product("EXCLUDED", ["Glycerin", "Panthenol", "Niacinamide"]),
      product("UNAPPROVED-INGREDIENT", ["Betaine"]),
      product("UNSELECTED-GOAL", ["Palmitoyl Tripeptide-1"]),
    ];
    vi.spyOn(repository, "products").mockResolvedValue(products);
    vi.spyOn(repository, "policy").mockResolvedValue({
      id: "reviewed-policy",
      version: "reviewed-1",
      rules: [
        { concern: "dehydration", ingredient: "Glycerin", relevance: 3 },
        { concern: "dehydration", ingredient: "Panthenol", relevance: 3 },
        {
          concern: "fine_lines",
          ingredient: "Palmitoyl Tripeptide-1",
          relevance: 3,
        },
      ],
    });
    const sourceCodes = {
      sensitivity: ["NS", "S"],
      pigmentation: ["P0", "P1", "P2"],
      wrinkles: ["W0", "W1", "W2"],
      acne: ["NA", "A"],
      pores: ["NVP", "VP"],
      sagging: ["NSA", "SA"],
      keratin: ["ND", "D"],
      redness: ["NR", "R"],
    };
    const analyze = vi.fn(
      async (
        request_id: string,
        _answers: Answers,
        image?: Uint8Array,
      ): Promise<ExperimentalAnalysis> => {
        const firstPhoto = image?.[0] === 1;
        return {
          request_id,
          mode: "experimental",
          model_version: "synthetic-provider:source-codes-v1",
          quality_status: "experimental",
          observations: [],
          disclaimer: "Experimental source codes; meanings are unverified.",
          visual: {
            model_version: "synthetic-photo-model",
            heads: Object.entries(sourceCodes).map(([key, values]) => {
              const predicted = key === "pores" && !firstPhoto ? 1 : 0;
              return {
                key,
                label: key,
                predicted_code: values[predicted],
                probabilities: values.map((code, index) => ({
                  code,
                  probability:
                    index === predicted ? 0.8 : 0.2 / (values.length - 1),
                })),
              };
            }),
          },
          ingredients: {
            model_version: "synthetic-ingredient-model",
            candidates: [
              { ingredient: "Glycerin", score: firstPhoto ? 0.9 : 0.1 },
              { ingredient: "Panthenol", score: firstPhoto ? 0.1 : 0.9 },
              { ingredient: "Betaine", score: 1 },
              { ingredient: "Palmitoyl Tripeptide-1", score: 1 },
            ],
            input_coverage: [
              "visual_condition_used_source_contract_v1",
              "visual_condition_exact_training_category",
              "source_code_contract_aihub71886_v1",
              "source_code_meanings_unverified",
              "combined_pipeline_not_validated",
            ],
          },
        };
      },
    );
    const app = new Consultations(repository, { analyze });
    const sameAnswers: Answers = {
      ...preferences,
      concerns: ["dehydration"],
      excludedIngredients: ["Vitamin B3"],
    };
    const results = [];
    for (const input of [1, 2]) {
      const session = await app.start(device);
      await app.consent(session.id, device, true, "2026-10-experimental-v1");
      await app.answers(session.id, device, sameAnswers);
      const result = await app.analyze(
        session.id,
        device,
        new Uint8Array([input]),
        "2026-10-experimental-v1",
      );
      results.push(result);
      expect(result.answers).toEqual(sameAnswers);
      expect(result.analysis?.observations).toEqual([]);
      expect(result.recommendations).toHaveLength(2);
      expect(
        result.recommendations?.flatMap(({ reasons }) =>
          reasons.map(({ concern }) => concern),
        ),
      ).toEqual(["dehydration", "dehydration"]);
      await app.finish(session.id, device);
    }
    expect(
      results[0].recommendations?.map(({ product }) => product.id),
    ).toEqual(["GLYCERIN", "PANTHENOL"]);
    expect(
      results[1].recommendations?.map(({ product }) => product.id),
    ).toEqual(["PANTHENOL", "GLYCERIN"]);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(analyze.mock.calls.map(([, answers]) => answers)).toEqual([
      sameAnswers,
      sameAnswers,
    ]);
    expect(analyze.mock.calls.map(([, , image]) => [...image!])).toEqual([
      [1],
      [2],
    ]);
  });

  it("requires consent before saving preferences and analysis", async () => {
    const { repository, device, app } = setup();
    const session = await app.start(device);
    await expect(
      app.answers(session.id, device, preferences),
    ).rejects.toMatchObject({ code: "consent_required" });
    await expect(app.analyze(session.id, device)).rejects.toMatchObject({
      code: "answers_required",
    });
    expect(await repository.metrics(DEMO_STORE_ID)).toEqual({
      started: 1,
      completed: 0,
      analyzed: 0,
    });
  });

  it("declining consent immediately removes the transient session", async () => {
    const { repository, device, app } = setup();
    const session = await app.start(device);
    await app.consent(session.id, device, false);
    await expect(repository.session(session.id, device)).rejects.toMatchObject({
      code: "session_not_found",
    });
    expect(await repository.metrics(DEMO_STORE_ID)).toMatchObject({
      analyzed: 0,
      completed: 0,
    });
  });

  it("starts one active session per device and keeps start metrics idempotent", async () => {
    const { repository, device, app } = setup();
    const first = await app.start(device);
    const second = await app.start(device);
    expect(second.id).toBe(first.id);
    expect((await repository.metrics(DEMO_STORE_ID)).started).toBe(1);
  });

  it("produces visibly mock observations and only eligible own-store ingredient matches", async () => {
    const { device, app } = setup();
    const session = await app.start(device);
    await app.consent(session.id, device, true);
    await app.answers(session.id, device, preferences);
    const result = await app.analyze(session.id, device);
    expect(result.analysis).toMatchObject({
      mode: "mock",
      quality_status: "demo",
    });
    expect(result.analysis?.disclaimer).toContain("not analyzed");
    expect(result.recommendations?.length).toBeGreaterThan(0);
    expect(result.recommendations?.length).toBeLessThanOrEqual(3);
    for (const { product, reasons } of result.recommendations ?? []) {
      expect(product.storeId).toBe(device.storeId);
      expect(product.organizationId).toBe(device.organizationId);
      expect(product.status).toBe("published");
      expect(product.stock).toBeGreaterThan(0);
      expect(reasons.length).toBeGreaterThan(0);
    }
  });

  it("retries analysis without rerunning the provider or duplicating metrics", async () => {
    const { repository, device, analyzer, app } = setup();
    const analyze = vi.spyOn(analyzer, "analyze");
    const session = await app.start(device);
    await app.consent(session.id, device, true);
    await app.answers(session.id, device, preferences);
    const first = await app.analyze(session.id, device);
    const second = await app.analyze(session.id, device);
    expect(second.analysis).toEqual(first.analysis);
    expect(second.recommendations).toEqual(first.recommendations);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect((await repository.metrics(DEMO_STORE_ID)).analyzed).toBe(1);
  });

  it("locks questionnaire changes after analysis", async () => {
    const { device, app } = setup();
    const session = await app.start(device);
    await app.consent(session.id, device, true);
    await app.answers(session.id, device, preferences);
    await app.analyze(session.id, device);
    await expect(
      app.answers(session.id, device, { ...preferences, skinType: "oily" }),
    ).rejects.toMatchObject({ code: "already_analyzed" });
  });

  it("applies excluded ingredients before recommending store inventory", async () => {
    const { device, app } = setup();
    const session = await app.start(device);
    await app.consent(session.id, device, true);
    await app.answers(session.id, device, {
      ...preferences,
      excludedIngredients: ["Vitamin B3"],
    });
    const result = await app.analyze(session.id, device);
    expect(result.recommendations?.length).toBeGreaterThan(0);
    expect(
      result.recommendations?.every(
        ({ product }) => !product.ingredients.includes("Niacinamide"),
      ),
    ).toBe(true);
  });

  it("finish removes all customer state and is idempotent", async () => {
    const { repository, device, app } = setup();
    const session = await app.start(device);
    await app.consent(session.id, device, true);
    await app.answers(session.id, device, preferences);
    await app.analyze(session.id, device);
    await app.finish(session.id, device);
    await app.finish(session.id, device);
    await expect(repository.session(session.id, device)).rejects.toMatchObject({
      code: "session_not_found",
    });
    expect(await repository.metrics(DEMO_STORE_ID)).toEqual({
      started: 1,
      completed: 1,
      analyzed: 1,
    });
    const next = await app.start(device);
    expect(next.id).not.toBe(session.id);
    expect(next).toMatchObject({
      consent: false,
      answers: null,
      analysis: null,
      recommendations: null,
    });
  });

  it("cancelling after preferences clears the session without counting a completion", async () => {
    const { repository, device, app } = setup();
    const session = await app.start(device);
    await app.consent(session.id, device, true);
    await app.answers(session.id, device, preferences);
    await app.finish(session.id, device);
    await app.finish(session.id, device);
    await expect(repository.session(session.id, device)).rejects.toMatchObject({
      code: "session_not_found",
    });
    expect(await repository.metrics(DEMO_STORE_ID)).toEqual({
      started: 1,
      completed: 0,
      analyzed: 0,
    });
  });

  it("expiry follows the last meaningful activity and rejects exactly at 15 minutes idle", async () => {
    const { repository, device, app, advance } = setup();
    const session = await app.start(device);
    advance(14 * 60_000);
    await app.consent(session.id, device, true);
    advance(14 * 60_000);
    await expect(repository.session(session.id, device)).resolves.toMatchObject(
      { consent: true },
    );
    advance(60_000);
    await expect(repository.session(session.id, device)).rejects.toMatchObject({
      code: "session_not_found",
    });
  });

  it("rejects cross-device, cross-store and fabricated tenant contexts", async () => {
    const { repository, device, app } = setup();
    const session = await app.start(device);
    const otherDevice = repository.ensureDevice("other-device");
    await expect(
      repository.session(session.id, otherDevice),
    ).rejects.toMatchObject({ code: "session_not_found" });
    await expect(
      app.start({ ...device, organizationId: "fabricated-tenant" }),
    ).rejects.toMatchObject({ code: "device_not_found" });
    await expect(
      app.start({ ...device, storeId: "22222222-2222-4222-8222-222222222223" }),
    ).rejects.toMatchObject({ code: "device_not_found" });
  });

  it("device revocation purges its session and blocks subsequent use", async () => {
    const { repository, device, app } = setup();
    const session = await app.start(device);
    await app.consent(session.id, device, true);
    await app.answers(session.id, device, preferences);
    await repository.revokeDevice(device.deviceId);
    await expect(app.start(device)).rejects.toMatchObject({
      code: "device_revoked",
    });
    await expect(repository.session(session.id, device)).rejects.toMatchObject({
      code: "device_revoked",
    });
  });

  it("does not write a late provider response after the customer finishes", async () => {
    const { repository, device } = setup();
    let resolve!: (result: Analysis) => void;
    const analyze = vi.fn(
      () =>
        new Promise<Analysis>((done) => {
          resolve = done;
        }),
    );
    const app = new Consultations(repository, { analyze });
    const session = await app.start(device);
    await app.consent(session.id, device, true);
    await app.answers(session.id, device, preferences);
    const pending = app.analyze(session.id, device);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "session_not_found",
    });
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    await app.finish(session.id, device);
    resolve(await new LocalMockAnalysis().analyze(session.id, preferences));
    await rejected;
    expect((await repository.metrics(DEMO_STORE_ID)).analyzed).toBe(0);
  });

  it("pairing codes are single use and expire exactly at their deadline", async () => {
    const { repository, advance } = setup();
    const first = await repository.pairingCode(DEMO_STORE_ID, "Paired tablet");
    expect(repository.pair(first.code, "new-device").storeId).toBe(
      DEMO_STORE_ID,
    );
    expect(() => repository.pair(first.code, "replay-device")).toThrow(
      "invalid or expired",
    );
    const expired = await repository.pairingCode(DEMO_STORE_ID, "Late tablet");
    advance(10 * 60_000);
    expect(() => repository.pair(expired.code, "late-device")).toThrow(
      "invalid or expired",
    );
  });
});
