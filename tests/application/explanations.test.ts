import { describe, expect, it, vi } from "vitest";
import { Consultations } from "@/application/consultations";
import type { ExplanationInput } from "@/application/explanation-contracts";
import { EXPLANATION_NOTICE_VERSION } from "@/domain/explanations";
import { DemoRepository } from "@/infrastructure/demo-repository";
import { LocalMockAnalysis } from "@/infrastructure/analysis";
import type {
  AnalysisProvider,
  ExperimentalAnalysis,
} from "@/application/contracts";

function plan(input: ExplanationInput) {
  return {
    products: input.products.map((p) => ({
      productRef: p.productRef,
      reasonRefs: [p.facts[0].reasonRef],
      wording: "goal_first" as const,
    })),
  };
}
async function setup(
  accepted: boolean | null = true,
  analyzer: AnalysisProvider = new LocalMockAnalysis(),
) {
  const repo = new DemoRepository(false);
  const device = repo.ensureDevice("explanation-test");
  const explain = vi.fn(async (input: ExplanationInput) => plan(input));
  const app = new Consultations(repo, analyzer, {
    explain,
    modelVersion: "gpt-4.1-mini-2025-04-14",
  });
  const session = await app.start(device);
  await app.consent(session.id, device, true);
  if (accepted !== null)
    await repo.explanationConsent(
      session.id,
      device,
      accepted,
      EXPLANATION_NOTICE_VERSION,
    );
  await app.answers(session.id, device, {
    skinType: "dry",
    concerns: ["dehydration", "texture"],
    sensitive: false,
    excludedIngredients: [],
  });
  const analyzed = await app.analyze(session.id, device);
  return { repo, device, explain, app, session: analyzed };
}

function experimental(
  request_id: string,
  coverage: string[],
  photo = true,
): ExperimentalAnalysis {
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
  return {
    request_id,
    mode: "experimental",
    model_version: "synthetic-experimental-v1",
    quality_status: "experimental",
    observations: [],
    disclaimer: "Experimental; source-code meanings are unverified.",
    visual: photo
      ? {
          model_version: "synthetic-visual-v1",
          heads: Object.entries(codes).map(([key, values]) => ({
            key,
            label: key,
            predicted_code: values[0],
            probabilities: values.map((code, index) => ({
              code,
              probability: index === 0 ? 0.8 : 0.2 / (values.length - 1),
            })),
          })),
        }
      : null,
    ingredients: {
      model_version: "synthetic-ingredients-v1",
      candidates: [{ ingredient: "Glycerin", score: 0.7 }],
      input_coverage: coverage,
    },
  };
}
describe("optional hosted explanation application boundary", () => {
  it.each([false, null])(
    "does not call a provider without explicit current opt-in (%s)",
    async (accepted) => {
      const { app, session, device, explain, repo } = await setup(accepted);
      const claim = vi.spyOn(repo, "claimExplanation");
      await expect(app.explain(session.id, device)).rejects.toMatchObject({
        code: "explanation_consent_required",
      });
      expect(explain).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
    },
  );
  it("sends only opaque matching facts, keeps rankings and persists one reusable explanation", async () => {
    const { app, session, device, explain } = await setup();
    const result = await app.explain(session.id, device);
    expect(result.explanation?.status).toBe("generated");
    expect(result.explanation?.summary).toContain(
      "This is a demonstration; your photo was not analyzed.",
    );
    expect(result.recommendations).toEqual(session.recommendations);
    expect(result.explanation?.products.map((p) => p.productId)).toEqual(
      session.recommendations!.map((r) => r.product.id),
    );
    const payload = JSON.stringify(explain.mock.calls[0][0]);
    for (const forbidden of [
      session.id,
      device.deviceId,
      device.organizationId,
      device.storeId,
      "skinType",
      "sensitive",
      "probabilities",
      "visual",
      "image",
      "score",
    ])
      expect(payload).not.toContain(forbidden);
    for (const rec of session.recommendations!) {
      expect(payload).not.toContain(rec.product.id);
      expect(payload).not.toContain(rec.product.name);
    }
    expect((await app.explain(session.id, device)).explanation).toEqual(
      result.explanation,
    );
    expect(explain).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "verified photo contribution",
      coverage: [
        "visual_condition_used_source_contract_v1",
        "source_code_contract_aihub71886_v1",
        "visual_condition_exact_training_category",
      ],
      summary:
        "Your photo's experimental outputs contributed to ingredient ranking.",
    },
    {
      label: "unseen photo combination",
      coverage: [
        "visual_condition_unseen_in_training_omitted",
        "visual_codes_not_used_for_ingredients",
      ],
      summary: "Photo outputs were omitted from ingredient ranking",
    },
    {
      label: "unavailable support contract",
      coverage: ["visual_condition_support_unavailable_omitted"],
      summary: "its outputs were not used for ingredient ranking",
    },
    {
      label: "missing contribution witnesses",
      coverage: ["visual_condition_used_source_contract_v1"],
      summary: "its outputs were not used for ingredient ranking",
    },
    {
      label: "contradictory contribution flag",
      coverage: [
        "visual_condition_used_source_contract_v1",
        "source_code_contract_aihub71886_v1",
        "visual_condition_exact_training_category",
        "visual_codes_not_used_for_ingredients",
      ],
      summary: "its outputs were not used for ingredient ranking",
    },
    {
      label: "questionnaire-only flow",
      coverage: ["no_photo_questionnaire_only"],
      summary: "No photo was analyzed.",
      photo: false,
    },
  ])(
    "explains $label locally while keeping the hosted request anonymous and unchanged",
    async ({ coverage, summary, photo }) => {
      const { app, session, device, explain } = await setup(true, {
        analyze: async (id) => experimental(id, coverage, photo ?? true),
      });
      const result = await app.explain(session.id, device);
      expect(result.explanation?.status).toBe("generated");
      expect(result.explanation?.summary).toContain(summary);
      expect(result.recommendations).toEqual(session.recommendations);
      const outbound = explain.mock.calls[0][0];
      expect(Object.keys(outbound)).toEqual(["products"]);
      const serialized = JSON.stringify(outbound);
      for (const privateDetail of [
        ...coverage,
        "input_coverage",
        "analysisBasis",
        "experimental",
        "synthetic",
        "probabilities",
        "predicted_code",
        "visual",
        "photo",
      ])
        expect(serialized).not.toContain(privateDetail);
      expect((await app.explain(session.id, device)).explanation).toEqual(
        result.explanation,
      );
      expect(explain).toHaveBeenCalledTimes(1);
    },
  );

  it("retains actual local photo provenance if the hosted explanation is unavailable", async () => {
    const { app, session, device, explain } = await setup(true, {
      analyze: async (id) =>
        experimental(id, [
          "visual_condition_used_source_contract_v1",
          "source_code_contract_aihub71886_v1",
          "visual_condition_exact_training_category",
        ]),
    });
    explain.mockRejectedValue(new Error("provider unavailable"));
    const result = await app.explain(session.id, device);
    expect(result.explanation?.status).toBe("fallback");
    expect(result.explanation?.summary).toContain(
      "contributed to ingredient ranking",
    );
  });
  it("claims durably before calling the provider so a concurrent request cannot duplicate cost", async () => {
    const { app, session, device, explain } = await setup();
    let release!: () => void;
    const waiting = new Promise<void>((r) => {
      release = r;
    });
    explain.mockImplementation(async (input) => {
      await waiting;
      return plan(input);
    });
    const first = app.explain(session.id, device);
    await vi.waitFor(() => expect(explain).toHaveBeenCalledTimes(1));
    await app.explain(session.id, device);
    expect(explain).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
  it("retains local explanations on provider failure or removed configuration", async () => {
    const { app, repo, session, device, explain } = await setup();
    explain.mockRejectedValue(new Error("private upstream body"));
    const result = await app.explain(session.id, device);
    expect(result.explanation?.status).toBe("fallback");
    expect(result.explanation?.modelVersion).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private upstream");
    const second = await setup();
    const disabled = new Consultations(second.repo, new LocalMockAnalysis());
    expect(
      (await disabled.explain(second.session.id, second.device)).explanation
        ?.status,
    ).toBe("fallback");
    expect((await repo.session(session.id, device)).recommendations).toEqual(
      session.recommendations,
    );
  });
  it("validates a provider plan independently of the adapter", async () => {
    const { app, session, device, explain } = await setup();
    explain.mockResolvedValue({
      products: [
        {
          productRef: "unregistered",
          reasonRefs: ["fake"],
          wording: "goal_first",
        },
      ],
    });
    expect((await app.explain(session.id, device)).explanation?.status).toBe(
      "fallback",
    );
  });
  it("cannot restore output after finish during an external request", async () => {
    const { app, session, device, explain, repo } = await setup();
    explain.mockImplementation(async (input) => {
      await app.finish(session.id, device);
      return plan(input);
    });
    const save = vi.spyOn(repo, "saveExplanation");
    await expect(app.explain(session.id, device)).rejects.toMatchObject({
      status: 404,
    });
    expect(save).not.toHaveBeenCalled();
  });
  it("prevents a different device from receiving or generating explanations", async () => {
    const { app, session, device, explain } = await setup();
    await expect(
      app.explain(session.id, { ...device, deviceId: "other-device" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(explain).not.toHaveBeenCalled();
  });
});
