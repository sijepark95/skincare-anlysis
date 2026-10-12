import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectedAnalysisConfig } from "../scripts/lib/connected-analysis-config.mjs";

const script = path.resolve("scripts/dev-connected.mjs");
let folder: string;
let server: Server;
let apiUrl: string;
let settings: unknown;
let status = 200;
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "senmiva-connected-"));
  const python = path.join(
    folder,
    "services/analysis/.venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  await mkdir(path.dirname(python), { recursive: true });
  await writeFile(python, "not executed during preflight");
  settings = {
    external: { anonymous_users: true, email: true },
    disable_signup: false,
  };
  status = 200;
  server = createServer((request, response) => {
    expect(request.url).toBe("/auth/v1/settings");
    expect(request.headers.apikey).toBe("public-test-key");
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(settings));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Test server missing");
  apiUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(folder, { recursive: true, force: true });
});
function run(overrides: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env))
    if (
      /^(NEXT_PUBLIC_|SUPABASE_|ANALYSIS_|APP_MODE|SENMIVA_PYTHON|SENMIVA_ML_WORKSPACE)/.test(
        name,
      )
    )
      delete env[name];
  Object.assign(env, {
    APP_MODE: "supabase",
    NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
    NEXT_PUBLIC_SUPABASE_URL: apiUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public-test-key",
    ANALYSIS_DATABASE_URL:
      "postgresql://writer:test-secret@127.0.0.1:54322/postgres",
    ANALYSIS_SERVICE_URL: "http://127.0.0.1:8000",
    ANALYSIS_API_KEY: "a".repeat(48),
    ...overrides,
  });
  return new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [script, "--check"], {
        cwd: folder,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    },
  );
}
describe("connected development preflight", () => {
  it("selects the private ML environment and both source packages only in explicit experimental mode", async () => {
    const workspace = path.join(folder, "private-ml");
    const executable = path.join(
      workspace,
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "not executed during preflight");
    await mkdir(path.join(folder, ".local"));
    await writeFile(
      path.join(folder, ".local/ml-workspace.json"),
      JSON.stringify({ workspace_path: workspace }),
    );
    const config = connectedAnalysisConfig(folder, {
      ANALYSIS_PROVIDER: "experimental",
    });
    expect(config.provider).toBe("experimental");
    expect(config.python).toBe(executable);
    expect(config.endpoint).toBe("/v1/analyze/experimental");
    expect(config.pythonPath.split(path.delimiter)).toEqual([
      path.join(folder, "services/analysis/src"),
      path.join(folder, "ml/src"),
    ]);
    expect(config.inference).toEqual({
      ANALYSIS_PROVIDER: "experimental",
      SENMIVA_ML_WORKSPACE: workspace,
      ANALYSIS_PHOTO_MANIFEST: "skin-all-001",
      ANALYSIS_PHOTO_RUN: "skin-all-head-001",
      ANALYSIS_INGREDIENT_MANIFEST: "ingredients-001",
      ANALYSIS_INGREDIENT_RUN: "ingredients-linear-001",
      ANALYSIS_DEVICE: "auto",
    });
    const result = await run({ ANALYSIS_PROVIDER: "experimental" });
    expect(result.code).toBe(0);
    expect(result.output).toContain("experimental configuration");
    expect(result.output).not.toContain(workspace);
  });
  it("refuses an unavailable or malformed private model workspace without revealing its contents", async () => {
    const invalid = await run({
      ANALYSIS_PROVIDER: "experimental",
      SENMIVA_ML_WORKSPACE: "./relative-private",
    });
    expect(invalid.code).toBe(1);
    expect(invalid.output).toContain("absolute SENMIVA_ML_WORKSPACE");
    expect(invalid.output).not.toContain("relative-private");
    await mkdir(path.join(folder, ".local"));
    await writeFile(
      path.join(folder, ".local/ml-workspace.json"),
      "{secret-invalid",
    );
    const malformed = await run({ ANALYSIS_PROVIDER: "experimental" });
    expect(malformed.code).toBe(1);
    expect(malformed.output).toContain("pointer is invalid");
    expect(malformed.output).not.toContain("secret-invalid");
  });
  it("rejects unknown providers, traversal names and unknown acceleration settings", async () => {
    expect(() =>
      connectedAnalysisConfig(folder, { ANALYSIS_PROVIDER: "pytorch" }),
    ).toThrow("fallback is disabled");
    for (const overrides of [
      { ANALYSIS_PHOTO_RUN: "../other" },
      { ANALYSIS_DEVICE: "remote" },
    ]) {
      expect(() =>
        connectedAnalysisConfig(folder, {
          ANALYSIS_PROVIDER: "experimental",
          SENMIVA_ML_WORKSPACE: folder,
          SENMIVA_PYTHON: path.join(
            folder,
            "services/analysis/.venv",
            process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
          ),
          ...overrides,
        }),
      ).toThrow();
    }
  });
  it("checks the actual Auth settings shape without launching services or showing secrets", async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.output).toContain("No services started");
    expect(result.output).not.toContain("test-secret");
    expect(result.output).not.toContain("a".repeat(48));
  });
  it("refuses silently running the standalone demo", async () => {
    const result = await run({ APP_MODE: "demo" });
    expect(result.code).toBe(1);
    expect(result.output).toContain("APP_MODE=supabase");
  });
  it("reports disabled anonymous device Auth before a kiosk is paired", async () => {
    settings = {
      external: { anonymous_users: false, email: true },
      disable_signup: false,
    };
    expect((await run()).output).toContain("Enable anonymous sign-ins");
  });
  it("reports a disabled email provider without blaming the administrator password", async () => {
    settings = {
      external: { anonymous_users: true, email: false },
      disable_signup: false,
    };
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.output).toContain("Enable the Email provider");
  });
  it("reports invalid public credentials without exposing upstream content", async () => {
    status = 401;
    settings = { error: "do-not-display-this-upstream-body" };
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.output).toContain("public key is invalid");
    expect(result.output).not.toContain("do-not-display");
  });
  it("does not bind the development app to a public interface", async () => {
    const result = await run({ NEXT_PUBLIC_APP_URL: "http://0.0.0.0:3000" });
    expect(result.code).toBe(1);
    expect(result.output).toContain("local HTTP origin");
  });
});
