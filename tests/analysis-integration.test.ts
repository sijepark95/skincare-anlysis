import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError, type Answers } from "@/application/contracts";
import { Consultations } from "@/application/consultations";
import { HttpAnalysis, LocalMockAnalysis } from "@/infrastructure/analysis";
import { DemoRepository } from "@/infrastructure/demo-repository";

const id = "44444444-4444-4444-8444-444444444444";
const answers: Answers = {
  skinType: "dry",
  concerns: ["dehydration", "texture"],
  excludedIngredients: [],
  sensitive: true,
};
const validResponse = {
  request_id: id,
  mode: "mock",
  model_version: "mock-1.0",
  quality_status: "demo",
  disclaimer: "Mock questionnaire result; no photo analysis.",
  observations: [
    { concern_id: "dehydration", level: "high", score: 0.78 },
    { concern_id: "texture", level: "moderate", score: 0.48 },
  ],
};
afterEach(() => vi.unstubAllGlobals());

describe("private analysis HTTP contract", () => {
  it("sends only bounded preferences, with no photo or tenant identity", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(validResponse));
    vi.stubGlobal("fetch", fetch);
    expect(
      await new HttpAnalysis(
        "http://127.0.0.1:8000/",
        "server-only-test-secret",
      ).analyze(id, answers),
    ).toEqual(validResponse);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8000/v1/analyze");
    expect(JSON.parse(options.body)).toEqual({
      request_id: id,
      concern_ids: answers.concerns,
      skin_type: "dry",
      sensitive: true,
    });
    expect(options).toMatchObject({
      cache: "no-store",
      redirect: "error",
      headers: { "X-Analysis-Key": "server-only-test-secret" },
    });
  });

  it.each([
    { ...validResponse, request_id: "99999999-9999-4999-8999-999999999999" },
    { ...validResponse, mode: "model" },
    { ...validResponse, quality_status: "accepted" },
    { ...validResponse, observations: [] },
    { ...validResponse, observations: [validResponse.observations[0]] },
    {
      ...validResponse,
      observations: [
        validResponse.observations[0],
        validResponse.observations[0],
      ],
    },
    {
      ...validResponse,
      observations: [
        { concern_id: "fine_lines", level: "high", score: 0.7 },
        validResponse.observations[0],
      ],
    },
    {
      ...validResponse,
      observations: [
        { concern_id: "dehydration", level: "high", score: 87 },
        validResponse.observations[1],
      ],
    },
  ])(
    "rejects mismatched, real-model, incomplete or malformed upstream results",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
      await expect(
        new HttpAnalysis("http://localhost:8000", "secret").analyze(
          id,
          answers,
        ),
      ).rejects.toMatchObject({ status: 503, code: "analysis_unavailable" });
    },
  );

  it("bounds upstream response size before JSON parsing", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ ...validResponse, unexpected: "x".repeat(17000) }),
        ),
    );
    await expect(
      new HttpAnalysis("http://localhost:8000", "secret").analyze(id, answers),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("returns a generic error without raw service detail or secrets", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("PRIVATE CUSTOMER CONTENT", { status: 500 }),
        ),
    );
    await expect(
      new HttpAnalysis("http://localhost:8000", "SECRET-KEY").analyze(
        id,
        answers,
      ),
    ).rejects.toMatchObject({
      code: "analysis_unavailable",
      message:
        "The analysis service is unavailable. Your preferences are safe to retry during this session.",
    });
  });
});

describe("retry after partial consultation success", () => {
  it("replays identical answers and finishes recommendations without rerunning analysis", async () => {
    const repository = new DemoRepository(false);
    const device = repository.ensureDevice("retry-test-device");
    const analyzer = new LocalMockAnalysis();
    const analyzed = vi.spyOn(analyzer, "analyze");
    const saveRecommendations = vi
      .spyOn(repository, "saveRecommendations")
      .mockRejectedValueOnce(
        new AppError(409, "stock_changed", "Stock changed."),
      );
    const application = new Consultations(repository, analyzer);
    const session = await application.start(device);
    await application.consent(session.id, device, true);
    await application.answers(session.id, device, answers);
    await expect(application.analyze(session.id, device)).rejects.toMatchObject(
      { status: 409 },
    );
    expect(
      (await repository.session(session.id, device)).analysis,
    ).not.toBeNull();
    await expect(
      application.answers(session.id, device, {
        ...answers,
        concerns: ["texture", "dehydration"],
      }),
    ).resolves.toBeUndefined();
    const result = await application.analyze(session.id, device);
    expect(result.recommendations?.length).toBeGreaterThan(0);
    expect(analyzed).toHaveBeenCalledOnce();
    expect(saveRecommendations).toHaveBeenCalledTimes(2);
    await expect(
      application.answers(session.id, device, { ...answers, sensitive: false }),
    ).rejects.toMatchObject({ code: "already_analyzed" });
  });
});
