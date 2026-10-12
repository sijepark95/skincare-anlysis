import { describe, expect, it } from "vitest";
import { DemoRepository } from "../../src/infrastructure/demo-repository";
import { LocalMockAnalysis } from "../../src/infrastructure/analysis";
import { Consultations } from "../../src/application/consultations";
import {
  EXPLANATION_NOTICE_VERSION,
  EXPLANATION_PROMPT_VERSION,
  type RecommendationExplanation,
} from "../../src/application/explanation-contracts";

async function setup() {
  let now = Date.parse("2026-10-11T12:00:00Z");
  const repo = new DemoRepository(false, () => now);
  const device = repo.ensureDevice("explanation-device");
  const app = new Consultations(repo, new LocalMockAnalysis());
  const session = await app.start(device);
  await app.consent(session.id, device, true);
  await app.answers(session.id, device, {
    skinType: "dry",
    concerns: ["dehydration"],
    sensitive: false,
    excludedIngredients: [],
  });
  return {
    repo,
    device,
    app,
    id: session.id,
    advance: () => {
      now += 15 * 60_000;
    },
  };
}

async function final(fixture: Awaited<ReturnType<typeof setup>>) {
  await fixture.repo.explanationConsent(
    fixture.id,
    fixture.device,
    true,
    EXPLANATION_NOTICE_VERSION,
  );
  const session = await fixture.app.analyze(fixture.id, fixture.device);
  const result: RecommendationExplanation = {
    status: "generated",
    summary: "These products match the store's reviewed ingredient rules.",
    products: session.recommendations!.map(({ product }) => ({
      productId: product.id,
      text: "A reviewed ingredient match.",
    })),
    modelVersion: "synthetic-test",
    promptVersion: EXPLANATION_PROMPT_VERSION,
  };
  return result;
}

describe("transient explanation repository", () => {
  it("requires separate current consent and finalized recommendations", async () => {
    const f = await setup();
    await expect(f.repo.claimExplanation(f.id, f.device)).rejects.toMatchObject(
      { code: "explanation_consent_required" },
    );
    await f.repo.explanationConsent(
      f.id,
      f.device,
      false,
      EXPLANATION_NOTICE_VERSION,
    );
    await expect(f.repo.claimExplanation(f.id, f.device)).rejects.toMatchObject(
      { code: "explanation_consent_required" },
    );
    await f.repo.explanationConsent(
      f.id,
      f.device,
      true,
      EXPLANATION_NOTICE_VERSION,
    );
    await expect(f.repo.claimExplanation(f.id, f.device)).rejects.toMatchObject(
      { code: "recommendations_required" },
    );
    await expect(
      f.repo.explanationConsent(f.id, f.device, true, "old"),
    ).rejects.toMatchObject({ code: "invalid_consent_version" });
  });
  it("claims at most once even with concurrent calls and immutable completed text", async () => {
    const f = await setup();
    const result = await final(f);
    expect(
      await Promise.all([
        f.repo.claimExplanation(f.id, f.device),
        f.repo.claimExplanation(f.id, f.device),
      ]),
    ).toEqual([true, false]);
    await f.repo.saveExplanation(f.id, f.device, result);
    await f.repo.saveExplanation(f.id, f.device, {
      ...result,
      summary: "Replacement",
    });
    expect((await f.repo.session(f.id, f.device)).explanation).toEqual(result);
    expect(await f.repo.claimExplanation(f.id, f.device)).toBe(false);
  });
  it("locks optional consent after analysis while accepting identical retries", async () => {
    const f = await setup();
    await final(f);
    await expect(
      f.repo.explanationConsent(
        f.id,
        f.device,
        true,
        EXPLANATION_NOTICE_VERSION,
      ),
    ).resolves.toBeUndefined();
    await expect(
      f.repo.explanationConsent(
        f.id,
        f.device,
        false,
        EXPLANATION_NOTICE_VERSION,
      ),
    ).rejects.toMatchObject({ code: "explanation_consent_locked" });
  });
  it("requires a claim and exact product coverage and rank", async () => {
    const f = await setup();
    const result = await final(f);
    await expect(
      f.repo.saveExplanation(f.id, f.device, result),
    ).rejects.toMatchObject({ code: "explanation_consent_required" });
    await f.repo.claimExplanation(f.id, f.device);
    for (const invalid of [
      { ...result, products: [] },
      {
        ...result,
        products: result.products.map((p, index) =>
          index === 0 ? { ...p, productId: "unknown" } : p,
        ),
      },
      { ...result, summary: "a".repeat(601) },
      { ...result, status: "fallback" as const },
    ])
      await expect(
        f.repo.saveExplanation(f.id, f.device, invalid),
      ).rejects.toMatchObject({ code: "invalid_explanation" });
    await f.repo.saveExplanation(f.id, f.device, result);
  });
  it.each(["finish", "expiry", "revoke"] as const)(
    "%s purges claims and refuses late text",
    async (operation) => {
      const f = await setup();
      const result = await final(f);
      await f.repo.claimExplanation(f.id, f.device);
      if (operation === "finish") await f.repo.finish(f.id, f.device);
      if (operation === "expiry") f.advance();
      if (operation === "revoke") await f.repo.revokeDevice(f.device.deviceId);
      await expect(
        f.repo.saveExplanation(f.id, f.device, result),
      ).rejects.toMatchObject({
        code: operation === "revoke" ? "device_revoked" : "session_not_found",
      });
      if (operation !== "revoke") {
        const fresh = await f.repo.start(f.device);
        expect(fresh.explanationConsent).toBeUndefined();
        expect(fresh.explanation).toBeUndefined();
      }
    },
  );
  it("rejects another paired device and fabricated tenant", async () => {
    const f = await setup();
    await final(f);
    const other = f.repo.ensureDevice("other-explanation-device");
    await expect(f.repo.claimExplanation(f.id, other)).rejects.toMatchObject({
      code: "session_not_found",
    });
    await expect(
      f.repo.claimExplanation(f.id, { ...f.device, organizationId: "foreign" }),
    ).rejects.toMatchObject({ code: "device_not_found" });
  });
});
