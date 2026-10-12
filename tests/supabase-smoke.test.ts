import { describe, expect, it, vi } from "vitest";
import {
  cleanupSmokeFixtures,
  assertCapturedMailTransport,
  liveSmokeConfig,
  SmokeCookieJar,
} from "../scripts/supabase-smoke.mjs";

const configured = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "local-publishable-key",
  SUPABASE_SERVICE_ROLE_KEY: "local-admin-test-key",
  SUPABASE_ADMIN_DATABASE_URL:
    "postgresql://postgres:local-test-password@127.0.0.1:54322/postgres",
  ANALYSIS_DATABASE_URL:
    "postgresql://senmiva_analysis:local-writer-password@127.0.0.1:54322/postgres",
};
const fixtures = [
  {
    orgId: "11111111-1111-4111-8111-111111111111",
    name: "Senmiva smoke generated-test-tenant A",
  },
  {
    orgId: "22222222-2222-4222-8222-222222222222",
    name: "Senmiva smoke generated-test-tenant B",
  },
];

describe("fixture email delivery boundary", () => {
  const root = process.cwd();
  const localAuth = {
    Name: "/supabase_auth_senmiva",
    Config: {
      Labels: {
        "com.supabase.cli.project": "senmiva",
        "com.supabase.cli.workdir": root,
      },
      Env: [
        "GOTRUE_SMTP_HOST=supabase_inbucket_senmiva",
        "GOTRUE_SMTP_PORT=1025",
        "GOTRUE_SMTP_PASS=private-test-value",
      ],
    },
  };
  it("allows only the owned local captured-mail transport", () => {
    expect(() =>
      assertCapturedMailTransport(localAuth, "senmiva", root),
    ).not.toThrow();
  });
  it.each(["smtp.resend.com", "smtp.gmail.com", "supabase_inbucket_other"])(
    "refuses signup fixtures against %s without exposing SMTP secrets",
    (host) => {
      const container = structuredClone(localAuth);
      container.Config.Env[0] = `GOTRUE_SMTP_HOST=${host}`;
      expect(() =>
        assertCapturedMailTransport(container, "senmiva", root),
      ).toThrow(/captured email transport/);
      try {
        assertCapturedMailTransport(container, "senmiva", root);
      } catch (error) {
        expect(String(error)).not.toContain("private-test-value");
      }
    },
  );
  it("refuses missing settings or another workspace even with a local host", () => {
    expect(() => assertCapturedMailTransport({}, "senmiva", root)).toThrow();
    expect(() =>
      assertCapturedMailTransport(localAuth, "senmiva", "other-workspace"),
    ).toThrow();
  });
});

describe("live Supabase smoke safety boundary", () => {
  it("accepts local API and matching local administrator/writer connections", () => {
    expect(liveSmokeConfig(configured).apiUrl).toBe("http://127.0.0.1:54321");
  });

  it.each([
    ["NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co"],
    ["NEXT_PUBLIC_SUPABASE_URL", "http://localhost.example.com:54321"],
    ["NEXT_PUBLIC_SUPABASE_URL", "http://user:password@localhost:54321"],
    ["NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321/?redirect=remote"],
    [
      "SUPABASE_ADMIN_DATABASE_URL",
      "postgresql://postgres:secret@remote.example/postgres",
    ],
    [
      "ANALYSIS_DATABASE_URL",
      "postgresql://writer:secret@host.docker.internal/postgres",
    ],
  ])("refuses fixture writes for an unsafe %s", (name, value) => {
    expect(() => liveSmokeConfig({ ...configured, [name]: value })).toThrow(
      /loopback-only/,
    );
  });

  it("refuses mismatched local databases", () => {
    expect(() =>
      liveSmokeConfig({
        ...configured,
        ANALYSIS_DATABASE_URL: configured.ANALYSIS_DATABASE_URL.replace(
          "/postgres",
          "/another",
        ),
      }),
    ).toThrow(/same database/);
  });

  it("does not expose secret connection strings in malformed-configuration errors", () => {
    const secret = "not-a-url-with-private-password";
    try {
      liveSmokeConfig({ ...configured, SUPABASE_ADMIN_DATABASE_URL: secret });
      throw new Error("Expected invalid configuration to fail.");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe("live Auth cookie handling", () => {
  it("preserves independent staff cookies when device cookies refresh or expire", () => {
    const jar = new SmokeCookieJar();
    jar.update([
      "senmiva-staff.0=staff-part-0; HttpOnly; Secure",
      "senmiva-staff.1=staff-part-1; HttpOnly; Secure",
      "senmiva-device.0=old-device; HttpOnly; Secure",
    ]);
    jar.update([
      "senmiva-device.0=new-device; HttpOnly; Secure",
      "senmiva-device-unpaired=; Max-Age=0; HttpOnly",
    ]);
    expect(jar.header()).toBe(
      "senmiva-staff.0=staff-part-0; senmiva-staff.1=staff-part-1; senmiva-device.0=new-device",
    );
    jar.update(["senmiva-device.0=old-device; Max-Age=0; HttpOnly"]);
    expect(jar.header()).not.toContain("senmiva-device");
    expect(jar.header()).toContain("senmiva-staff.1=staff-part-1");
  });

  it("decodes only the requested namespace and orders cookie chunks numerically", () => {
    const jar = new SmokeCookieJar();
    const session =
      "base64-" +
      Buffer.from(
        JSON.stringify({
          access_token: "device-token-for-test-only",
        }),
      ).toString("base64url");
    const chunks = session.match(/.{1,6}/g)!;
    jar.update([
      "senmiva-device-unpaired=this-marker-is-not-an-auth-session",
      ...chunks
        .map((chunk, index) => `senmiva-device.${index}=${chunk}; HttpOnly`)
        .reverse(),
      `senmiva-staff=${JSON.stringify({ access_token: "staff-token-for-test-only" })}; HttpOnly`,
    ]);
    expect(jar.accessToken("senmiva-device")).toBe(
      "device-token-for-test-only",
    );
    expect(jar.accessToken("senmiva-staff")).toBe("staff-token-for-test-only");
    expect(jar.accessToken("missing")).toBeNull();
  });
});

describe("disposable local tenant cleanup", () => {
  function sqlHarness(
    rows = fixtures.map((fixture) => ({
      id: fixture.orgId,
      name: fixture.name,
    })),
  ) {
    const transaction = Object.assign(
      vi.fn(async (input: unknown) =>
        Array.isArray(input) && "raw" in input ? rows : input,
      ),
      { unsafe: vi.fn(async () => []) },
    );
    const sql = {
      begin: vi.fn(
        async (callback: (tx: typeof transaction) => Promise<void>) =>
          callback(transaction),
      ),
    };
    return { sql, transaction };
  }

  it("uses a transaction-local bypass and exact generated tenant filters for every delete", async () => {
    const { sql, transaction } = sqlHarness();
    await cleanupSmokeFixtures(sql, fixtures);
    expect(sql.begin).toHaveBeenCalledOnce();
    const calls = transaction.unsafe.mock.calls as unknown as [
      string,
      unknown[] | undefined,
    ][];
    expect(calls[0]).toEqual(["set local session_replication_role = replica"]);
    expect(calls.length).toBeGreaterThan(25);
    for (const [statement, parameters] of calls.slice(1)) {
      expect(statement).toMatch(
        /^delete from public\.[a-z_]+ where (org_id|id) = any\(\$1::uuid\[\]\)$/,
      );
      expect(parameters).toEqual([fixtures.map((fixture) => fixture.orgId)]);
    }
  });

  it("refuses invalid identities before opening a cleanup transaction", async () => {
    const { sql } = sqlHarness();
    await expect(
      cleanupSmokeFixtures(sql, [
        { ...fixtures[0], orgId: "not-a-generated-uuid" },
        fixtures[1],
      ]),
    ).rejects.toThrow(/Refusing cleanup/);
    expect(sql.begin).not.toHaveBeenCalled();
  });

  it("refuses changed tenant ownership before bypassing triggers or deleting rows", async () => {
    const { sql, transaction } = sqlHarness([
      { id: fixtures[0].orgId, name: "A real retail company" },
    ]);
    await expect(cleanupSmokeFixtures(sql, fixtures)).rejects.toThrow(
      /ownership changed/,
    );
    expect(transaction.unsafe).not.toHaveBeenCalled();
  });
});
