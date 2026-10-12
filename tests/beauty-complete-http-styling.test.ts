import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceContext, Repository } from "@/application/contracts";
import type { BeautyRepository } from "@/application/beauty-consultations";

const harness = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock("@/application/beauty-complete", () => ({
  BeautyCompleteConsultations: class {
    preview = harness.preview;
  },
}));
vi.mock("@/infrastructure/demo-beauty-complete", () => ({
  demoBeautyCompleteRepository: {},
}));
vi.mock("@/infrastructure/beauty-complete-repository", () => ({
  makeSupabaseBeautyCompleteRepository: vi.fn(),
}));
import { handleCompleteKiosk } from "@/interfaces/http/beauty-complete-handler";

const id = "44444444-4444-4444-8444-444444444444";
const device: DeviceContext = {
  deviceId: "device",
  storeId: "store",
  organizationId: "org",
};
const base = {} as Repository & BeautyRepository;
function request(direction?: string) {
  return new Request(
    `http://localhost/api/v1/kiosk/sessions/${id}/beauty-preview/0`,
    {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
      headers: {
        "Content-Type": "image/jpeg",
        ...(direction === undefined
          ? {}
          : { "X-Beauty-Styling-Direction": direction }),
      },
    },
  );
}
beforeEach(() => {
  vi.stubEnv("APP_MODE", "demo");
  vi.stubEnv("ANALYSIS_PROVIDER", "mock");
  harness.preview.mockReset().mockResolvedValue({ kind: "makeup", index: 0 });
});
afterEach(() => vi.unstubAllEnvs());
describe("transient preview styling header boundary", () => {
  it.each([undefined, "balanced", "masculine", "feminine"])(
    "passes registered %s direction with no Gender argument",
    async (direction) => {
      const active = new Set<string>();
      const response = await handleCompleteKiosk(
        request(direction),
        ["kiosk", "sessions", id, "beauty-preview", "0"],
        id,
        device,
        base,
        active,
        (value) => Response.json(value),
      );
      expect(response?.status).toBe(200);
      expect(harness.preview).toHaveBeenCalledTimes(1);
      expect(harness.preview.mock.calls[0]).toHaveLength(5);
      expect(harness.preview.mock.calls[0][4]).toBe(direction ?? "balanced");
      expect(active.size).toBe(0);
    },
  );
  it.each(["", "man", "MASculine", "masculine,feminine", "custom prompt"])(
    "rejects %s before reading pixels or claiming a request",
    async (direction) => {
      const active = new Set<string>(),
        incoming = request(direction);
      await expect(
        handleCompleteKiosk(
          incoming,
          ["kiosk", "sessions", id, "beauty-preview", "0"],
          id,
          device,
          base,
          active,
          (value) => Response.json(value),
        ),
      ).rejects.toMatchObject({
        status: 422,
        code: "invalid_styling_direction",
      });
      expect(incoming.bodyUsed).toBe(false);
      expect(harness.preview).not.toHaveBeenCalled();
      expect(active.size).toBe(0);
    },
  );
});
