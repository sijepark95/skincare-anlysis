import { afterEach, describe, expect, it, vi } from "vitest";
import {
  answersSchema,
  assertSameOrigin,
  catalogSchema,
  listingSchema,
  readJson,
} from "@/interfaces/http/validation";

afterEach(() => vi.unstubAllEnvs());

describe("same-origin mutation boundary", () => {
  it("uses the current runtime origin after a server artifact is promoted", () => {
    const request = (origin: string) =>
      new Request(`${origin}/api/v1/kiosk/sessions`, {
        method: "POST",
        headers: { Origin: origin },
      });
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://127.0.0.1:3000");
    expect(() =>
      assertSameOrigin(request("http://127.0.0.1:3000")),
    ).not.toThrow();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://127.0.0.1:4567");
    expect(() =>
      assertSameOrigin(request("http://127.0.0.1:4567")),
    ).not.toThrow();
    expect(() => assertSameOrigin(request("http://127.0.0.1:3000"))).toThrow(
      expect.objectContaining({ status: 403, code: "origin_rejected" }),
    );
  });

  it("requires an explicit origin in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(() =>
      assertSameOrigin(
        new Request("http://localhost/api", {
          method: "POST",
          headers: { Origin: "http://localhost" },
        }),
      ),
    ).toThrow(
      expect.objectContaining({ status: 503, code: "configuration_required" }),
    );
  });

  it.each([
    "not-a-url",
    "file:///tmp/app",
    "https://user:password@senmiva.example",
  ])("fails closed for an invalid configured origin: %s", (origin) => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", origin);
    expect(() =>
      assertSameOrigin(
        new Request("https://senmiva.example/api", {
          method: "POST",
          headers: { Origin: "https://senmiva.example" },
        }),
      ),
    ).toThrow(
      expect.objectContaining({ status: 503, code: "configuration_required" }),
    );
  });

  it("accepts the configured application origin", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://senmiva.example");
    expect(() =>
      assertSameOrigin(
        new Request("https://senmiva.example/api/v1/kiosk/sessions", {
          method: "POST",
          headers: { Origin: "https://senmiva.example" },
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    undefined,
    "null",
    "https://attacker.example",
    "https://senmiva.example.attacker.example",
  ])("rejects absent, opaque and cross-site origins: %s", (origin) => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://senmiva.example");
    const headers = new Headers();
    if (origin !== undefined) headers.set("Origin", origin);
    expect(() =>
      assertSameOrigin(
        new Request("https://senmiva.example/api/v1/kiosk/sessions", {
          method: "POST",
          headers,
        }),
      ),
    ).toThrow(
      expect.objectContaining({ status: 403, code: "origin_rejected" }),
    );
  });

  it("uses the configured origin rather than a forged request host", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://senmiva.example");
    expect(() =>
      assertSameOrigin(
        new Request("https://attacker.example/api", {
          method: "POST",
          headers: { Origin: "https://attacker.example" },
        }),
      ),
    ).toThrow();
  });

  it.each([
    ["http://127.0.0.1:3000", "http://localhost:3000"],
    ["http://localhost:3000", "http://127.0.0.1:3000"],
    ["http://127.0.0.1:3000", "http://[::1]:3000"],
    ["http://[::1]:3000", "http://localhost:3000"],
  ])(
    "accepts same-origin development loopback aliases %s → %s",
    (configured, actual) => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("NEXT_PUBLIC_APP_URL", configured);
      for (const fetchSite of [undefined, "same-origin"]) {
        const headers = new Headers({ Origin: actual });
        if (fetchSite !== undefined) headers.set("Sec-Fetch-Site", fetchSite);
        expect(() =>
          assertSameOrigin(
            new Request(`${actual}/api`, { method: "POST", headers }),
          ),
        ).not.toThrow();
      }
    },
  );

  it.each([
    ["http://127.0.0.1:3000", "http://localhost:3001", "http://localhost:3001"],
    [
      "http://127.0.0.1:3000",
      "https://localhost:3000",
      "https://localhost:3000",
    ],
    [
      "http://127.0.0.1:3000",
      "http://public.example:3000",
      "http://public.example:3000",
    ],
    [
      "http://public.example:3000",
      "http://localhost:3000",
      "http://localhost:3000",
    ],
    [
      "http://127.0.0.1:3000",
      "http://localhost.attacker.example:3000",
      "http://localhost.attacker.example:3000",
    ],
    [
      "http://127.0.0.1:3000",
      "http://*.localhost:3000",
      "http://*.localhost:3000",
    ],
    ["http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000"],
    ["http://127.0.0.1:3000", "http://localhost:3000", "null"],
    ["http://127.0.0.1:3000", "http://localhost:3000", undefined],
  ])(
    "rejects unsafe alias boundary %s / %s / %s",
    (configured, actual, origin) => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("NEXT_PUBLIC_APP_URL", configured);
      const headers = new Headers();
      if (origin !== undefined) headers.set("Origin", origin);
      // Forwarded host and referrer never grant authority to the alias branch.
      headers.set("X-Forwarded-Host", "localhost:3000");
      headers.set("Referer", `${actual}/management/signup`);
      expect(() =>
        assertSameOrigin(
          new Request(`${actual}/api`, { method: "POST", headers }),
        ),
      ).toThrow(
        expect.objectContaining({ status: 403, code: "origin_rejected" }),
      );
    },
  );

  it.each(["cross-site", "same-site", "none", ""])(
    "rejects development aliases with inconsistent fetch metadata: %s",
    (fetchSite) => {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://127.0.0.1:3000");
      expect(() =>
        assertSameOrigin(
          new Request("http://localhost:3000/api", {
            method: "POST",
            headers: {
              Origin: "http://localhost:3000",
              "Sec-Fetch-Site": fetchSite,
            },
          }),
        ),
      ).toThrow(
        expect.objectContaining({ status: 403, code: "origin_rejected" }),
      );
    },
  );

  it("rejects loopback aliases in production while preserving the exact configured origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://127.0.0.1:3000");
    for (const actual of ["http://localhost:3000", "http://[::1]:3000"]) {
      expect(() =>
        assertSameOrigin(
          new Request(`${actual}/api`, {
            method: "POST",
            headers: { Origin: actual },
          }),
        ),
      ).toThrow(
        expect.objectContaining({ status: 403, code: "origin_rejected" }),
      );
    }
    expect(() =>
      assertSameOrigin(
        new Request("http://127.0.0.1:3000/api", {
          method: "POST",
          headers: { Origin: "http://127.0.0.1:3000" },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects a credential-bearing request URL in the alias branch", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://127.0.0.1:3000");
    const request = new Request("http://localhost:3000/api", {
      method: "POST",
      headers: { Origin: "http://localhost:3000" },
    });
    Object.defineProperty(request, "url", {
      value: "http://user:password@localhost:3000/api",
    });
    expect(() => assertSameOrigin(request)).toThrow(
      expect.objectContaining({ status: 403, code: "origin_rejected" }),
    );
  });
});

describe("bounded JSON transport", () => {
  it("accepts JSON with an explicit charset", async () => {
    const request = new Request("http://localhost/api", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: '{"accepted":true}',
    });
    await expect(readJson(request)).resolves.toEqual({ accepted: true });
  });

  it("rejects a photo or form body before decoding", async () => {
    const request = new Request("http://localhost/api", {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: "image-data",
    });
    await expect(readJson(request)).rejects.toMatchObject({ status: 415 });
  });

  it("rejects a deceptive JSON-like media type", async () => {
    const request = new Request("http://localhost/api", {
      method: "POST",
      headers: { "Content-Type": "application/jsonp" },
      body: "{}",
    });
    await expect(readJson(request)).rejects.toMatchObject({ status: 415 });
  });

  it("bounds byte count rather than string length", async () => {
    const body = JSON.stringify({ value: "한".repeat(10) });
    const request = new Request("http://localhost/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    await expect(readJson(request, 30)).rejects.toMatchObject({
      status: 413,
      code: "body_too_large",
    });
  });

  it("enforces the byte cap on a chunked body without Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"x":"'));
        controller.enqueue(new TextEncoder().encode("x".repeat(100)));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
    });
    const request = new Request("http://localhost/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    await expect(readJson(request, 32)).rejects.toMatchObject({ status: 413 });
  });

  it("does not echo malformed JSON or its personal content", async () => {
    const request = new Request("http://localhost/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"PRIVATE-CUSTOMER-INPUT"',
    });
    await expect(readJson(request)).rejects.toMatchObject({
      status: 400,
      message: "The request contains invalid JSON.",
    });
  });

  it("rejects missing request bodies", async () => {
    const request = new Request("http://localhost/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    await expect(readJson(request)).rejects.toMatchObject({
      status: 400,
      code: "body_required",
    });
  });
});

const validAnswers = {
  skinType: "dry",
  concerns: ["dehydration"],
  excludedIngredients: [],
  sensitive: false,
};
const validCatalog = {
  sku: "TEST-01",
  brand: "Test Brand",
  name: "Test Serum",
  category: "serum",
  priceMinor: 2400,
  currency: "USD",
  stock: 4,
  visible: false,
  ingredients: ["Aqua", "Glycerin"],
  formulaComplete: true,
  suitableSkinTypes: ["dry"],
};

describe("strict public request contracts", () => {
  it("rejects photos, organization IDs and client-supplied analysis results", () => {
    for (const field of [
      "photo",
      "image_base64",
      "organizationId",
      "analysis",
      "recommendations",
    ]) {
      expect(
        answersSchema.safeParse({ ...validAnswers, [field]: "untrusted" })
          .success,
      ).toBe(false);
    }
  });

  it("rejects duplicate or excessive selected concerns", () => {
    expect(
      answersSchema.safeParse({
        ...validAnswers,
        concerns: ["dehydration", "dehydration"],
      }).success,
    ).toBe(false);
    expect(
      answersSchema.safeParse({
        ...validAnswers,
        concerns: Array(5).fill("texture"),
      }).success,
    ).toBe(false);
  });

  it("requires an explicit boolean sensitivity answer", () => {
    expect(
      answersSchema.safeParse({ ...validAnswers, sensitive: "false" }).success,
    ).toBe(false);
    expect(
      answersSchema.safeParse({ ...validAnswers, sensitive: 0 }).success,
    ).toBe(false);
  });

  it("rejects unbounded exclusion lists", () => {
    expect(
      answersSchema.safeParse({
        ...validAnswers,
        excludedIngredients: Array(21).fill("Glycerin"),
      }).success,
    ).toBe(false);
  });

  it("requires integer minor-unit prices and supported currency", () => {
    expect(catalogSchema.safeParse(validCatalog).success).toBe(true);
    for (const patch of [
      { priceMinor: 23.5 },
      { priceMinor: -1 },
      { stock: -1 },
      { currency: "EUR" },
    ]) {
      expect(
        catalogSchema.safeParse({ ...validCatalog, ...patch }).success,
      ).toBe(false);
    }
  });

  it("limits manager listing edits to price, stock and visibility", () => {
    const listing = { priceMinor: 2400, stock: 4, visible: true };
    expect(listingSchema.safeParse(listing).success).toBe(true);
    expect(
      listingSchema.safeParse({ ...listing, ingredients: ["Retinol"] }).success,
    ).toBe(false);
    expect(
      listingSchema.safeParse({ ...listing, organizationId: "other-tenant" })
        .success,
    ).toBe(false);
  });
});
