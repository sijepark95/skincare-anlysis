import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpBeautyMakeup } from "@/infrastructure/beauty-makeup";
import {
  BEAUTY_MAKEUP_MODEL_VERSION,
  BEAUTY_MAKEUP_PROMPT_VERSION,
  beautyMakeupMoodIds,
  BEAUTY_MAKEUP_MAX_RESPONSE_BYTES,
} from "@/domain/beauty-makeup";
import type { PaletteId } from "@/domain/personal-color";

const requestId = "839acebb-91cb-4e96-892e-f363f4962a61";
const result = {
  request_id: requestId,
  mode: "openai_beauty_makeup",
  model_version: BEAUTY_MAKEUP_MODEL_VERSION,
  prompt_version: BEAUTY_MAKEUP_PROMPT_VERSION,
  images: beautyMakeupMoodIds.map((id, index) => ({
    id,
    image_base64: Buffer.from([255, 216, 255, 224, index, 255, 217]).toString(
      "base64",
    ),
    mime_type: "image/jpeg",
  })),
};
const key = "synthetic-test-private-service-key-only";
const url = "http://127.0.0.1:8000/";
const image = new Uint8Array([1, 2, 3]);
const unavailable = { status: 503, code: "beauty_makeup_unavailable" };
function json(value: unknown = result, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("private makeup image-edit transport", () => {
  it("sends only admitted image, fresh UUID and confirmed allowlisted palette to the private service", async () => {
    const fetch = vi.fn(async () => json());
    vi.stubGlobal("fetch", fetch);
    expect(
      await new HttpBeautyMakeup(url, key).generate(
        requestId,
        image,
        "cool_soft",
      ),
    ).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [target, options] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(target).toBe("http://127.0.0.1:8000/v1/generate/beauty-makeup");
    expect(options).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Analysis-Key": key },
      cache: "no-store",
      redirect: "error",
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(options.body as string)).toEqual({
      request_id: requestId,
      image_base64: Buffer.from(image).toString("base64"),
      palette_id: "cool_soft",
    });
  });
  it.each([
    { image: new Uint8Array(), key, palette: "cool_soft" },
    { image: new Uint8Array(10 * 1024 * 1024 + 1), key, palette: "cool_soft" },
    { image, key: "short", palette: "cool_soft" },
    { image, key, palette: "spring" },
  ])(
    "rejects invalid admission payload before any network work",
    async (value) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(
        new HttpBeautyMakeup(url, value.key).generate(
          requestId,
          value.image,
          value.palette as PaletteId,
        ),
      ).rejects.toMatchObject(unavailable);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([
    () =>
      json({ ...result, request_id: "36755763-aaad-47cf-90b6-3ca605af06ce" }),
    () => json({ ...result, images: [] }),
    () => json({ ...result, explanation: "PRIVATE-UPSTREAM" }),
    () => json({ private: "PRIVATE-UPSTREAM" }, { status: 503 }),
    () =>
      new Response("PRIVATE-UPSTREAM", {
        headers: { "content-type": "text/html" },
      }),
    () =>
      new Response("{malformed", {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response(null, {
        status: 307,
        headers: { location: "https://untrusted.invalid" },
      }),
    () =>
      new Response(null, { headers: { "content-type": "application/json" } }),
    () =>
      json(result, {
        headers: {
          "content-type": "application/json",
          "content-length": String(BEAUTY_MAKEUP_MAX_RESPONSE_BYTES + 1),
        },
      }),
  ])(
    "fails closed without retry, upstream details or partial result",
    async (response) => {
      const fetch = vi.fn(async () => response());
      vi.stubGlobal("fetch", fetch);
      const error = await new HttpBeautyMakeup(url, key)
        .generate(requestId, image, "cool_soft")
        .catch((error: unknown) => error);
      expect(error).toMatchObject(unavailable);
      expect((error as Error).message).not.toContain("PRIVATE");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("cancels an oversized streamed reply even with a misleading length and releases the lock", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(BEAUTY_MAKEUP_MAX_RESPONSE_BYTES));
          controller.enqueue(new Uint8Array([1]));
        },
        cancel,
      }),
      {
        headers: { "content-type": "application/json", "content-length": "1" },
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    await expect(
      new HttpBeautyMakeup(url, key).generate(requestId, image, "cool_soft"),
    ).rejects.toMatchObject(unavailable);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });
  it("accepts a valid streamed response at the exact limit and clears transient transport chunks", async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify(result).padEnd(BEAUTY_MAKEUP_MAX_RESPONSE_BYTES, " "),
    );
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    expect(
      await new HttpBeautyMakeup(url, key).generate(
        requestId,
        image,
        "cool_soft",
      ),
    ).toEqual(result);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    expect(response.body?.locked).toBe(false);
  });
  it.each(["abort", "network", "stream"])(
    "sanitizes %s errors and makes one attempt only",
    async (kind) => {
      const fetch = vi.fn(async () => {
        if (kind !== "stream") throw new Error("PRIVATE-UPSTREAM");
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("PRIVATE-UPSTREAM"));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetch);
      await expect(
        new HttpBeautyMakeup(url, key).generate(requestId, image, "cool_soft"),
      ).rejects.toMatchObject(unavailable);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});
