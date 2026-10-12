import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
export default defineConfig({
  testDir: ".",
  testMatch: "photo-ui.spec.mjs",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  outputDir: path.join(root, "test-results/ml-photo-ui"),
  use: {
    baseURL: "http://127.0.0.1:8876",
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command: "node ml/tests/browser/start-fixture.mjs",
    cwd: root,
    url: "http://127.0.0.1:8876/api/model",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
