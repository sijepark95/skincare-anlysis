import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
} from "next/constants";
import nextConfig from "../next.config";

afterEach(() => vi.unstubAllEnvs());

async function policy(phase: string) {
  const rules = await nextConfig(phase).headers!();
  const global = rules.find((rule) => rule.source === "/:path*")!;
  return global.headers.find(
    (header) => header.key === "Content-Security-Policy",
  )!.value;
}

describe("browser network privacy policy", () => {
  it("blocks external SDK metrics even after client navigation to the kiosk", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://retail.example");
    expect(await policy(PHASE_PRODUCTION_BUILD)).toBe(
      "connect-src 'self'; object-src 'none'; base-uri 'self'",
    );
  });

  it("allows only the configured loopback HMR socket during development", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://127.0.0.1:3100");
    expect(await policy(PHASE_DEVELOPMENT_SERVER)).toBe(
      "connect-src 'self' ws://127.0.0.1:3100; object-src 'none'; base-uri 'self'",
    );
  });

  it("does not expand the network boundary for an external development URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://external.example");
    expect(await policy(PHASE_DEVELOPMENT_SERVER)).toBe(
      "connect-src 'self'; object-src 'none'; base-uri 'self'",
    );
  });
});
