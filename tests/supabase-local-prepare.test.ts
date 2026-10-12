import { describe, expect, it } from "vitest";
import {
  assertLocalPrepareTarget,
  updateLocalEnv,
} from "../scripts/supabase-local-prepare.mjs";

const status = {
  API_URL: "http://127.0.0.1:15431",
  DB_URL: "postgresql://postgres:local-password@127.0.0.1:15432/postgres",
  PUBLISHABLE_KEY: "local-public-key",
  SERVICE_ROLE_KEY: "local-admin-key",
};

describe("local preparation overwrite guard", () => {
  it("accepts a fresh workspace or the same local stack", () => {
    expect(assertLocalPrepareTarget(status).apiUrl).toBe(status.API_URL);
    expect(() =>
      assertLocalPrepareTarget(
        status,
        { NEXT_PUBLIC_SUPABASE_URL: status.API_URL },
        { SUPABASE_ADMIN_DATABASE_URL: status.DB_URL },
      ),
    ).not.toThrow();
  });

  it.each([
    [{ NEXT_PUBLIC_SUPABASE_URL: "https://production.supabase.co" }, {}],
    [{ NEXT_PUBLIC_APP_URL: "https://shop.example.com" }, {}],
    [
      {
        ANALYSIS_DATABASE_URL:
          "postgresql://writer:secret@remote.example/postgres",
      },
      {},
    ],
    [
      {},
      {
        SUPABASE_ADMIN_DATABASE_URL:
          "postgresql://postgres:secret@remote.example/postgres",
      },
    ],
    [{ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }, {}],
    [{ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "another-project-key" }, {}],
    [{}, { SUPABASE_SERVICE_ROLE_KEY: "another-project-administrator-key" }],
    [
      {},
      { SUPABASE_ADMIN_DATABASE_URL: status.DB_URL.replace("15432", "54322") },
    ],
  ])(
    "refuses a hosted or different project's environment",
    (runtime, administrator) => {
      expect(() =>
        assertLocalPrepareTarget(status, runtime, administrator),
      ).toThrow(/refus|overwrite/i);
    },
  );

  it("refuses status information that points at a remote project", () => {
    expect(() =>
      assertLocalPrepareTarget({
        ...status,
        DB_URL: "postgresql://postgres:secret@remote.example/postgres",
      }),
    ).toThrow(/remote database/);
    expect(() =>
      assertLocalPrepareTarget({
        ...status,
        API_URL: "https://project.supabase.co",
      }),
    ).toThrow(/remote/);
  });

  it("preserves unrelated settings and only replaces requested environment entries", () => {
    const original =
      "# Approved local configuration\nAPP_MODE=demo\nANALYSIS_API_KEY=existing-approved-key\nNEXT_PUBLIC_HERO_VIDEO_URL=/media/senmiva-hero.mp4\n";
    const updated = updateLocalEnv(original, {
      APP_MODE: "supabase",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
    });
    expect(updated).toContain('APP_MODE="supabase"');
    expect(updated).toContain("ANALYSIS_API_KEY=existing-approved-key");
    expect(updated).toContain("# Approved local configuration");
    expect(updated).toContain(
      "NEXT_PUBLIC_HERO_VIDEO_URL=/media/senmiva-hero.mp4",
    );
    expect(
      updateLocalEnv(updated, {
        APP_MODE: "supabase",
        NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
      }),
    ).toBe(updated);
  });
});
