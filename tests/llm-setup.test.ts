import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { prepareLlmSettings } from "../scripts/llm-setup.mjs";
import { inferenceEnvironment } from "../scripts/lib/inference-environment.mjs";
import {
  explanationConfiguration,
  configuredExplanationProvider,
  explanationAvailable,
} from "@/infrastructure/explanation-config";

afterEach(() => vi.unstubAllEnvs());
describe("hosted explanation setup", () => {
  it("adds server-only placeholders idempotently without replacing private settings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "senmiva-llm-"));
    try {
      const file = path.join(root, ".env.local");
      await writeFile(
        file,
        'APP_MODE=supabase\nOPENAI_API_KEY="sk-existing-private-secret"\n',
      );
      await prepareLlmSettings(root);
      const first = await readFile(file, "utf8");
      expect(first).toContain('OPENAI_API_KEY="sk-existing-private-secret"');
      expect(first).toContain('EXPLANATION_PROVIDER="openai"');
      await prepareLlmSettings(root);
      expect(await readFile(file, "utf8")).toBe(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("never forwards LLM, mail, Supabase or writer credentials to photo inference", () => {
    expect(
      inferenceEnvironment({
        OPENAI_API_KEY: "private",
        OPENAI_EXPLANATION_MODEL: "x",
        EXPLANATION_PROVIDER: "openai",
        SMTP_PASS: "mail",
        SUPABASE_SECRET_KEY: "admin",
        NEXT_PUBLIC_SUPABASE_URL: "url",
        ANALYSIS_DATABASE_URL: "database",
        ANALYSIS_API_KEY: "local-inference",
        ANALYSIS_DEVICE: "cuda",
        PATH: "keep",
      }),
    ).toEqual({
      ANALYSIS_API_KEY: "local-inference",
      ANALYSIS_DEVICE: "cuda",
      PATH: "keep",
    });
  });
  it("keeps the feature unavailable until explicitly configured with a private key", () => {
    vi.stubEnv("EXPLANATION_PROVIDER", "disabled");
    vi.stubEnv("OPENAI_API_KEY", "sk-test-key-with-enough-characters");
    expect(configuredExplanationProvider()).toBeNull();
    vi.stubEnv("EXPLANATION_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(explanationConfiguration().available).toBe(false);
    vi.stubEnv("OPENAI_API_KEY", "sk-test-key-with-enough-characters");
    expect(explanationConfiguration().available).toBe(true);
    expect(configuredExplanationProvider()?.modelVersion).toBe(
      "gpt-4.1-mini-2025-04-14",
    );
  });
  it("rejects unknown providers/models without disclosing settings", () => {
    vi.stubEnv("EXPLANATION_PROVIDER", "private-untrusted-setting");
    expect(() => explanationConfiguration()).toThrow(
      "supported explanation provider",
    );
    vi.stubEnv("EXPLANATION_PROVIDER", "openai");
    vi.stubEnv("OPENAI_EXPLANATION_MODEL", "unreviewed-model");
    expect(() => explanationConfiguration()).toThrow(
      "supported explanation model",
    );
    expect(explanationAvailable()).toBe(false);
    expect(configuredExplanationProvider()).toBeNull();
  });
});
