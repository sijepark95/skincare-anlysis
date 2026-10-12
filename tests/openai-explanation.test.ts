import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExplanationInput,
  ExplanationPlan,
} from "@/application/explanation-contracts";
import {
  OpenAiExplanationProvider,
  OPENAI_EXPLANATION_MODEL,
} from "@/infrastructure/openai-explanation";

const input: ExplanationInput = {
  products: [
    {
      productRef: "P1",
      facts: [
        { reasonRef: "R1", ingredient: "Glycerin", concern: "Hydration" },
      ],
    },
    {
      productRef: "P2",
      facts: [
        {
          reasonRef: "R2",
          ingredient: "Niacinamide",
          concern: "Even-looking tone",
        },
      ],
    },
  ],
};
const plan: ExplanationPlan = {
  products: [
    { productRef: "P1", reasonRefs: ["R1"], wording: "ingredient_first" },
    { productRef: "P2", reasonRefs: ["R2"], wording: "goal_first" },
  ],
};
function envelope(value: unknown = plan) {
  return {
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          { type: "output_text", text: JSON.stringify(value), annotations: [] },
        ],
      },
    ],
  };
}
function provider(fetcher: typeof fetch, timeoutMs?: number) {
  return new OpenAiExplanationProvider({
    apiKey: "sk-private-fixture",
    fetch: fetcher,
    timeoutMs,
  });
}
afterEach(() => vi.useRealTimers());

describe("OpenAI explanation transport", () => {
  it("sends one bounded, non-persistent Responses request containing only minimized facts", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(envelope()));
    const adapter = provider(fetcher);
    expect(adapter.modelVersion).toBe(OPENAI_EXPLANATION_MODEL);
    expect(await adapter.explain(input)).toEqual(plan);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(options.redirect).toBe("error");
    expect(options.cache).toBe("no-store");
    expect(options.headers.Authorization).toBe("Bearer sk-private-fixture");
    const body = JSON.parse(options.body);
    expect(body.model).toBe(OPENAI_EXPLANATION_MODEL);
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(512);
    expect(JSON.parse(body.input[0].content[0].text)).toEqual(input);
    expect(body.text.format).toMatchObject({
      type: "json_schema",
      name: "retail_match_plan",
      strict: true,
    });
    expect(body.text.format.schema.additionalProperties).toBe(false);
    for (const field of [
      "tools",
      "previous_response_id",
      "conversation",
      "metadata",
      "prompt_cache_retention",
      "background",
    ])
      expect(body).not.toHaveProperty(field);
    expect(JSON.stringify(body)).not.toContain("sk-private-fixture");
  });

  it("skips empty catalogs without an API call", async () => {
    const fetcher = vi.fn();
    expect(await provider(fetcher).explain({ products: [] })).toEqual({
      products: [],
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates input before external transmission", async () => {
    const fetcher = vi.fn();
    await expect(
      provider(fetcher).explain({ ...input, photos: "private" } as never),
    ).rejects.toThrow("service is unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["", "private key", "private\nkey", "x".repeat(513)])(
    "rejects invalid credentials without echoing them (%#)",
    (apiKey) => {
      expect(() => new OpenAiExplanationProvider({ apiKey })).toThrow(
        "The explanation service is unavailable.",
      );
    },
  );

  it.each([
    "gpt-imaginary",
    "https://malicious.example",
    "gpt-4.1-mini\nInjected: secret",
  ])("rejects a model outside the explicit initial allowlist (%#)", (model) => {
    expect(
      () => new OpenAiExplanationProvider({ apiKey: "fixture", model }),
    ).toThrow("service is unavailable");
  });

  it.each([0, -1, 8_001, Number.NaN, 1.1])(
    "never allows an unbounded or invalid deadline (%s)",
    (timeoutMs) => {
      expect(
        () => new OpenAiExplanationProvider({ apiKey: "fixture", timeoutMs }),
      ).toThrow();
    },
  );

  it.each([401, 429, 500, 302])(
    "never retries or exposes provider errors (%s)",
    async (status) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(
          new Response("secret private request upstream diagnosis", { status }),
        );
      await expect(provider(fetcher).explain(input)).rejects.toThrow(
        /^The explanation service is unavailable\.$/,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("sanitizes thrown transport errors", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValue(
        new Error("sk-private-fixture raw-input network error"),
      );
    await expect(provider(fetcher).explain(input)).rejects.toThrow(
      /^The explanation service is unavailable\.$/,
    );
  });

  it("aborts a stalled request within the configured deadline", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockImplementation(() => new Promise(() => undefined));
    const result = expect(provider(fetcher, 50).explain(input)).rejects.toThrow(
      "service is unavailable",
    );
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("includes body reading in the deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream({ start() {}, cancel });
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(body, { headers: { "Content-Type": "application/json" } }),
      );
    const result = expect(provider(fetcher, 50).explain(input)).rejects.toThrow(
      "service is unavailable",
    );
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("OpenAI output boundary", () => {
  it.each([
    { ...envelope(), status: "incomplete" },
    { ...envelope(), incomplete_details: { reason: "max_output_tokens" } },
    { ...envelope(), error: { message: "private remote error" } },
    { ...envelope(), output: [] },
    { ...envelope(), output: [...envelope().output, ...envelope().output] },
    {
      ...envelope(),
      output: [{ type: "function_call", arguments: "exfiltrate" }],
    },
    { ...envelope(), output: [{ ...envelope().output[0], role: "user" }] },
    {
      ...envelope(),
      output: [{ ...envelope().output[0], status: "in_progress" }],
    },
    {
      ...envelope(),
      output: [
        {
          ...envelope().output[0],
          content: [{ type: "refusal", refusal: "No" }],
        },
      ],
    },
    {
      ...envelope(),
      output: [
        {
          ...envelope().output[0],
          content: [
            ...envelope().output[0].content,
            ...envelope().output[0].content,
          ],
        },
      ],
    },
    {
      ...envelope(),
      output: [
        {
          ...envelope().output[0],
          content: [
            {
              ...envelope().output[0].content[0],
              annotations: [{ url: "https://not-reviewed.example" }],
            },
          ],
        },
      ],
    },
    envelope({
      products: [
        { productRef: "P1", reasonRefs: ["R2"], wording: "ingredient_first" },
        plan.products[1],
      ],
    }),
    envelope({ products: [...plan.products].reverse() }),
    envelope({ ...plan, diagnosis: "Invented treatment" }),
    envelope({
      products: [
        { ...plan.products[0], text: "Guaranteed safe" },
        plan.products[1],
      ],
    }),
  ])(
    "rejects incomplete, refusal, extra output and ungrounded plans (%#)",
    async (output) => {
      await expect(
        provider(vi.fn().mockResolvedValue(Response.json(output))).explain(
          input,
        ),
      ).rejects.toThrow(/^The explanation service is unavailable\.$/);
    },
  );

  it.each([
    new Response("<html>unsafe</html>", {
      headers: { "Content-Type": "text/html" },
    }),
    new Response("not-json", {
      headers: { "Content-Type": "application/json" },
    }),
    new Response("{}", {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "40000",
      },
    }),
    new Response(" ".repeat(32 * 1024 + 1), {
      headers: { "Content-Type": "application/json" },
    }),
    new Response(new Uint8Array([0xff, 0xfe]), {
      headers: { "Content-Type": "application/json" },
    }),
  ])("bounds and decodes untrusted response bytes (%#)", async (response) => {
    await expect(
      provider(vi.fn().mockResolvedValue(response)).explain(input),
    ).rejects.toThrow("service is unavailable");
  });
});
