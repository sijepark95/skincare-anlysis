import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpBeautyCompleteProvider,
  HttpBeautyPreviewProvider,
} from "@/infrastructure/beauty-complete-provider";
import {
  BEAUTY_COMPLETE_PROMPT_VERSION,
  BEAUTY_PREVIEW_MODEL_VERSION,
  BEAUTY_PREVIEW_PROMPT_VERSION,
} from "@/domain/beauty-complete";
import {
  BEAUTY_MODEL_VERSION,
  BEAUTY_PROMPT_VERSION_V2,
} from "@/domain/beauty-analysis";
import {
  OPENAI_SKIN_PROMPT_VERSION,
  VISION_FEATURES,
} from "@/domain/skin-vision";

const requestId = "839acebb-91cb-4e96-892e-f363f4962a61";
const key = "server-private-test-key-32-characters-only";
const complete = {
  request_id: requestId,
  mode: "openai_beauty_complete",
  model_version: BEAUTY_MODEL_VERSION,
  prompt_version: BEAUTY_COMPLETE_PROMPT_VERSION,
  beauty: {
    request_id: requestId,
    mode: "openai_beauty",
    model_version: BEAUTY_MODEL_VERSION,
    prompt_version: BEAUTY_PROMPT_VERSION_V2,
    image_quality: "usable",
    quality_flags: [],
    undertone: "warm",
    chroma: "soft",
    face_shape: "oval",
    eye_shape: "almond",
    nose_shape: "medium",
    lip_fullness: "full",
  },
  skin: {
    prompt_version: OPENAI_SKIN_PROMPT_VERSION,
    image_quality: "usable",
    quality_flags: [],
    observed_features: Object.fromEntries(
      VISION_FEATURES.map((name) => [name, "uncertain"]),
    ),
  },
  animalVibe: "uncertain",
  baseDepth: "uncertain",
};
const preview = {
  request_id: requestId,
  kind: "hair_style",
  index: 0,
  mime_type: "image/jpeg",
  image_base64: Buffer.from([255, 216, 255, 224, 1, 255, 217]).toString(
    "base64",
  ),
  model_version: BEAUTY_PREVIEW_MODEL_VERSION,
  prompt_version: BEAUTY_PREVIEW_PROMPT_VERSION,
};
afterEach(() => vi.unstubAllGlobals());

describe("bounded private complete/individual preview adapters", () => {
  it("sends only opaque request ID and the photo once without retries or cache", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(complete));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await new HttpBeautyCompleteProvider(
        "http://127.0.0.1:8000/",
        key,
      ).analyze(requestId, new Uint8Array([1, 2])),
    ).toEqual(complete);
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8000/v1/analyze/beauty-complete");
    expect(JSON.parse(request.body)).toEqual({
      request_id: requestId,
      image_base64: "AQI=",
    });
    expect(request).toMatchObject({
      redirect: "error",
      cache: "no-store",
      headers: { "X-Analysis-Key": key },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("pins individual slot and confirmed palette/shape", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(preview));
    vi.stubGlobal("fetch", fetcher);
    const result = await new HttpBeautyPreviewProvider(
      "http://127.0.0.1:8000",
      key,
    ).generate(
      requestId,
      new Uint8Array([1]),
      "cool_soft",
      "hair_style",
      0,
      "round",
    );
    expect(result).toEqual(preview);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      request_id: requestId,
      image_base64: "AQ==",
      palette_id: "cool_soft",
      kind: "hair_style",
      index: 0,
      face_shape: "round",
      styling_direction: "balanced",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["balanced", "masculine", "feminine"] as const)(
    "forwards only allowlisted transient direction %s",
    async (direction) => {
      const fetcher = vi.fn().mockResolvedValue(Response.json(preview));
      vi.stubGlobal("fetch", fetcher);
      const result = await new HttpBeautyPreviewProvider(
        "http://127.0.0.1:8000",
        key,
      ).generate(
        requestId,
        new Uint8Array([1]),
        "cool_soft",
        "hair_style",
        0,
        "round",
        direction,
      );
      expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
        request_id: requestId,
        image_base64: "AQ==",
        palette_id: "cool_soft",
        kind: "hair_style",
        index: 0,
        face_shape: "round",
        styling_direction: direction,
      });
      expect(result).toEqual(preview);
      expect(result).not.toHaveProperty("styling_direction");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects free text styling before transport", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      new HttpBeautyPreviewProvider("http://127.0.0.1:8000", key).generate(
        requestId,
        new Uint8Array([1]),
        "cool_soft",
        "hair_style",
        0,
        "round",
        "man" as never,
      ),
    ).rejects.toMatchObject({ code: "beauty_preview_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    Response.json({ ...complete, animalVibe: "lion" }),
    Response.json(complete, { status: 500 }),
    new Response("private-upstream-error", {
      headers: { "Content-Type": "text/plain" },
    }),
    new Response("{}", {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "33000",
      },
    }),
    new Response(" ".repeat(33000), {
      headers: { "Content-Type": "application/json" },
    }),
  ])("fails closed once on malformed upstream", async (response) => {
    const fetcher = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetcher);
    await expect(
      new HttpBeautyCompleteProvider("http://127.0.0.1:8000", key).analyze(
        requestId,
        new Uint8Array([1]),
      ),
    ).rejects.toMatchObject({ code: "beauty_complete_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects a different image slot without returning it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ...preview, index: 1 })),
    );
    await expect(
      new HttpBeautyPreviewProvider("http://127.0.0.1:8000", key).generate(
        requestId,
        new Uint8Array([1]),
        "cool_soft",
        "hair_style",
        0,
        "oval",
      ),
    ).rejects.toMatchObject({ code: "beauty_preview_unavailable" });
  });
});
