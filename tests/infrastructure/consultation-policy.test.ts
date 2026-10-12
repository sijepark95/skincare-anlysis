import { describe, expect, it } from "vitest";
import { DemoRepository } from "../../src/infrastructure/demo-repository";
import type { Policy } from "../../src/application/contracts";

async function setup() {
  let now = Date.parse("2026-10-11T12:00:00Z");
  const repository = new DemoRepository(false, () => now);
  const device = repository.ensureDevice("consultation-policy-device");
  const { id } = await repository.start(device);
  await repository.consent(id, device, true);
  await repository.answers(id, device, {
    skinType: "dry",
    concerns: ["dehydration"],
    excludedIngredients: [],
    sensitive: false,
  });
  await repository.saveAnalysis(id, device, {
    request_id: id,
    mode: "mock",
    model_version: "mock-1.0",
    quality_status: "demo",
    observations: [],
    disclaimer: "Mock result.",
  });
  const policy: Policy = {
    id: "55555555-5555-4555-8555-555555555555",
    version: "frozen-1",
    source: "operator-configured",
    rules: [{ concern: "dehydration", ingredient: "Glycerin", relevance: 3 }],
  };
  return {
    repository,
    device,
    id,
    policy,
    expire: () => {
      now += 15 * 60_000;
    },
  };
}

describe("consultation policy snapshots", () => {
  it("retains the first exact policy for an empty recommendation run and clones both boundaries", async () => {
    const f = await setup();
    expect((await f.repository.policy(f.device, f.id)).version).toBe("demo-1");
    await f.repository.saveRecommendations(f.id, f.device, f.policy, []);
    f.policy.rules[0].ingredient = "Water";
    const saved = await f.repository.policy(f.device, f.id);
    expect(saved.version).toBe("frozen-1");
    expect(saved.rules[0].ingredient).toBe("Glycerin");
    saved.rules[0].ingredient = "Parfum";
    await f.repository.saveRecommendations(
      f.id,
      f.device,
      { ...f.policy, version: "replacement-2" },
      [],
    );
    expect(
      (await f.repository.policy(f.device, f.id)).rules[0].ingredient,
    ).toBe("Glycerin");
    expect((await f.repository.policy(f.device, f.id)).version).toBe(
      "frozen-1",
    );
  });

  it("never exposes a policy snapshot to another paired device", async () => {
    const f = await setup();
    await f.repository.saveRecommendations(f.id, f.device, f.policy, []);
    const other = f.repository.ensureDevice("other-consultation-policy-device");
    await expect(f.repository.policy(other, f.id)).rejects.toMatchObject({
      code: "session_not_found",
    });
  });

  it.each(["finish", "expiry", "revoke"] as const)(
    "clears the session snapshot on %s",
    async (exit) => {
      const f = await setup();
      await f.repository.saveRecommendations(f.id, f.device, f.policy, []);
      if (exit === "finish") await f.repository.finish(f.id, f.device);
      else if (exit === "expiry") f.expire();
      else await f.repository.revokeDevice(f.device.deviceId);
      await expect(f.repository.policy(f.device, f.id)).rejects.toMatchObject({
        status: exit === "revoke" ? 401 : 404,
      });
      if (exit !== "revoke") {
        const next = await f.repository.start(f.device);
        expect((await f.repository.policy(f.device, next.id)).version).toBe(
          "demo-1",
        );
      }
    },
  );
});
