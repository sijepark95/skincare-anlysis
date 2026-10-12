import { describe, expect, it, vi } from "vitest";
import { BeautyConsultations } from "@/application/beauty-consultations";
import {
  BEAUTY_MODEL_VERSION,
  BEAUTY_PHOTO_NOTICE_VERSION,
  BEAUTY_PROMPT_VERSION_V2,
  type BeautyAnalysis,
} from "@/domain/beauty-analysis";
import {
  BEAUTY_MAKEUP_MODEL_VERSION,
  BEAUTY_MAKEUP_NOTICE_VERSION,
  BEAUTY_MAKEUP_PROMPT_VERSION,
  type BeautyMakeupResult,
} from "@/domain/beauty-makeup";
import { OPENAI_CONSENT_VERSION } from "@/domain/skin-vision";
import { DemoRepository } from "@/infrastructure/demo-repository";

const requestId = "71a5a613-3ab2-4f2d-97dd-c0b33965318f";
const preferences = {
  paletteId: "cool_soft",
  faceShape: "oval",
  hairLength: "any",
  mood: "soft",
  finish: "any",
} as const;
const photo = new Uint8Array([1, 2, 3]);
function result(): BeautyMakeupResult {
  return {
    request_id: requestId,
    mode: "openai_beauty_makeup",
    model_version: BEAUTY_MAKEUP_MODEL_VERSION,
    prompt_version: BEAUTY_MAKEUP_PROMPT_VERSION,
    images: ["soft", "fresh", "defined"].map((id, index) => ({
      id,
      image_base64: Buffer.from([
        255,
        216,
        255,
        224,
        index,
        0,
        255,
        217,
      ]).toString("base64"),
      mime_type: "image/jpeg",
    })) as BeautyMakeupResult["images"],
  };
}
async function setup(
  options: {
    enabled?: boolean;
    usable?: boolean;
    confirmed?: boolean;
    consent?: boolean;
    now?: () => number;
  } = {},
) {
  const repository = new DemoRepository(false, options.now);
  const device = repository.ensureDevice(crypto.randomUUID());
  const session = await repository.start(device);
  await repository.consent(session.id, device, true, OPENAI_CONSENT_VERSION);
  const analyze = vi.fn(async (): Promise<BeautyAnalysis> => ({
    request_id: requestId,
    mode: "openai_beauty",
    model_version: BEAUTY_MODEL_VERSION,
    prompt_version: BEAUTY_PROMPT_VERSION_V2,
    image_quality: options.usable === false ? "limited" : "usable",
    undertone: options.usable === false ? "uncertain" : "cool",
    chroma: options.usable === false ? "uncertain" : "soft",
    face_shape: options.usable === false ? "uncertain" : "oval",
    eye_shape: options.usable === false ? "uncertain" : "almond",
    nose_shape: options.usable === false ? "uncertain" : "medium",
    lip_fullness: options.usable === false ? "uncertain" : "full",
    quality_flags: options.usable === false ? ["blur"] : [],
  }));
  const generate = vi.fn(async () => result());
  const app = new BeautyConsultations(
    repository,
    { analyze },
    () => requestId,
    false,
    options.enabled === false ? null : { generate },
  );
  await app.consent(session.id, device, true, BEAUTY_PHOTO_NOTICE_VERSION);
  if (options.consent !== false && options.enabled !== false)
    await app.makeupConsent(
      session.id,
      device,
      true,
      BEAUTY_MAKEUP_NOTICE_VERSION,
    );
  await app.analyze(session.id, device, photo);
  if (options.confirmed !== false)
    await app.confirm(session.id, device, preferences);
  return { repository, device, id: session.id, app, generate };
}
describe("own-photo makeup use case", () => {
  it("rejects choices changed between eligibility read and atomic claim before a paid request", async () => {
    const f = await setup();
    const claim = f.repository.claimBeautyMakeup.bind(f.repository);
    vi.spyOn(f.repository, "claimBeautyMakeup").mockImplementationOnce(
      async (id, device) => {
        await f.repository.confirmBeautyPreferences(id, device, {
          ...preferences,
          paletteId: "warm_soft",
        });
        await claim(id, device);
      },
    );
    await expect(f.app.makeup(f.id, f.device, photo)).rejects.toMatchObject({
      code: "makeup_changed",
    });
    expect(f.generate).not.toHaveBeenCalled();
  });
  it("records the optional purpose before analysis but requires later confirmation", async () => {
    const f = await setup();
    expect((await f.app.read(f.id, f.device)).makeup).toEqual({
      consent: true,
      attempted: false,
      available: true,
    });
    expect(await f.app.makeup(f.id, f.device, photo)).toEqual(result());
    expect(f.generate).toHaveBeenCalledExactlyOnceWith(
      requestId,
      photo,
      "cool_soft",
    );
    const state = await f.app.read(f.id, f.device);
    expect(state.makeup).toEqual({
      consent: true,
      attempted: true,
      available: true,
    });
    expect(JSON.stringify(state)).not.toContain("image_base64");
    expect(JSON.stringify(state)).not.toContain("openai_beauty_makeup");
  });
  it.each([
    { enabled: false },
    { usable: false },
    { confirmed: false },
    { consent: false },
  ])(
    "rejects unmet purpose or prerequisites before provider call: %o",
    async (options) => {
      const f = await setup(options);
      await expect(f.app.makeup(f.id, f.device, photo)).rejects.toThrow();
      expect(f.generate).not.toHaveBeenCalled();
      expect(
        (await f.repository.beautyMakeupState(f.id, f.device)).attempted,
      ).toBe(false);
    },
  );
  it("consumes one durable claim even when the provider fails; reconsent never grants a retry", async () => {
    const f = await setup();
    f.generate.mockRejectedValueOnce(new Error("synthetic provider failure"));
    await expect(f.app.makeup(f.id, f.device, photo)).rejects.toThrow();
    await f.app.makeupConsent(
      f.id,
      f.device,
      false,
      BEAUTY_MAKEUP_NOTICE_VERSION,
    );
    await f.app.makeupConsent(
      f.id,
      f.device,
      true,
      BEAUTY_MAKEUP_NOTICE_VERSION,
    );
    await expect(f.app.makeup(f.id, f.device, photo)).rejects.toThrow();
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("concurrent requests start only one provider operation", async () => {
    const f = await setup();
    const outcomes = await Promise.allSettled([
      f.app.makeup(f.id, f.device, photo),
      f.app.makeup(f.id, f.device, photo),
    ]);
    expect(
      outcomes.filter((value) => value.status === "fulfilled"),
    ).toHaveLength(1);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it.each([
    "withdraw",
    "photo-withdraw",
    "preferences",
    "finish",
    "expire",
    "revoke",
  ] as const)("discards a late result after %s", async (change) => {
    let now = Date.now();
    const f = await setup({ now: () => now });
    let deliver!: (value: BeautyMakeupResult) => void;
    const pendingResult = new Promise<BeautyMakeupResult>((resolve) => {
      deliver = resolve;
    });
    f.generate.mockImplementationOnce(() => pendingResult);
    const pending = f.app.makeup(f.id, f.device, photo);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(1));
    if (change === "withdraw")
      await f.app.makeupConsent(
        f.id,
        f.device,
        false,
        BEAUTY_MAKEUP_NOTICE_VERSION,
      );
    if (change === "photo-withdraw")
      await f.app.consent(f.id, f.device, false, BEAUTY_PHOTO_NOTICE_VERSION);
    if (change === "preferences")
      await f.app.confirm(f.id, f.device, { ...preferences, mood: "fresh" });
    if (change === "finish") await f.repository.finish(f.id, f.device);
    if (change === "expire") now += 16 * 60_000;
    if (change === "revoke")
      await f.repository.revokeDevice(f.device.deviceId);
    deliver(result());
    await rejected;
  });
  it("invalid generated output cannot be delivered or stored", async () => {
    const f = await setup();
    f.generate.mockResolvedValueOnce({
      ...result(),
      images: [],
    } as unknown as BeautyMakeupResult);
    await expect(f.app.makeup(f.id, f.device, photo)).rejects.toMatchObject({
      code: "invalid_makeup_preview",
    });
    expect((await f.app.read(f.id, f.device)).makeup?.attempted).toBe(true);
  });
  it("oversized source is rejected before claiming or making a paid call", async () => {
    const f = await setup();
    await expect(
      f.app.makeup(f.id, f.device, new Uint8Array(10 * 1024 * 1024 + 1)),
    ).rejects.toMatchObject({ code: "invalid_image" });
    expect(f.generate).not.toHaveBeenCalled();
  });
});
