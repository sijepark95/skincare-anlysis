import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectedAnalysisConfig } from "../scripts/lib/connected-analysis-config.mjs";
import { inferenceEnvironment } from "../scripts/lib/inference-environment.mjs";

let folder: string;
let python: string;
const key = "sk-synthetic-private-key-for-configuration-only";
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "senmiva-openai-photo-"));
  python = path.join(
    folder,
    "services/analysis/.venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  await mkdir(path.dirname(python), { recursive: true });
  await writeFile(python, "not executed by config tests");
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe("explicit hosted photo-analysis process configuration", () => {
  it("uses a plain service environment with no ML workspace or artifact settings required", () => {
    const result = connectedAnalysisConfig(folder, {
      ANALYSIS_PROVIDER: "openai",
      OPENAI_API_KEY: key,
    });
    expect(result.provider).toBe("openai");
    expect(result.endpoint).toBe("/v1/analyze/openai");
    expect(result.python).toBe(python);
    expect(result.inference).toEqual({
      ANALYSIS_PROVIDER: "openai",
      ANALYSIS_OPENAI_TIMEOUT_SECONDS: "30",
    });
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it("can reuse an existing private Python without requiring any model artifacts", async () => {
    const workspace = path.join(folder, "private-python");
    const executable = path.join(
      workspace,
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "not executed");
    await mkdir(path.join(folder, ".local"));
    await writeFile(
      path.join(folder, ".local/ml-workspace.json"),
      JSON.stringify({ workspace_path: workspace }),
    );
    const result = connectedAnalysisConfig(folder, {
      ANALYSIS_PROVIDER: "openai",
      OPENAI_API_KEY: key,
    });
    expect(result.python).toBe(executable);
    expect(result.inference).not.toHaveProperty("ANALYSIS_PHOTO_RUN");
    expect(result.inference).not.toHaveProperty("SENMIVA_ML_WORKSPACE");
  });
  it("refuses missing credentials and invalid deadlines without exposing secrets", () => {
    for (const apiKey of ["", "sk-short", "private-invalid-key"]) {
      expect(() =>
        connectedAnalysisConfig(folder, {
          ANALYSIS_PROVIDER: "openai",
          OPENAI_API_KEY: apiKey,
        }),
      ).toThrow("OPENAI_API_KEY");
    }
    for (const timeout of ["0", "31", "NaN", "Infinity"]) {
      expect(() =>
        connectedAnalysisConfig(folder, {
          ANALYSIS_PROVIDER: "openai",
          OPENAI_API_KEY: key,
          ANALYSIS_OPENAI_TIMEOUT_SECONDS: timeout,
        }),
      ).toThrow("TIMEOUT");
    }
  });
  it("forwards the key only in explicit openai mode and strips unrelated secrets and model controls", () => {
    const environment = {
      ANALYSIS_PROVIDER: "openai",
      OPENAI_API_KEY: key,
      OPENAI_EXPLANATION_MODEL: "private-model",
      EXPLANATION_PROVIDER: "openai",
      SMTP_PASS: "mail",
      SUPABASE_SECRET_KEY: "admin",
      ANALYSIS_DATABASE_URL: "database",
      ANALYSIS_API_KEY: "private-service-key",
      SENMIVA_ML_WORKSPACE: "private-weights",
      ANALYSIS_DEVICE: "cuda",
      ANALYSIS_PHOTO_RUN: "old-run",
      ANALYSIS_INGREDIENT_RUN: "old-ingredients",
      PATH: "keep",
    };
    expect(inferenceEnvironment(environment)).toEqual({
      ANALYSIS_PROVIDER: "openai",
      OPENAI_API_KEY: key,
      ANALYSIS_API_KEY: "private-service-key",
      PATH: "keep",
    });
    for (const mode of ["mock", "experimental", "unknown", undefined]) {
      expect(
        inferenceEnvironment({ ...environment, ANALYSIS_PROVIDER: mode }),
      ).not.toHaveProperty("OPENAI_API_KEY");
    }
  });
});
