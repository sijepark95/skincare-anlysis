import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSetupEnv,
  parseDatabaseUrl,
  postgresOptions,
  validateMigrationHistory,
  validatePolicy,
  writerConnectionUrl,
  validateSetupCurrency,
  validateWriterFunctions,
} from "../scripts/lib/supabase-setup-config.mjs";

const local = "postgresql://postgres:password@127.0.0.1:54322/postgres";
describe("operator-only Supabase setup", () => {
  it("allows only the exact nine writer signatures and refuses overloads or missing grants", () => {
    const functions = [
      "public.write_analysis_result(uuid, uuid, text, text, text, jsonb)",
      "public.persist_recommendations(uuid, uuid, uuid, jsonb)",
      "public.write_experimental_analysis(uuid, uuid, text, text, jsonb, jsonb)",
      "public.complete_recommendation_explanation(uuid, text, text, jsonb, text, text)",
      "public.write_openai_analysis(uuid, uuid, text, text, text, jsonb)",
      "public.write_openai_color_analysis(uuid, uuid, text, jsonb)",
      "public.write_openai_beauty_analysis(uuid, uuid, text, jsonb)",
      "public.write_openai_complete_analysis(uuid, uuid, jsonb, jsonb)",
      "public.persist_complete_recommendations(uuid, uuid, jsonb)",
    ].map((signature) => ({ signature }));
    expect(() => validateWriterFunctions(functions)).not.toThrow();
    for (const invalid of [
      functions.slice(0, 3),
      [...functions, { signature: "public.write_experimental_analysis(uuid)" }],
      [
        ...functions.slice(0, 3),
        {
          signature:
            "private.complete_recommendation_explanation(uuid, text, text, jsonb, text, text)",
        },
      ],
      [functions[0], functions[0], functions[2], functions[3]],
    ])
      expect(() => validateWriterFunctions(invalid)).toThrow(
        "exactly the nine",
      );
  });
  it("reads only ignored runtime/operator files and preserves explicit process overrides", () => {
    const directory = mkdtempSync(join(tmpdir(), "senmiva-setup-"));
    try {
      writeFileSync(
        join(directory, ".env.local"),
        "APP_MODE=supabase\nSAME=runtime\n",
      );
      writeFileSync(
        join(directory, ".env.supabase-admin.local"),
        "SAME=operator\nSUPABASE_ADMIN_DATABASE_URL=local\n",
      );
      writeFileSync(
        join(directory, ".env.example"),
        "EXAMPLE=must-not-be-loaded\n",
      );
      expect(loadSetupEnv(directory, { SAME: "process" })).toEqual({
        APP_MODE: "supabase",
        SAME: "process",
        SUPABASE_ADMIN_DATABASE_URL: "local",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each([
    undefined,
    "https://host",
    "postgresql://postgres@localhost/db",
    "postgresql://postgres:password@localhost",
    "postgresql://postgres:password@localhost/db#fragment",
    `${local}?options=-c+role%3Dpostgres`,
  ])(
    "rejects incomplete or unsafe connection settings without echoing secrets",
    (input) => {
      expect(() => parseDatabaseUrl(input)).toThrow();
      try {
        parseDatabaseUrl(input);
      } catch (error) {
        expect(String(error)).not.toContain("password@");
      }
    },
  );
  it("requires verified TLS remotely and restricts plaintext to recognized local hosts", () => {
    expect(postgresOptions(local).ssl).toBe(false);
    expect(
      postgresOptions(
        "postgresql://postgres:password@db.example.com:5432/postgres?sslmode=disable",
      ).ssl,
    ).toBe("verify-full");
    expect(
      postgresOptions(
        "postgresql://postgres:password@127.0.0.1.example.com:5432/postgres",
      ).ssl,
    ).toBe("verify-full");
  });
  it("uses a supplied certificate without disabling certificate verification", () => {
    const directory = mkdtempSync(join(tmpdir(), "senmiva-ca-"));
    try {
      writeFileSync(join(directory, "root.pem"), "test-root-certificate");
      expect(
        postgresOptions(
          "postgresql://postgres:password@db.example.com:5432/postgres",
          { SUPABASE_DATABASE_CA_FILE: "root.pem" },
          directory,
        ).ssl,
      ).toEqual({ ca: "test-root-certificate", rejectUnauthorized: true });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("applies only a known migration prefix and rejects gaps/unknown history", () => {
    const migrations = [
      { version: "001" },
      { version: "002" },
      { version: "003" },
    ];
    expect(validateMigrationHistory(["001"], migrations)).toEqual(
      migrations.slice(1),
    );
    expect(validateMigrationHistory(["001", "002", "003"], migrations)).toEqual(
      [],
    );
    for (const applied of [
      ["002"],
      ["001", "003"],
      ["001", "001"],
      ["001", "002", "003", "004"],
    ])
      expect(() => validateMigrationHistory(applied, migrations)).toThrow(
        "known Senmiva prefix",
      );
  });
  it("preserves direct/session endpoint and converts pooler role names correctly", () => {
    const direct = new URL(
      writerConnectionUrl(local, "senmiva_analysis_login", "a@b:c#d"),
    );
    expect(direct.username).toBe("senmiva_analysis_login");
    expect(decodeURIComponent(direct.password)).toBe("a@b:c#d");
    const pooled = new URL(
      writerConnectionUrl(
        "postgresql://postgres.projectref:password@aws-1-region.pooler.supabase.com:5432/postgres",
        "senmiva_analysis_login",
        "secret",
      ),
    );
    expect(pooled.username).toBe("senmiva_analysis_login.projectref");
    expect(pooled.port).toBe("5432");
    expect(() => writerConnectionUrl(local, "postgres", "secret")).toThrow();
  });
  it("rejects unsupported store currencies before provisioning", () => {
    expect(validateSetupCurrency()).toBe("USD");
    expect(validateSetupCurrency(" usd ")).toBe("USD");
    for (const currency of ["KRW", "EUR", "", "US"])
      expect(() => validateSetupCurrency(currency)).toThrow("USD stores only");
  });
  it("requires deliberate mock policy review and rejects duplicate/invalid ingredient rules", () => {
    const valid = {
      reviewed: true,
      mockOnly: true,
      version: 1,
      rules: [{ concern: "texture", ingredient: "Niacinamide", relevance: 2 }],
    };
    expect(validatePolicy(valid)).toEqual(valid);
    for (const invalid of [
      { ...valid, reviewed: false },
      { ...valid, mockOnly: false },
      { ...valid, version: 0 },
      { ...valid, rules: [] },
      { ...valid, rules: [...valid.rules, ...valid.rules] },
      {
        ...valid,
        rules: [{ concern: "acne", ingredient: "Niacinamide", relevance: 3 }],
      },
      { ...valid, rules: [{ ...valid.rules[0], relevance: 4 }] },
      { ...valid, extra: true },
    ])
      expect(() => validatePolicy(invalid)).toThrow();
  });
});
