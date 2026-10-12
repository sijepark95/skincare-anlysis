/** Repeatable local production-BFF -> real FastAPI smoke check. No cloud data. */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const root = process.cwd();
const python =
  process.env.SENMIVA_PYTHON ||
  path.join(
    root,
    "services",
    "analysis",
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
if (!existsSync(python))
  throw new Error(
    "Create services/analysis/.venv first, or set SENMIVA_PYTHON to its Python executable.",
  );
async function available(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}
await available(3200);
await available(8000);
// Generated only in process memory, never printed, written to disk or shell text.
const key = randomBytes(32).toString("hex");
const children = [];
let output = "";
function launch(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-8000);
    });
  return child;
}
async function ready(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Local smoke servers did not become ready.");
}
try {
  launch(
    python,
    [
      "-m",
      "uvicorn",
      "senmiva_analysis.main:app",
      "--app-dir",
      "src",
      "--host",
      "127.0.0.1",
      "--port",
      "8000",
      "--no-access-log",
    ],
    {
      cwd: path.join(root, "services", "analysis"),
      env: { ...process.env, ANALYSIS_API_KEY: key, ANALYSIS_PROVIDER: "mock" },
    },
  );
  await ready("http://127.0.0.1:8000/healthz");
  const origin = "http://127.0.0.1:3200";
  launch(
    process.execPath,
    [
      path.join(root, "node_modules", "next", "dist", "bin", "next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3200",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "production",
        APP_MODE: "demo",
        NEXT_PUBLIC_APP_URL: origin,
        ANALYSIS_SERVICE_URL: "http://127.0.0.1:8000",
        ANALYSIS_API_KEY: key,
        DEMO_CATALOG_PATH: path.join(
          tmpdir(),
          `senmiva-smoke-${randomUUID()}`,
          "catalog.json",
        ),
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  );
  await ready(origin + "/api/v1/healthz");
  let cookie = "";
  async function request(route, method = "GET", body) {
    const response = await fetch(origin + "/api/v1/" + route, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = response.headers.getSetCookie();
    if (set.length) cookie = set.map((value) => value.split(";")[0]).join("; ");
    return { status: response.status, data: await response.json() };
  }
  const started = await request("kiosk/sessions", "POST", {});
  assert.equal(started.status, 201);
  const id = started.data.id;
  assert.equal(
    (await request(`kiosk/sessions/${id}/consent`, "POST", { accepted: true }))
      .status,
    200,
  );
  assert.equal(
    (
      await request(`kiosk/sessions/${id}/answers`, "PUT", {
        skinType: "dry",
        concerns: ["dehydration", "texture"],
        excludedIngredients: ["Parfum"],
        sensitive: false,
      })
    ).status,
    200,
  );
  const result = await request(`kiosk/sessions/${id}/analysis`, "POST", {});
  assert.equal(result.status, 200);
  assert.equal(result.data.analysis.model_version, "mock-1.0");
  assert.equal(result.data.analysis.mode, "mock");
  assert.ok(result.data.recommendations.length > 0);
  assert.ok(
    result.data.recommendations.every(
      (item) => !item.product.ingredients.includes("Parfum"),
    ),
  );
  assert.equal(
    (await request(`kiosk/sessions/${id}/finish`, "POST", {})).status,
    200,
  );
  assert.equal((await request(`kiosk/sessions/${id}`)).status, 404);
  console.log(
    "PASS production Next.js -> real FastAPI mock -> ingredient recommendations -> session purge",
  );
} catch (error) {
  console.error(output.replaceAll(key, "[redacted]"));
  throw error;
} finally {
  for (const child of children.reverse()) child.kill();
}
