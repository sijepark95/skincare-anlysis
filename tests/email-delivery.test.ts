import { describe, expect, it } from "vitest";
import { authEmailDelivery } from "@/infrastructure/email-delivery";

const local = {
  AUTH_EMAIL_DELIVERY: "local",
  AUTH_EMAIL_INBOX_URL: "http://127.0.0.1:15434",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:15431",
  NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
};

describe("public auth email delivery metadata", () => {
  it("exposes the local inbox only for an explicitly local Supabase installation", () => {
    expect(authEmailDelivery("supabase", local)).toEqual({
      mode: "local",
      inboxUrl: "http://127.0.0.1:15434",
    });
    expect(authEmailDelivery("demo", local)).toEqual({ mode: "unknown" });
  });

  it("does not infer email delivery from localhost or missing configuration", () => {
    expect(authEmailDelivery("supabase", {})).toEqual({ mode: "unknown" });
    expect(
      authEmailDelivery("supabase", {
        ...local,
        AUTH_EMAIL_DELIVERY: undefined,
      }),
    ).toEqual({ mode: "unknown" });
    expect(
      authEmailDelivery("supabase", { ...local, AUTH_EMAIL_DELIVERY: "auto" }),
    ).toEqual({ mode: "unknown" });
  });

  it("publishes only the configured SMTP mode, never server credentials", () => {
    expect(
      authEmailDelivery("supabase", {
        ...local,
        AUTH_EMAIL_DELIVERY: "smtp",
        SMTP_PASSWORD: "test-not-a-real-secret",
        SMTP_HOST: "smtp.example.test",
      }),
    ).toEqual({ mode: "smtp" });
    expect(
      authEmailDelivery("demo", { ...local, AUTH_EMAIL_DELIVERY: "smtp" }),
    ).toEqual({ mode: "unknown" });
  });

  it.each(["http://localhost:15434/", "https://[::1]:15434"])(
    "allows a plain loopback origin: %s",
    (inboxUrl) => {
      expect(
        authEmailDelivery("supabase", {
          ...local,
          AUTH_EMAIL_INBOX_URL: inboxUrl,
        }),
      ).toEqual({ mode: "local", inboxUrl: new URL(inboxUrl).origin });
    },
  );

  it.each([
    undefined,
    "",
    "not a URL",
    "https://mail.example.test",
    "http://localhost.example.test:15434",
    "http://192.168.1.2:15434",
    "ftp://127.0.0.1:15434",
    "javascript:alert(1)",
    "http://user:password@127.0.0.1:15434",
    "http://127.0.0.1:15434/inbox",
    "http://127.0.0.1:15434/a/..",
    "http://127.0.0.1:15434?code=secret",
    "http://127.0.0.1:15434?",
    "http://127.0.0.1:15434#code",
    "http://127.0.0.1:15434#",
    " http://127.0.0.1:15434",
    "http://local\thost:15434",
  ])(
    "hides local inbox metadata when any configured origin is unsafe: %s",
    (bad) => {
      for (const name of [
        "AUTH_EMAIL_INBOX_URL",
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_APP_URL",
      ]) {
        expect(
          authEmailDelivery("supabase", { ...local, [name]: bad }),
        ).toEqual({ mode: "unknown" });
      }
    },
  );
});
