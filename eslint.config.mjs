import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // Apostrophes in English JSX text are intentional. Local/blob camera previews
  // must use native images so no optimization server ever receives a guest photo.
  { rules: { "react/no-unescaped-entities": "off" } },
  {
    files: ["src/ui/kiosk.tsx"],
    rules: { "@next/next/no-img-element": "off" },
  },
  globalIgnores([
    ".next/**",
    ".next-development/**",
    ".next-e2e/**",
    "next-env.d.ts",
    "services/**",
  ]),
]);
