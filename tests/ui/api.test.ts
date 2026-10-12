import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/ui/api";

afterEach(() => vi.unstubAllGlobals());

describe("API field feedback", () => {
  it("retains known field messages and discards unknown or malformed metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: {
              code: "invalid_input",
              message: "Correct the highlighted fields.",
              fields: {
                sku: "Use letters and numbers.",
                ingredients: "Review the extracted names.",
                name: 4,
                brand: "B".repeat(501),
                stock: "",
                organizationId: "untrusted",
                __proto__: "untrusted",
              },
            },
          },
          { status: 422 },
        ),
      ),
    );
    const error = await api("management/products").catch(
      (fault: unknown) => fault,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      code: "invalid_input",
      fields: {
        sku: "Use letters and numbers.",
        ingredients: "Review the extracted names.",
      },
    });
    expect(Object.keys((error as ApiError).fields)).toEqual([
      "sku",
      "ingredients",
    ]);
  });
  it.each([null, "untrusted", [], { arbitrary: "untrusted" }])(
    "ignores incompatible field metadata %j",
    async (fields) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            Response.json(
              {
                error: { code: "invalid_input", message: "Try again.", fields },
              },
              { status: 422 },
            ),
          ),
      );
      await expect(api("management/products")).rejects.toMatchObject({
        fields: {},
      });
    },
  );
  it("keeps network failures distinct and sends requests with same-origin credentials", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("network failure"));
    vi.stubGlobal("fetch", fetch);
    await expect(
      api("management/products", { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({
      status: 0,
      code: "network_unavailable",
      fields: {},
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/management/products",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
  });
});
