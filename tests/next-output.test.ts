import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
} from "next/constants";
import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config";

afterEach(() => vi.unstubAllEnvs());

describe("Next output isolation", () => {
  it("does not replay persisted development HMR hashes after restarting the preview", () => {
    expect(
      nextConfig(PHASE_DEVELOPMENT_SERVER).experimental
        ?.turbopackFileSystemCacheForDev,
    ).toBe(false);
  });
  it("keeps the live development cache outside the production build directory", () => {
    vi.stubEnv("NEXT_DIST_DIR", "");
    expect(nextConfig(PHASE_DEVELOPMENT_SERVER).distDir).toBe(
      ".next-development",
    );
    expect(nextConfig(PHASE_PRODUCTION_BUILD).distDir).toBe(".next");
  });

  it("starts production from the same output used by its build", () => {
    vi.stubEnv("NEXT_DIST_DIR", "");
    expect(nextConfig(PHASE_PRODUCTION_SERVER).distDir).toBe(
      nextConfig(PHASE_PRODUCTION_BUILD).distDir,
    );
  });

  it("preserves explicit isolated output paths for browser tests and custom builds", () => {
    vi.stubEnv("NEXT_DIST_DIR", ".next-e2e");
    for (const phase of [
      PHASE_DEVELOPMENT_SERVER,
      PHASE_PRODUCTION_BUILD,
      PHASE_PRODUCTION_SERVER,
    ]) {
      expect(nextConfig(phase).distDir).toBe(".next-e2e");
    }
  });
});
