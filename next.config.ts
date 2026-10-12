import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  // Reusing the installed Turbopack development disk cache can replay stale
  // HMR hashes after a restart. In-memory compilation still supports refresh.
  experimental: { turbopackFileSystemCacheForDev: false },
  output: process.env.NEXT_OUTPUT_STANDALONE === "1" ? "standalone" : undefined,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};
export default function nextConfig(phase: string): NextConfig {
  // MediaPipe performs local detection but its upstream SDK can attempt metrics
  // POSTs. Block all external browser connections, including on documents that
  // later navigate to the kiosk through a client-side Link. Auth and inference
  // already use the same-origin BFF; server-side provider calls are unaffected.
  let developmentSocket = "";
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    const app = new URL(
      process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3000",
    );
    if (
      ["http:", "https:"].includes(app.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(app.hostname)
    ) {
      app.protocol = app.protocol === "https:" ? "wss:" : "ws:";
      developmentSocket = ` ${app.origin}`;
    }
  }
  return {
    ...config,
    async headers() {
      const rules = await config.headers!();
      return rules.map((rule) => ({
        ...rule,
        headers: [
          ...rule.headers,
          {
            key: "Content-Security-Policy",
            value: `connect-src 'self'${developmentSocket}; object-src 'none'; base-uri 'self'`,
          },
        ],
      }));
    },
    // A production build owns and can clear its output directory. Keep the
    // running development server's cache separate so its HMR state survives.
    distDir:
      process.env.NEXT_DIST_DIR ||
      (phase === PHASE_DEVELOPMENT_SERVER ? ".next-development" : ".next"),
  };
}
