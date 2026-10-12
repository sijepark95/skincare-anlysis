import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import path from "node:path";

const baseURL = "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./tests/e2e",
  // A second attempted run must not delete another run's screenshots/traces.
  outputDir: `./test-results/run-${process.pid}`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    baseURL,
    browserName: "chromium",
    viewport: { width: 1024, height: 768 },
    permissions: ["camera"],
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 3100",
    url: `${baseURL}/api/v1/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      APP_MODE: "demo",
      NEXT_PUBLIC_APP_URL: baseURL,
      ANALYSIS_SERVICE_URL: "",
      ANALYSIS_PROVIDER: "mock",
      EXPLANATION_PROVIDER: "disabled",
      OPENAI_API_KEY: "",
      DEMO_CATALOG_PATH: path.join(
        tmpdir(),
        `senmiva-e2e-${process.pid}`,
        "catalog.json",
      ),
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_DIST_DIR: ".next-e2e",
    },
  },
});
