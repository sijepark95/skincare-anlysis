/** Saved local models -> real Next BFF -> demo store -> kiosk. Never calls Auth or SMTP. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { connectedAnalysisConfig } from "./lib/connected-analysis-config.mjs";

const root = process.cwd();
const config = connectedAnalysisConfig(root, {
  ...process.env,
  ANALYSIS_PROVIDER: "experimental",
});
const appOrigin = "http://127.0.0.1:3111";
const inferenceOrigin = "http://127.0.0.1:8101";
const temp = await mkdtemp(path.join(tmpdir(), "senmiva-model-smoke-"));
const nextOutput = path.join(
  root,
  ".local",
  "ml-audit",
  `next-model-smoke-${process.pid}`,
);
const children = [];
const key = randomBytes(32).toString("hex");
let browser;
let failed = false;

async function available(port) {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => listener.close(resolve));
}
function launch(command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  // Keep service diagnostic bodies/paths private; errors below are authored messages only.
  child.stdout.resume();
  child.stderr.resume();
  child.on("error", () => {
    failed = true;
  });
  child.on("exit", () => {
    failed = true;
  });
}
async function ready(url, mode) {
  for (let attempt = 0; attempt < 300 && !failed; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1000),
        redirect: "error",
      });
      if (response.ok && (!mode || (await response.json()).mode === mode))
        return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    "The isolated experimental smoke services did not become ready.",
  );
}
async function preferences(page) {
  await page.getByRole("button", { name: "Let's get started" }).click();
  await page
    .getByRole("checkbox", { name: /I agree to this temporary session/ })
    .check();
  await page.getByRole("button", { name: "I agree, let's begin" }).click();
  await page
    .getByRole("button", { name: /Dry Often feels tight or dry/ })
    .click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Hydration", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue to photo" }).click();
}
try {
  await available(3111);
  await available(8101);
  const serviceEnv = {
    ...process.env,
    ...config.inference,
    ANALYSIS_API_KEY: key,
    PYTHONPATH: config.pythonPath,
  };
  for (const name of [
    "ANALYSIS_DATABASE_URL",
    "SUPABASE_ADMIN_DATABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SECRET_KEY",
  ])
    delete serviceEnv[name];
  launch(
    config.python,
    [
      "-m",
      "uvicorn",
      "senmiva_analysis.main:app",
      "--host",
      "127.0.0.1",
      "--port",
      "8101",
      "--no-access-log",
    ],
    serviceEnv,
  );
  await ready(inferenceOrigin + "/healthz", "experimental");
  process.stdout.write(
    "Saved visual and ingredient models loaded. Starting isolated kiosk.\n",
  );
  launch(
    process.execPath,
    [
      path.join(root, "node_modules/next/dist/bin/next"),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3111",
    ],
    {
      ...process.env,
      APP_MODE: "demo",
      ANALYSIS_PROVIDER: "experimental",
      NEXT_PUBLIC_APP_URL: appOrigin,
      ANALYSIS_SERVICE_URL: inferenceOrigin,
      ANALYSIS_API_KEY: key,
      DEMO_CATALOG_PATH: path.join(temp, "catalog.json"),
      NEXT_DIST_DIR: path.relative(root, nextOutput),
      NEXT_TELEMETRY_DISABLED: "1",
    },
  );
  await ready(appOrigin + "/api/v1/healthz");
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1024, height: 768 },
  });
  const page = await context.newPage();
  const pageErrors = [];
  const uploads = [];
  page.on("pageerror", (error) => pageErrors.push(error.name));
  page.on("request", (request) => {
    assert.ok(
      !/\/auth\/|\/management\/(signup|login|verify|resend)/.test(
        request.url(),
      ),
      "Smoke must not call Auth or email endpoints.",
    );
    if (request.method() === "POST" && request.url().endsWith("/analysis"))
      uploads.push(request.headers()["content-type"]);
  });
  await page.goto(appOrigin + "/kiosk");
  await preferences(page);
  const generated = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d");
    context.fillStyle = "#D9CCD9";
    context.fillRect(0, 0, 256, 256);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic.png",
    mimeType: "image/png",
    buffer: Buffer.from(generated, "base64"),
  });
  await expect(
    page.getByRole("button", { name: "Analyze my photo" }),
  ).toBeEnabled();
  assert.equal(uploads.length, 0);
  const resultResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/analysis"),
  );
  await page.getByRole("button", { name: "Analyze my photo" }).click();
  const response = await resultResponse;
  assert.equal(response.status(), 200);
  const result = await response.json();
  assert.equal(result.analysis.mode, "experimental");
  assert.equal(result.analysis.visual.heads.length, 8);
  assert.ok(result.analysis.ingredients.candidates.length > 0);
  const photoCoverage = result.analysis.ingredients.input_coverage;
  const usedPhoto = photoCoverage.includes(
    "visual_condition_used_source_contract_v1",
  );
  assert.ok(photoCoverage.includes("source_code_contract_aihub71886_v1"));
  assert.ok(photoCoverage.includes("combined_pipeline_not_validated"));
  assert.ok(
    usedPhoto ||
      photoCoverage.includes("visual_condition_unseen_in_training_omitted"),
  );
  assert.ok(result.recommendations.length > 0);
  assert.equal(uploads[0], "image/png");
  await expect(page.locator(".model-output-grid article")).toHaveCount(8);
  await expect(page.getByText(/Experimental results/)).toBeVisible();
  if (usedPhoto)
    await expect(
      page.getByText("Photo-informed ingredient ranking", { exact: true }),
    ).toBeVisible();
  assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, []);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  await mkdir(path.join(root, ".local/ml-audit"), { recursive: true });
  await page.screenshot({
    path: path.join(root, ".local/ml-audit/kiosk-model-1024.png"),
    fullPage: true,
  });
  for (const viewport of [
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, []);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      true,
    );
    await page.screenshot({
      path: path.join(
        root,
        `.local/ml-audit/kiosk-model-${viewport.width}.png`,
      ),
      fullPage: true,
    });
    if (viewport.width === 390)
      await page.locator(".ingredient-candidates").screenshot({
        path: path.join(root, ".local/ml-audit/kiosk-ingredients-390.png"),
      });
  }
  await page.getByRole("button", { name: "Finish & clear session" }).click();
  await expect(
    page.getByRole("button", { name: "Let's get started" }),
  ).toBeVisible();
  assert.equal(
    (
      await page.request.get(appOrigin + `/api/v1/kiosk/sessions/${result.id}`)
    ).status(),
    404,
  );
  assert.equal(
    await page.locator('img[alt="Your temporary photo preview"]').count(),
    0,
  );
  await preferences(page);
  const withoutPhoto = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/analysis"),
  );
  await page.getByRole("button", { name: "Continue without a photo" }).click();
  const questionnaire = await withoutPhoto;
  assert.equal(questionnaire.status(), 200);
  const questionnaireResult = await questionnaire.json();
  assert.equal(questionnaireResult.analysis.mode, "experimental");
  assert.equal(questionnaireResult.analysis.visual, null);
  assert.ok(questionnaireResult.analysis.ingredients.candidates.length > 0);
  assert.ok(
    questionnaireResult.analysis.ingredients.input_coverage.includes(
      "no_photo_questionnaire_only",
    ),
  );
  assert.ok(
    !questionnaireResult.analysis.ingredients.input_coverage.includes(
      "visual_condition_used_source_contract_v1",
    ),
  );
  if (usedPhoto)
    assert.notDeepEqual(
      result.analysis.ingredients.candidates,
      questionnaireResult.analysis.ingredients.candidates,
    );
  else
    assert.deepEqual(
      result.analysis.ingredients.candidates,
      questionnaireResult.analysis.ingredients.candidates,
    );
  await page.getByRole("button", { name: "Finish & clear session" }).click();
  assert.deepEqual(pageErrors, []);
  process.stdout.write(
    `PASS real saved models -> private FastAPI -> Next kiosk photo -> 8 outputs -> ${usedPhoto ? "photo-informed" : "explicit unseen-combination omission"} ingredient ranking -> eligible demo-store products -> clear; questionnaire-only comparison, axe and overflow at 1024/768/390px pass. No Auth or email calls.\n`,
  );
} finally {
  if (browser) await browser.close();
  for (const child of children.reverse()) child.kill();
  // This exact folder was allocated above by mkdtemp; never delete repository paths.
  if (
    path.dirname(temp) === path.resolve(tmpdir()) &&
    path.basename(temp).startsWith("senmiva-model-smoke-")
  )
    await rm(temp, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 300,
    }).catch(() => undefined);
  if (
    path.dirname(nextOutput) === path.join(root, ".local", "ml-audit") &&
    path.basename(nextOutput) === `next-model-smoke-${process.pid}`
  )
    await rm(nextOutput, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 300,
    }).catch(() => undefined);
}
