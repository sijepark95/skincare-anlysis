import { describe, expect, it } from "vitest";
import { DemoRepository } from "../../src/infrastructure/demo-repository";
import type { OpenAIAnalysis } from "../../src/application/contracts";
import {
  OPENAI_CONSENT_VERSION,
  OPENAI_SKIN_DISCLAIMER,
  OPENAI_SKIN_MODEL,
  OPENAI_SKIN_PROMPT_VERSION,
  VISION_NOTICE_VERSION,
} from "../../src/domain/skin-vision";

async function setup() {
  let now = Date.parse("2026-10-11T12:00:00Z");
  const repo = new DemoRepository(false, () => now);
  const device = repo.ensureDevice("vision-device");
  const { id } = await repo.start(device);
  await repo.consent(id, device, true, OPENAI_CONSENT_VERSION);
  await repo.answers(id, device, {
    skinType: "dry",
    concerns: ["dehydration"],
    sensitive: false,
    excludedIngredients: [],
  });
  const analysis: OpenAIAnalysis = {
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
        visible_redness: "visible",
        visible_spots: "uncertain",
        visible_pores: "not_visible",
        visible_fine_lines: "not_visible",
        visible_flaking: "not_visible",
      },
    },
  };
  return {
    repo,
    device,
    id,
    analysis,
    advance: () => {
      now += 15 * 60_000;
    },
  };
}

describe("separate photo consent and durable attempt semantics", () => {
  it("requires current main and separate external consent before claiming", async () => {
    const f = await setup();
    await expect(
      f.repo.claimVisionAnalysis(f.id, f.device),
    ).rejects.toMatchObject({ code: "vision_consent_required" });
    await f.repo.visionConsent(f.id, f.device, false, VISION_NOTICE_VERSION);
    await expect(
      f.repo.claimVisionAnalysis(f.id, f.device),
    ).rejects.toMatchObject({ code: "vision_consent_required" });
    await expect(
      f.repo.visionConsent(f.id, f.device, true, "old"),
    ).rejects.toMatchObject({ code: "invalid_consent_version" });
    await f.repo.visionConsent(f.id, f.device, true, VISION_NOTICE_VERSION);
    await expect(f.repo.claimVisionAnalysis(f.id, f.device)).resolves.toBe(
      true,
    );
    await expect(f.repo.claimVisionAnalysis(f.id, f.device)).resolves.toBe(
      false,
    );
  });
  it("permits exactly one concurrent claim and immutable normalized-shaped output", async () => {
    const f = await setup();
    await f.repo.visionConsent(f.id, f.device, true, VISION_NOTICE_VERSION);
    expect(
      await Promise.all([
        f.repo.claimVisionAnalysis(f.id, f.device),
        f.repo.claimVisionAnalysis(f.id, f.device),
      ]),
    ).toEqual([true, false]);
    await f.repo.saveAnalysis(f.id, f.device, f.analysis);
    const saved = await f.repo.session(f.id, f.device);
    expect(saved.analysis).toEqual(f.analysis);
    expect(saved.visionConsent).toEqual({
      accepted: true,
      noticeVersion: VISION_NOTICE_VERSION,
    });
    const changed = structuredClone(f.analysis);
    changed.vision!.observed_features.visible_redness = "uncertain";
    await f.repo.saveAnalysis(f.id, f.device, changed);
    expect((await f.repo.session(f.id, f.device)).analysis).toEqual(f.analysis);
  });
  it("blocks late results after withdrawal even when consent is reaccepted", async () => {
    const f = await setup();
    await f.repo.visionConsent(f.id, f.device, true, VISION_NOTICE_VERSION);
    await f.repo.claimVisionAnalysis(f.id, f.device);
    await f.repo.visionConsent(f.id, f.device, false, VISION_NOTICE_VERSION);
    await expect(
      f.repo.saveAnalysis(f.id, f.device, f.analysis),
    ).rejects.toMatchObject({ code: "vision_consent_required" });
    await f.repo.visionConsent(f.id, f.device, true, VISION_NOTICE_VERSION);
    await expect(f.repo.claimVisionAnalysis(f.id, f.device)).resolves.toBe(
      false,
    );
    await expect(
      f.repo.saveAnalysis(f.id, f.device, f.analysis),
    ).rejects.toMatchObject({ code: "vision_consent_required" });
  });
  it("photo-free continuation stores no vision and never claims external processing", async () => {
    const f = await setup();
    await f.repo.visionConsent(f.id, f.device, false, VISION_NOTICE_VERSION);
    const withoutPhoto = {
      ...f.analysis,
      quality_status: "not_provided" as const,
      vision: null,
    };
    await f.repo.saveAnalysis(f.id, f.device, withoutPhoto);
    expect((await f.repo.session(f.id, f.device)).analysis).toEqual(
      withoutPhoto,
    );
  });
  it("explicit photo-free completion after an attempted request prevents a late photo replacing it", async () => {
    const f = await setup();
    await f.repo.visionConsent(f.id, f.device, true, VISION_NOTICE_VERSION);
    await f.repo.claimVisionAnalysis(f.id, f.device);
    const withoutPhoto = {
      ...f.analysis,
      quality_status: "not_provided" as const,
      vision: null,
    };
    await f.repo.saveAnalysis(f.id, f.device, withoutPhoto);
    await f.repo.saveAnalysis(f.id, f.device, f.analysis);
    expect((await f.repo.session(f.id, f.device)).analysis).toEqual(
      withoutPhoto,
    );
  });
  it("refuses forged or unsupported photo observations", async () => {
    const f = await setup();
    await f.repo.visionConsent(f.id, f.device, true, VISION_NOTICE_VERSION);
    await expect(
      f.repo.saveAnalysis(f.id, f.device, f.analysis),
    ).rejects.toMatchObject({ code: "vision_consent_required" });
    await f.repo.claimVisionAnalysis(f.id, f.device);
    await expect(
      f.repo.saveAnalysis(f.id, f.device, {
        ...f.analysis,
        disclaimer: "invented",
      }),
    ).rejects.toMatchObject({ code: "invalid_analysis" });
    await expect(
      f.repo.saveAnalysis(f.id, f.device, {
        ...f.analysis,
        probabilities: [0.9],
      } as OpenAIAnalysis),
    ).rejects.toMatchObject({ code: "invalid_analysis" });
    await expect(
      f.repo.saveAnalysis(f.id, f.device, {
        ...f.analysis,
        request_id: "foreign",
      }),
    ).rejects.toMatchObject({ code: "invalid_analysis" });
  });
  it("finish, expiry and device revocation prevent late observations", async () => {
    for (const exit of ["finish", "expiry", "revoke"] as const) {
      const f = await setup();
      await f.repo.visionConsent(f.id, f.device, true, VISION_NOTICE_VERSION);
      await f.repo.claimVisionAnalysis(f.id, f.device);
      if (exit === "finish") await f.repo.finish(f.id, f.device);
      else if (exit === "expiry") f.advance();
      else await f.repo.revokeDevice(f.device.deviceId);
      await expect(
        f.repo.saveAnalysis(f.id, f.device, f.analysis),
      ).rejects.toBeInstanceOf(Error);
    }
  });
  it("completed photo results require finish and clear before changing external choice", async () => {
    const f = await setup();
    await f.repo.visionConsent(f.id, f.device, true, VISION_NOTICE_VERSION);
    await f.repo.claimVisionAnalysis(f.id, f.device);
    await f.repo.saveAnalysis(f.id, f.device, f.analysis);
    await expect(
      f.repo.visionConsent(f.id, f.device, false, VISION_NOTICE_VERSION),
    ).rejects.toMatchObject({ code: "vision_consent_locked" });
    await f.repo.finish(f.id, f.device);
    await expect(f.repo.session(f.id, f.device)).rejects.toMatchObject({
      code: "session_not_found",
    });
  });
});
