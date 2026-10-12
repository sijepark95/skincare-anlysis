import { afterEach, describe, expect, it, vi } from "vitest";
import type { Answers, ExperimentalAnalysis } from "@/application/contracts";
import { HttpAnalysis } from "@/infrastructure/analysis";
import { readEphemeralImage } from "@/interfaces/http/validation";

const id = "44444444-4444-4444-8444-444444444444";
const answers: Answers = {
  skinType: "dry",
  concerns: ["dehydration"],
  sensitive: false,
  excludedIngredients: [],
};
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
function result(photo = true): ExperimentalAnalysis {
  return {
    request_id: id,
    mode: "experimental",
    model_version: "local-models-v1:source-codes-v1",
    quality_status: "experimental",
    observations: [],
    disclaimer: "Experimental; not a diagnosis.",
    visual: photo
      ? {
          model_version: "skin-all-head-001-best-4",
          heads: Object.entries(codes).map(([key, values]) => ({
            key,
            label: key,
            predicted_code: values[0],
            probabilities: values.map((code, i) => ({
              code,
              probability: i === 0 ? 0.8 : 0.2 / (values.length - 1),
            })),
          })),
        }
      : null,
    ingredients: {
      model_version: "ingredients-linear-001-best-16",
      candidates: [{ ingredient: "Glycerin", score: 0.7 }],
      input_coverage: photo
        ? [
            "visual_condition_used_source_contract_v1",
            "visual_condition_exact_training_category",
            "source_code_contract_aihub71886_v1",
            "source_code_meanings_unverified",
            "combined_pipeline_not_validated",
          ]
        : [
            "no_photo_questionnaire_only",
            "initial_skin_condition_omitted",
            "visual_codes_not_used_for_ingredients",
          ],
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("experimental private model adapter", () => {
  it("sends photo bytes only through the explicit private model contract", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(result()));
    vi.stubGlobal("fetch", fetch);
    const image = new Uint8Array([1, 2, 3]);
    expect(
      (
        await new HttpAnalysis(
          "http://127.0.0.1:8000",
          "private-test-key",
          "experimental",
        ).analyze(id, answers, image)
      ).mode,
    ).toBe("experimental");
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8000/v1/analyze/experimental");
    expect(JSON.parse(options.body)).toEqual({
      request_id: id,
      concern_ids: ["dehydration"],
      skin_type: "dry",
      sensitive: false,
      image_base64: "AQID",
    });
    expect(options).toMatchObject({
      cache: "no-store",
      redirect: "error",
      headers: { "X-Analysis-Key": "private-test-key" },
    });
  });
  it("supports questionnaire-only recommendations without claiming photo analysis", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(result(false)));
    vi.stubGlobal("fetch", fetch);
    const response = await new HttpAnalysis(
      "http://127.0.0.1:8000",
      "key",
      "experimental",
    ).analyze(id, answers);
    expect(response).toEqual(result(false));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty(
      "image_base64",
    );
  });
  it.each(["used", "unseen"])(
    "preserves explicit %s photo-feature provenance from the private provider",
    async (coverage) => {
      const upstream = result();
      if (coverage === "unseen")
        upstream.ingredients.input_coverage = [
          "source_code_contract_aihub71886_v1",
          "source_code_meanings_unverified",
          "combined_pipeline_not_validated",
          "visual_condition_unseen_in_training_omitted",
          "visual_codes_not_used_for_ingredients",
          "initial_skin_condition_omitted",
        ];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(Response.json(upstream)),
      );
      const response = await new HttpAnalysis(
        "http://127.0.0.1:8000",
        "key",
        "experimental",
      ).analyze(id, answers, new Uint8Array([1]));
      expect(response).toEqual(upstream);
      if (response.mode !== "experimental") throw new Error("Expected model");
      expect(response.ingredients.input_coverage).toEqual(
        upstream.ingredients.input_coverage,
      );
      expect(response.observations).toEqual([]);
      expect(
        response.visual?.heads.map(({ predicted_code }) => predicted_code),
      ).toEqual(
        upstream.visual?.heads.map(({ predicted_code }) => predicted_code),
      );
    },
  );
  it.each([
    "request",
    "duplicate_heads",
    "invalid_code",
    "bad_sum",
    "wrong_prediction",
    "duplicate_ingredients",
    "mock",
    "missing_visual",
    "coverage_without_visual",
    "contradictory_coverage",
    "duplicate_coverage",
    "missing_code_contract",
    "missing_training_category",
  ])("rejects invalid upstream %s", async (fault) => {
    const value: unknown = result(fault !== "coverage_without_visual");
    const body = value as ExperimentalAnalysis;
    if (fault === "request")
      body.request_id = "99999999-9999-4999-8999-999999999999";
    if (fault === "duplicate_heads")
      body.visual!.heads[1] = body.visual!.heads[0];
    if (fault === "invalid_code")
      body.visual!.heads[0].probabilities[0].code = "healthy";
    if (fault === "bad_sum")
      body.visual!.heads[0].probabilities[0].probability = 0.5;
    if (fault === "wrong_prediction")
      body.visual!.heads[0].predicted_code = "S";
    if (fault === "duplicate_ingredients")
      body.ingredients.candidates.push({ ...body.ingredients.candidates[0] });
    if (fault === "mock") Object.assign(body, { mode: "mock" });
    if (fault === "missing_visual") body.visual = null;
    if (fault === "coverage_without_visual")
      body.ingredients.input_coverage = [
        "visual_condition_used_source_contract_v1",
        "source_code_contract_aihub71886_v1",
        "visual_condition_exact_training_category",
      ];
    if (fault === "contradictory_coverage")
      body.ingredients.input_coverage.push("initial_skin_condition_omitted");
    if (fault === "duplicate_coverage")
      body.ingredients.input_coverage.push(body.ingredients.input_coverage[0]);
    if (fault === "missing_code_contract")
      body.ingredients.input_coverage = body.ingredients.input_coverage.filter(
        (feature) => feature !== "source_code_contract_aihub71886_v1",
      );
    if (fault === "missing_training_category")
      body.ingredients.input_coverage = body.ingredients.input_coverage.filter(
        (feature) => feature !== "visual_condition_exact_training_category",
      );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    await expect(
      new HttpAnalysis("http://127.0.0.1:8000", "key", "experimental").analyze(
        id,
        answers,
        fault === "coverage_without_visual" ? undefined : new Uint8Array([1]),
      ),
    ).rejects.toMatchObject({ code: "analysis_unavailable" });
  });
  it("rejects photos in mock mode before making a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      new HttpAnalysis("http://127.0.0.1:8000", "key").analyze(
        id,
        answers,
        new Uint8Array([1]),
      ),
    ).rejects.toMatchObject({ code: "analysis_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("provides a safe retry instruction for an unreadable image without echoing upstream content", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("private-image-details", { status: 422 }),
        ),
    );
    await expect(
      new HttpAnalysis("http://127.0.0.1:8000", "key", "experimental").analyze(
        id,
        answers,
        new Uint8Array([1]),
      ),
    ).rejects.toMatchObject({ status: 422, code: "photo_not_supported" });
  });
});

describe("ephemeral photo upload boundary", () => {
  function request(body: BodyInit, headers: Record<string, string> = {}) {
    return new Request("http://localhost/analysis", {
      method: "POST",
      headers: { "Content-Type": "image/png", ...headers },
      body,
    });
  }
  it("reads only static image bytes into memory", async () => {
    expect(
      await readEphemeralImage(request(new Blob([new Uint8Array([1, 2, 3])]))),
    ).toEqual(new Uint8Array([1, 2, 3]));
  });
  it.each(["image/gif", "application/json", "multipart/form-data"])(
    "rejects %s",
    async (type) => {
      await expect(
        readEphemeralImage(request("x", { "Content-Type": type })),
      ).rejects.toMatchObject({ status: 415 });
    },
  );
  it("rejects declared oversized bodies before decoding", async () => {
    await expect(
      readEphemeralImage(request("x", { "Content-Length": "10485761" })),
    ).rejects.toMatchObject({ status: 413 });
  });
  it("also bounds bodies with no declared size", async () => {
    await expect(
      readEphemeralImage(request(new Blob([new Uint8Array(10485761)]))),
    ).rejects.toMatchObject({ status: 413 });
  });
  it("rejects empty and incomplete uploads", async () => {
    await expect(readEphemeralImage(request(""))).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      readEphemeralImage(request("x", { "Content-Length": "2" })),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("times out stalled uploads and cancels the reader", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream(
      { pull: () => new Promise(() => {}), cancel },
      { highWaterMark: 0 },
    );
    const req = new Request("http://localhost/analysis", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const pending = expect(readEphemeralImage(req)).rejects.toMatchObject({
      status: 408,
    });
    await vi.advanceTimersByTimeAsync(10001);
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
  });
});
