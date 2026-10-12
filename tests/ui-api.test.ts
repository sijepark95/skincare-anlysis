import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/ui/api";

afterEach(() => vi.unstubAllGlobals());

describe("browser API failure handling", () => {
  it("offers a retry after a network failure without exposing browser details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("PRIVATE NETWORK DETAILS")),
    );
    await expect(api("auth/login")).rejects.toMatchObject({
      code: "network_unavailable",
      status: 0,
      message:
        "Unable to connect. Check your internet connection and try again.",
    });
  });

  it("handles an HTML proxy failure without showing parsing or server contents", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>PRIVATE PROXY DETAILS</html>", { status: 503 }),
        ),
    );
    await expect(api("device/pair")).rejects.toMatchObject({
      code: "invalid_response",
      status: 503,
      message:
        "The service could not complete this request. Try again shortly.",
    });
  });

  it("preserves an expired staff session error so the workspace can return to login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: {
              code: "sign_in_required",
              message: "Please sign in to your workspace.",
            },
          },
          { status: 401 },
        ),
      ),
    );
    await expect(api("management/overview")).rejects.toMatchObject({
      code: "sign_in_required",
      status: 401,
      message: "Please sign in to your workspace.",
    });
  });

  it("uses a safe fallback for a malformed JSON error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json(null, { status: 502 })),
    );
    await expect(api("auth/login")).rejects.toMatchObject({
      code: "request_failed",
      status: 502,
      message: "The request could not be completed.",
    });
  });
});
