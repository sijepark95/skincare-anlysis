import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/** Every API is intercepted by these specs: no provider, email or live data mutation. */
export default defineConfig({
  ...base,
  testMatch: ["beauty-kiosk.spec.ts", "beauty-saved-legacy.spec.ts"],
  use: { ...base.use, baseURL: "http://127.0.0.1:3000" },
  webServer: undefined,
});
