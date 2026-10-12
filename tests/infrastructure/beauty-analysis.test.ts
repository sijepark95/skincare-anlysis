import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpBeautyAnalysis } from "@/infrastructure/beauty-analysis";
import {
  BEAUTY_MODEL_VERSION,
  BEAUTY_PROMPT_VERSION,
  BEAUTY_PROMPT_VERSION_V2,
} from "@/domain/beauty-analysis";

const requestId = "347b4f69-cbec-4d5d-a67f-4babce54d5fb";
const result = {
  request_id: requestId,
  mode: "openai_beauty",
  model_version: BEAUTY_MODEL_VERSION,
  prompt_version: BEAUTY_PROMPT_VERSION,
  image_quality: "usable",
  undertone: "neutral",
  chroma: "soft",
  face_shape: "oval",
  quality_flags: [],
};
const key = "synthetic-test-key-never-a-live-secret";
const url = "http://127.0.0.1:8000/";
const image = new Uint8Array([1, 2, 3, 4]);
const unavailable = { status: 503, code: "beauty_analysis_unavailable" };
function json(value: unknown = result, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json; charset=utf-8" },
    ...init,
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("private beauty-only bounded HTTP transport", () => {
  it("accepts exact v2 visible feature categories without coercing legacy data", async () => {
    const current = {
      ...result,
      prompt_version: BEAUTY_PROMPT_VERSION_V2,
      eye_shape: "hooded",
      nose_shape: "medium",
      lip_fullness: "fine",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(current)),
    );
    expect(
      await new HttpBeautyAnalysis(url, key).analyze(requestId, image),
    ).toEqual(current);
  });
  it("sends only a fresh request ID and photo bytes to the private authenticated endpoint", async () => {
    const fetch = vi.fn(async () => json());
    vi.stubGlobal("fetch", fetch);
    expect(
      await new HttpBeautyAnalysis(url, key).analyze(requestId, image),
    ).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [target, options] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(target).toBe("http://127.0.0.1:8000/v1/analyze/beauty");
    expect(options).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Analysis-Key": key },
      cache: "no-store",
      redirect: "error",
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal?.aborted).toBe(false);
    const payload = JSON.parse(options.body as string);
    expect(Object.keys(payload).sort()).toEqual(["image_base64", "request_id"]);
    expect(payload).toEqual({
      request_id: requestId,
      image_base64: Buffer.from(image).toString("base64"),
    });
    expect(Buffer.from(payload.image_base64, "base64")).toEqual(
      Buffer.from(image),
    );
  });

  it.each([
    { image: new Uint8Array(), key },
    { image: new Uint8Array(10 * 1024 * 1024 + 1), key },
    { image, key: "too-short" },
  ])(
    "rejects invalid image or unconfigured authentication before network work",
    async (input) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(
        new HttpBeautyAnalysis(url, input.key).analyze(requestId, input.image),
      ).rejects.toMatchObject(unavailable);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("permits the exact input byte boundary without adding any other private context", async () => {
    const fetch = vi.fn(async () => json());
    vi.stubGlobal("fetch", fetch);
    await new HttpBeautyAnalysis(url, key).analyze(
      requestId,
      new Uint8Array(10 * 1024 * 1024),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(options.body as string);
    expect(Buffer.from(payload.image_base64, "base64").length).toBe(
      10 * 1024 * 1024,
    );
    expect(Object.keys(payload)).toEqual(["request_id", "image_base64"]);
  });

  it.each([
    [
      "foreign request ID",
      () =>
        json({ ...result, request_id: "db989db4-8e4a-4d48-92e7-9dff45808c6a" }),
    ],
    [
      "wrong model snapshot",
      () => json({ ...result, model_version: "gpt-4.1-mini" }),
    ],
    [
      "provider prose",
      () => json({ ...result, explanation: "untrusted text" }),
    ],
    ["unsupported face label", () => json({ ...result, face_shape: "cat" })],
    ["invented confidence", () => json({ ...result, confidence: 0.98 })],
    [
      "unsupported protocol",
      () => json({ ...result, prompt_version: "skin-v1" }),
    ],
    [
      "inconsistent quality",
      () =>
        json({ ...result, image_quality: "limited", quality_flags: ["blur"] }),
    ],
    [
      "not JSON",
      () =>
        new Response("<html>private service error</html>", {
          headers: { "content-type": "text/html" },
        }),
    ],
    [
      "malformed JSON",
      () =>
        new Response("{broken", {
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "missing response body",
      () =>
        new Response(null, { headers: { "content-type": "application/json" } }),
    ],
    [
      "provider rate limit",
      () => json({ private: "upstream error" }, { status: 429 }),
    ],
    [
      "server failure",
      () => json({ private: "upstream error" }, { status: 500 }),
    ],
    [
      "redirect",
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://untrusted.invalid" },
        }),
    ],
  ] as const)(
    "fails closed and never retries after %s",
    async (_name, response) => {
      const fetch = vi.fn(async () => response());
      vi.stubGlobal("fetch", fetch);
      await expect(
        new HttpBeautyAnalysis(url, key).analyze(requestId, image),
      ).rejects.toMatchObject(unavailable);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds accumulated response bytes independently of Content-Length and releases the stream", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(result)));
        controller.enqueue(new Uint8Array(16384));
      },
      cancel,
    });
    const response = new Response(stream, {
      headers: { "content-type": "application/json", "content-length": "1" },
    });
    const fetch = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetch);
    await expect(
      new HttpBeautyAnalysis(url, key).analyze(requestId, image),
    ).rejects.toMatchObject(unavailable);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts a valid streamed response at the exact 16 KiB limit", async () => {
    const body = JSON.stringify(result).padEnd(16384, " ");
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 50));
        controller.enqueue(bytes.slice(50, 1000));
        controller.enqueue(bytes.slice(1000));
        controller.close();
      },
    });
    const response = new Response(stream, {
      headers: { "content-type": "APPLICATION/JSON; charset=utf-8" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    expect(
      await new HttpBeautyAnalysis(url, key).analyze(requestId, image),
    ).toEqual(result);
    expect(response.body?.locked).toBe(false);
  });

  it.each(["network", "abort", "stream"])(
    "sanitizes %s failures and performs no retry",
    async (kind) => {
      const error = new Error("synthetic private upstream details");
      const fetch = vi.fn(async () => {
        if (kind !== "stream") throw error;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(error);
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetch);
      const caught = await new HttpBeautyAnalysis(url, key)
        .analyze(requestId, image)
        .catch((failure: unknown) => failure);
      expect(caught).toMatchObject(unavailable);
      expect((caught as Error).message).not.toContain(error.message);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
});
