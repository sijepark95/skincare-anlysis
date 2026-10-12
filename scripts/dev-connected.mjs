/** Local connected development. Secrets stay in environment, never command arguments. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { connectedAnalysisConfig } from "./lib/connected-analysis-config.mjs";
import { inferenceEnvironment } from "./lib/inference-environment.mjs";

const root = process.cwd();
if (existsSync(path.join(root, ".env.local")))
  process.loadEnvFile(path.join(root, ".env.local"));
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in .env.local first.`);
  return value;
}
function loopback(url) {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}
function launch(command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    windowsHide: true,
    stdio: "inherit",
  });
  children.push(child);
  child.on("error", () => {
    process.stderr.write(
      "A development service could not start. Check its installation.\n",
    );
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
  return child;
}
async function available(port, host) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch {
    throw new Error(
      `Port ${port} is occupied. Stop its server or change the local URL.`,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
async function healthy(url, provider) {
  try {
    const response = await fetch(new URL("/healthz", url), {
      signal: AbortSignal.timeout(750),
      redirect: "error",
    });
    return response.ok && (await response.json()).mode === provider;
  } catch {
    return false;
  }
}
try {
  if (process.argv.slice(2).some((arg) => arg !== "--check"))
    throw new Error("Usage: npm run dev:connected [-- --check]");
  if (required("APP_MODE") !== "supabase")
    throw new Error(
      "Set APP_MODE=supabase in .env.local. Use npm run dev for the standalone demo.",
    );
  const app = new URL(required("NEXT_PUBLIC_APP_URL"));
  const supabase = new URL(required("NEXT_PUBLIC_SUPABASE_URL"));
  required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  required("ANALYSIS_DATABASE_URL");
  const analysis = new URL(required("ANALYSIS_SERVICE_URL"));
  const key = required("ANALYSIS_API_KEY");
  if (key.length < 32 || /replace|example|placeholder/i.test(key))
    throw new Error(
      "Generate a new ANALYSIS_API_KEY with at least 32 characters.",
    );
  if (
    !loopback(app) ||
    app.protocol !== "http:" ||
    app.pathname !== "/" ||
    app.username ||
    app.password
  )
    throw new Error(
      "Connected development needs a local HTTP origin, such as http://127.0.0.1:3000.",
    );
  if (!loopback(supabase) && supabase.protocol !== "https:")
    throw new Error("Hosted Supabase must use HTTPS.");
  if (
    !loopback(analysis) ||
    analysis.protocol !== "http:" ||
    analysis.pathname !== "/" ||
    analysis.username ||
    analysis.password
  )
    throw new Error(
      "This local runner needs ANALYSIS_SERVICE_URL=http://127.0.0.1:8000. Deploy remote inference separately.",
    );
  const analysisConfig = connectedAnalysisConfig(root);
  const authSettings = await fetch(new URL("/auth/v1/settings", supabase), {
    headers: { apikey: required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") },
    signal: AbortSignal.timeout(8000),
    redirect: "error",
  }).catch(() => null);
  if (!authSettings?.ok)
    throw new Error(
      "Supabase Auth is unreachable or the public key is invalid. Check the project URL, key and project status.",
    );
  const settings = await authSettings.json();
  if (settings.external?.email !== true)
    throw new Error(
      "Enable the Email provider in Supabase Auth so existing staff can sign in. Control new account creation with the Before User Created hook.",
    );
  if (settings.disable_signup || settings.external?.anonymous_users !== true)
    throw new Error(
      "Enable anonymous sign-ins and allow new users in Supabase Auth; workspace permissions are granted only through verified onboarding or staff membership.",
    );
  if (settings.captcha_enabled)
    throw new Error(
      "This MVP does not yet submit CAPTCHA tokens. Use a separate development project without Auth CAPTCHA; production CAPTCHA integration is still required if enabled.",
    );
  if (process.argv.includes("--check")) {
    process.stdout.write(
      `Connected ${analysisConfig.provider} configuration and Supabase Auth settings passed. No services started.${analysisConfig.provider === "experimental" ? " Model weights are validated at service startup." : ""} Run npm run supabase:check to verify the database setup.\n`,
    );
  } else {
    const port = Number(app.port || "80");
    await available(port, app.hostname);
    // Administrative setup credentials are never forwarded to the application.
    const env = { ...process.env, ANALYSIS_PROVIDER: analysisConfig.provider };
    for (const name of [
      "SUPABASE_ADMIN_DATABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_SECRET_KEY",
      "SUPABASE_DATABASE_CA_FILE",
    ])
      delete env[name];
    if (!(await healthy(analysis, analysisConfig.provider))) {
      await available(Number(analysis.port || "80"), analysis.hostname);
      const inferenceEnv = inferenceEnvironment({
        ...env,
        ...analysisConfig.inference,
        PYTHONPATH: analysisConfig.pythonPath,
      });
      launch(
        analysisConfig.python,
        [
          "-m",
          "uvicorn",
          "senmiva_analysis.main:app",
          "--app-dir",
          "services/analysis/src",
          "--host",
          analysis.hostname,
          "--port",
          analysis.port || "80",
          "--no-access-log",
        ],
        inferenceEnv,
      );
      for (let attempt = 0; attempt < 300 && !stopping; attempt++) {
        if (await healthy(analysis, analysisConfig.provider)) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (stopping || !(await healthy(analysis, analysisConfig.provider)))
      throw new Error(
        "The selected private analysis service did not start. Review its configuration; fallback is disabled.",
      );
    const probe = await fetch(new URL(analysisConfig.endpoint, analysis), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Analysis-Key": key },
      body: JSON.stringify({
        request_id: randomUUID(),
        concern_ids: ["dehydration"],
        skin_type: "unsure",
        sensitive: false,
      }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!probe.ok)
      throw new Error(
        "ANALYSIS_API_KEY does not match the running private service.",
      );
    if ((await probe.json()).mode !== analysisConfig.provider)
      throw new Error(
        "The running analysis service does not match ANALYSIS_PROVIDER. Stop it and restart the selected provider.",
      );
    launch(
      process.execPath,
      [
        path.join(root, "node_modules", "next", "dist", "bin", "next"),
        "dev",
        "--hostname",
        app.hostname,
        "--port",
        String(port),
      ],
      env,
    );
    process.stdout.write(
      `Connected development: ${app.origin}/management/login and ${app.origin}/kiosk/pair\n`,
    );
    process.on("SIGINT", () => stop());
    process.on("SIGTERM", () => stop());
  }
} catch (error) {
  // Only authored messages, never database URLs, credentials or upstream bodies.
  process.stderr.write(
    `${error instanceof TypeError ? "A configured URL or service response is invalid. Check .env.local." : error.message}\n`,
  );
  stop(1);
}
