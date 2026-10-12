import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/application/contracts";

afterEach(() => vi.resetModules());

describe("application error identity", () => {
  it("recognizes the missing-session error from a demo adapter retained through a module reload", async () => {
    const { DemoRepository } = await import("@/infrastructure/demo-repository");
    const before = await import("@/application/contracts");
    const retained = new DemoRepository(false);
    const device = retained.ensureDevice("app-error-reload-test");
    const session = await retained.start(device);
    await retained.finish(session.id, device);

    vi.resetModules();
    const after = await import("@/application/contracts");
    expect(after.AppError).not.toBe(before.AppError);
    const fault: unknown = await retained
      .session(session.id, device)
      .catch((error: unknown) => error);
    expect(fault).toBeInstanceOf(after.AppError);
    if (!(fault instanceof after.AppError))
      throw new Error("Unrecognized AppError");
    expect(fault.status).toBe(404);
    expect(fault.code).toBe("session_not_found");
  });

  it("does not trust JSON-shaped or unbranded upstream errors", () => {
    const shape = {
      status: 404,
      code: "session_not_found",
      message: "Upstream detail must remain private.",
    };
    expect(shape).not.toBeInstanceOf(AppError);
    expect(Object.assign(new Error(shape.message), shape)).not.toBeInstanceOf(
      AppError,
    );
    const error = new AppError(404, "session_not_found", "Consultation ended.");
    expect(JSON.parse(JSON.stringify(error))).not.toBeInstanceOf(AppError);
  });

  it.each([399, 600, 400.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects branded errors with an invalid HTTP status: %s",
    (status) => {
      expect(
        new AppError(status, "invalid_status", "Test message"),
      ).not.toBeInstanceOf(AppError);
    },
  );

  it.each([
    "",
    "UPSTREAM_ERROR",
    "invalid-code",
    "code with spaces",
    "a".repeat(81),
  ])(
    "rejects branded errors with an unsafe or oversized public code: %s",
    (code) => {
      expect(new AppError(400, code, "Test message")).not.toBeInstanceOf(
        AppError,
      );
    },
  );

  it("requires an own data brand and string message without invoking accessors", () => {
    const valid = new AppError(
      422,
      "invalid_input",
      "Check the submitted fields.",
    );
    expect(valid).toBeInstanceOf(AppError);
    const brand = Reflect.ownKeys(valid).find(
      (key) => typeof key === "symbol",
    )!;
    const inheritedBrand = Object.assign(
      new Error("Private upstream message"),
      {
        status: 422,
        code: "invalid_input",
      },
    );
    Object.setPrototypeOf(inheritedBrand, valid);
    expect(inheritedBrand).not.toBeInstanceOf(AppError);

    const nonString = new AppError(422, "invalid_input", "Test message");
    Object.defineProperty(nonString, "message", { value: 42 });
    expect(nonString).not.toBeInstanceOf(AppError);

    const getter = vi.fn(() => true);
    const accessorBrand = Object.assign(new Error("Test message"), {
      status: 422,
      code: "invalid_input",
    });
    Object.defineProperty(accessorBrand, brand, { get: getter });
    expect(accessorBrand).not.toBeInstanceOf(AppError);
    expect(getter).not.toHaveBeenCalled();
  });
});
