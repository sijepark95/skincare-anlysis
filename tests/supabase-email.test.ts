import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkLocalEmail,
  ensureConfiguredEmail,
  prepareLocalEmailConfig,
  readLocalEmailConfig,
  replaceAuthEmail,
} from "../scripts/supabase-email.mjs";
import {
  assertOwnedAuth,
  authEnvironment,
  emailDeliveryMetadata,
  localEmailTemplate,
  smtpEnvironment,
  smtpReplacementConfig,
  validateEmailConfig,
} from "../scripts/lib/supabase-email-config.mjs";

const temporary: string[] = [];
const originalId = "a".repeat(64);
const replacementId = "b".repeat(64);
const privateValue = "re_synthetic_private_value_for_tests";
const values = {
  SMTP_ENABLED: "true",
  SMTP_HOST: "smtp.resend.com",
  SMTP_PORT: "465",
  SMTP_USER: "resend",
  SMTP_PASS: privateValue,
  SMTP_FROM: "onboarding@resend.dev",
  SMTP_SENDER_NAME: "Senmiva",
  SMTP_TEST_RECIPIENT: "operator@example.com",
};
const gmailValues = {
  ...values,
  SMTP_HOST: "smtp.gmail.com",
  SMTP_USER: "operator@gmail.com",
  SMTP_PASS: "abcd efgh ijkl mnop",
  SMTP_FROM: "",
  SMTP_TEST_RECIPIENT: "",
};

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "senmiva-email-test-"));
  temporary.push(root);
  await mkdir(path.join(root, "supabase"));
  await writeFile(
    path.join(root, "supabase", "config.toml"),
    'project_id = "senmiva"\n[local_smtp]\nport = 15434\n',
  );
  return root;
}

afterEach(async () => {
  for (const root of temporary.splice(0)) {
    if (!path.basename(root).startsWith("senmiva-email-test-"))
      throw new Error("Refusing unfamiliar test cleanup target");
    await rm(root, { recursive: true, force: true });
  }
});

function ownedAuth(root = path.resolve("test-workspace")) {
  return {
    Id: originalId,
    Image: "sha256:existing-auth-image",
    Name: "/supabase_auth_senmiva",
    Config: {
      Image: "supabase/gotrue:installed-version",
      Env: [
        "GOTRUE_SMTP_HOST=supabase_inbucket_senmiva",
        "GOTRUE_SMTP_PORT=1025",
        "GOTRUE_JWT_SECRET=existing_private_auth_secret",
      ],
      Labels: {
        "com.supabase.cli.project": "senmiva",
        "com.docker.compose.project": "senmiva",
        "com.supabase.cli.workdir": root,
      },
      Healthcheck: {
        Test: ["CMD-SHELL", "wget --spider http://127.0.0.1:9999/health"],
      },
    },
    HostConfig: {
      NetworkMode: "senmiva-local",
      PortBindings: {} as Record<
        string,
        { HostIp: string; HostPort: string }[]
      >,
      Privileged: false,
      AutoRemove: false,
      PublishAllPorts: false,
      RestartPolicy: { Name: "unless-stopped" },
      Binds: [] as string[],
      Mounts: [] as {
        Type: string;
        Source: string;
        Target: string;
        ReadOnly: boolean;
      }[],
    },
    Mounts: [] as {
      Type: string;
      Name?: string;
      Source?: string;
      Destination: string;
      RW: boolean;
    }[],
    NetworkSettings: {
      Ports: { "9999/tcp": null } as Record<
        string,
        { HostIp: string; HostPort: string }[] | null
      >,
      Networks: {
        "senmiva-local": {
          Aliases: ["supabase_auth_senmiva"],
          IPAddress: "172.25.0.3",
          IPAMConfig: null,
        },
      } as Record<
        string,
        {
          Aliases: string[];
          IPAddress: string;
          IPAMConfig: null | { IPv4Address: string };
        }
      >,
    },
    State: { Running: true, Health: { Status: "healthy" } },
  };
}

function fakeEngine(
  root: string,
  failReplacement = false,
  failRecovery = false,
) {
  const entries = new Map<string, ReturnType<typeof ownedAuth>>([
    [originalId, ownedAuth(root)],
  ]);
  const calls: { method: string; route: string; body?: unknown }[] = [];
  const engine = async (
    method: string,
    route: string,
    body?: Record<string, unknown>,
  ) => {
    calls.push({ method, route, body });
    if (method === "GET" && route.endsWith("/changes")) return [];
    if (method === "GET" && route.endsWith("/json")) {
      const id = route.split("/")[2];
      const entry =
        entries.get(id) ||
        [...entries.values()].find((value) => value.Name === `/${id}`);
      if (!entry) throw new Error("Missing synthetic Auth container");
      return structuredClone(entry);
    }
    if (route.startsWith("/containers/create")) {
      const snapshot = structuredClone(body) as Record<string, unknown> & {
        HostConfig: ReturnType<typeof ownedAuth>["HostConfig"];
        NetworkingConfig: {
          EndpointsConfig: ReturnType<
            typeof ownedAuth
          >["NetworkSettings"]["Networks"];
        };
      };
      const next = ownedAuth(root);
      next.Id = replacementId;
      next.Config = snapshot as unknown as typeof next.Config;
      next.HostConfig = snapshot.HostConfig;
      next.NetworkSettings.Networks = snapshot.NetworkingConfig.EndpointsConfig;
      next.State.Running = false;
      entries.set(replacementId, next);
      return { Id: replacementId };
    }
    if (route.includes("/disconnect")) {
      const current = entries.get(String(body?.Container))!;
      delete current.NetworkSettings.Networks["senmiva-local"];
      return;
    }
    if (route.includes("/connect")) {
      entries.get(String(body?.Container))!.NetworkSettings.Networks[
        "senmiva-local"
      ] = body?.EndpointConfig as ReturnType<
        typeof ownedAuth
      >["NetworkSettings"]["Networks"][string];
      return;
    }
    const id = route.split("/")[2].split("?")[0];
    const current = entries.get(id);
    if (!current) throw new Error("Unexpected synthetic engine route");
    if (method === "DELETE") {
      entries.delete(id);
      return;
    }
    if (route.includes("/stop")) {
      current.State.Running = false;
      return;
    }
    if (route.includes("/rename")) {
      current.Name = `/${new URL(route, "http://engine.test").searchParams.get("name")}`;
      return;
    }
    if (route.includes("/start")) {
      if (
        (id === replacementId && failReplacement) ||
        (id === originalId && failRecovery)
      )
        throw new Error(
          `Synthetic upstream failure containing ${privateValue}`,
        );
      current.State.Running = true;
      current.State.Health.Status = "healthy";
      return;
    }
    throw new Error("Unexpected synthetic mutation");
  };
  return { engine, calls, entries };
}

describe("private SMTP settings", () => {
  it("creates a disabled private profile once and preserves subsequent edits", async () => {
    const root = await workspace();
    expect(await prepareLocalEmailConfig(root)).toEqual({ created: true });
    expect(
      await readFile(path.join(root, ".env.supabase-mail.local"), "utf8"),
    ).toBe(localEmailTemplate);
    expect(localEmailTemplate).toContain("SMTP_HOST=smtp.gmail.com");
    expect(localEmailTemplate).toContain(
      "SMTP_PASS=REPLACE_WITH_GOOGLE_APP_PASSWORD",
    );
    expect(await readLocalEmailConfig(root)).toEqual({ enabled: false });
    await writeFile(
      path.join(root, ".env.supabase-mail.local"),
      "SMTP_ENABLED=false\n# existing operator edit\n",
    );
    expect(await prepareLocalEmailConfig(root)).toEqual({ created: false });
    expect(
      await readFile(path.join(root, ".env.supabase-mail.local"), "utf8"),
    ).toContain("existing operator edit");
  });

  it("requires explicit enablement and accepts the supported encrypted ports", () => {
    expect(validateEmailConfig({ SMTP_ENABLED: "false" })).toEqual({
      enabled: false,
    });
    expect(validateEmailConfig(values)).toMatchObject({
      enabled: true,
      port: "465",
      resendTestSender: true,
    });
    expect(validateEmailConfig({ ...values, SMTP_PORT: "587" })).toMatchObject({
      enabled: true,
      port: "587",
    });
    expect(() =>
      validateEmailConfig({ ...values, SMTP_ENABLED: "yes" }),
    ).toThrow(/true or false/);
  });

  it.each([
    { SMTP_PORT: "25" },
    { SMTP_HOST: "127.0.0.1" },
    { SMTP_HOST: "https://smtp.resend.com" },
    { SMTP_HOST: "smtp.internal" },
    { SMTP_PASS: "REPLACE_WITH_RESEND_API_KEY" },
    { SMTP_PASS: `${privateValue}\nINJECTED=true` },
    { SMTP_FROM: "Name <operator@example.com>" },
    { SMTP_TEST_RECIPIENT: "" },
    { SMTP_TEST_RECIPIENT: "invalid-email" },
    { SMTP_SENDER_NAME: "Senmiva\r\nBcc: attacker@example.com" },
    { SMTP_UNKNOWN: privateValue },
  ])(
    "rejects incomplete or unsafe configuration without exposing values",
    (change) => {
      try {
        validateEmailConfig({ ...values, ...change });
        throw new Error("Expected validation rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/^Local email /);
        expect((error as Error).message).not.toContain(privateValue);
      }
    },
  );

  it("does not require a test recipient for a verified custom sender", () => {
    expect(
      validateEmailConfig({
        ...values,
        SMTP_FROM: "accounts@senmiva.example",
        SMTP_TEST_RECIPIENT: "",
      }),
    ).toMatchObject({ enabled: true, resendTestSender: false });
  });

  it("normalizes Google's displayed App Password spaces and derives the Gmail sender", () => {
    const configured = validateEmailConfig(gmailValues);
    expect(configured).toMatchObject({
      enabled: true,
      host: "smtp.gmail.com",
      username: "operator@gmail.com",
      password: "abcdefghijklmnop",
      from: "operator@gmail.com",
      testRecipient: "",
      resendTestSender: false,
    });
    expect(smtpEnvironment(configured)).toMatchObject({
      GOTRUE_SMTP_ADMIN_EMAIL: "operator@gmail.com",
      GOTRUE_SMTP_PASS: "abcdefghijklmnop",
    });
  });

  it("supports Google Workspace account domains and matching explicit sender", () => {
    expect(
      validateEmailConfig({
        ...gmailValues,
        SMTP_USER: "accounts@senmiva.example",
        SMTP_FROM: "Accounts@Senmiva.example",
        SMTP_PASS: "AbCd1234EfGh5678",
      }),
    ).toMatchObject({
      enabled: true,
      username: "accounts@senmiva.example",
      from: "Accounts@Senmiva.example",
      password: "AbCd1234EfGh5678",
    });
  });

  it.each([
    { SMTP_USER: "operator" },
    { SMTP_USER: "" },
    { SMTP_PASS: "REPLACE_WITH_GOOGLE_APP_PASSWORD" },
    { SMTP_PASS: "ordinary-password!" },
    { SMTP_PASS: "too-short" },
    { SMTP_PASS: "abcdefghijklmnopq" },
    { SMTP_PASS: "abcd\tefgh ijkl mnop" },
    { SMTP_PASS: "abcd efgh ijkl mnop\n" },
    { SMTP_FROM: "alias@gmail.com" },
  ])("rejects an incomplete or unsupported Gmail setting safely", (change) => {
    try {
      validateEmailConfig({ ...gmailValues, ...change });
      throw new Error("Expected Gmail validation rejection");
    } catch (error) {
      expect((error as Error).message).toMatch(/^Local email Gmail /);
      expect((error as Error).message).not.toContain(gmailValues.SMTP_PASS);
      expect((error as Error).message).not.toContain(gmailValues.SMTP_USER);
    }
  });
});

describe("Auth-only ownership and runtime preservation", () => {
  it("accepts only the exact private local Auth", () => {
    expect(
      assertOwnedAuth(ownedAuth(), "senmiva", path.resolve("test-workspace")),
    ).toBe("supabase_auth_senmiva");
  });

  it("accepts the CLI's exact network ID as well as its project network name", () => {
    const current = ownedAuth();
    const networkId = "c".repeat(64);
    current.HostConfig.NetworkMode = networkId;
    Object.assign(current.NetworkSettings.Networks["senmiva-local"], {
      NetworkID: networkId,
    });
    expect(() =>
      assertOwnedAuth(current, "senmiva", path.resolve("test-workspace")),
    ).not.toThrow();
    current.HostConfig.NetworkMode = "d".repeat(64);
    expect(() =>
      assertOwnedAuth(current, "senmiva", path.resolve("test-workspace")),
    ).toThrow(/network/);
  });

  it.each([
    "name",
    "workdir",
    "project",
    "ports",
    "network",
    "privileged",
    "health",
    "mount",
  ])("refuses an unsafe %s before mutation", (change) => {
    const current = ownedAuth();
    if (change === "name") current.Name = "/supabase_db_senmiva";
    if (change === "workdir")
      current.Config.Labels["com.supabase.cli.workdir"] = path.resolve(
        "different-workspace",
      );
    if (change === "project")
      current.Config.Labels["com.supabase.cli.project"] = "different-project";
    if (change === "ports")
      current.HostConfig.PortBindings["9999/tcp"] = [
        { HostIp: "127.0.0.1", HostPort: "9999" },
      ];
    if (change === "network") current.HostConfig.NetworkMode = "host";
    if (change === "privileged") current.HostConfig.Privileged = true;
    if (change === "health") current.Config.Healthcheck.Test = [];
    if (change === "mount")
      current.Mounts.push({
        Type: "volume",
        Name: "unrelated-data",
        Destination: "/data",
        RW: true,
      });
    expect(() =>
      assertOwnedAuth(current, "senmiva", path.resolve("test-workspace")),
    ).toThrow(/^Local email /);
  });

  it("preserves image identity, unrelated secrets, mounts, aliases and exact IP", () => {
    const current = ownedAuth();
    current.Mounts.push({
      Type: "volume",
      Name: "supabase_auth_senmiva",
      Destination: "/data",
      RW: true,
    });
    current.HostConfig.Binds.push(
      `${path.resolve("test-workspace", "template.html")}:/email/template.html:ro`,
    );
    current.Mounts.push({
      Type: "bind",
      Source: path.resolve("test-workspace", "template.html"),
      Destination: "/email/template.html",
      RW: false,
    });
    const replacement = smtpReplacementConfig(
      current,
      validateEmailConfig(values),
    );
    expect(replacement.Image).toBe(current.Image);
    expect(replacement.Env).toContain(
      "GOTRUE_JWT_SECRET=existing_private_auth_secret",
    );
    expect(replacement.Env).not.toContain(
      "GOTRUE_SMTP_HOST=supabase_inbucket_senmiva",
    );
    expect(replacement.Env).toContain("GOTRUE_SMTP_MAX_FREQUENCY=60s");
    expect(replacement.Env).toContain("GOTRUE_RATE_LIMIT_EMAIL_SENT=30");
    expect(replacement.HostConfig.Binds).toEqual(current.HostConfig.Binds);
    expect(replacement.HostConfig.Mounts).toEqual([
      {
        Type: "volume",
        Source: "supabase_auth_senmiva",
        Target: "/data",
        ReadOnly: false,
      },
    ]);
    expect(
      replacement.NetworkingConfig.EndpointsConfig["senmiva-local"],
    ).toMatchObject({
      Aliases: ["supabase_auth_senmiva"],
      IPAMConfig: { IPv4Address: "172.25.0.3" },
    });
    expect(authEnvironment(current).GOTRUE_SMTP_HOST).toBe(
      "supabase_inbucket_senmiva",
    );
  });
});

describe("local SMTP operational transaction", () => {
  it("loads an explicitly enabled private profile and applies it once", async () => {
    const root = await workspace();
    await writeFile(
      path.join(root, ".env.supabase-mail.local"),
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );
    const mock = fakeEngine(root);
    expect(
      await ensureConfiguredEmail(root, {}, { engine: mock.engine }),
    ).toMatchObject({ mode: "smtp", applied: true });
    mock.calls.length = 0;
    expect(
      await ensureConfiguredEmail(root, {}, { engine: mock.engine }),
    ).toEqual({ mode: "smtp", applied: false });
    expect(mock.calls.every((call) => call.method === "GET")).toBe(true);
    expect(await checkLocalEmail(root, {}, { engine: mock.engine })).toEqual({
      configured: true,
      active: "smtp",
      matchesConfiguration: true,
    });
  });

  it.each([
    undefined,
    {},
    false,
    0,
    "",
    "[]",
    [{ Path: "/unfamiliar-data", Kind: 1 }],
  ])(
    "refuses writable or malformed Auth changes before any mutation: %j",
    async (changes) => {
      const root = await workspace();
      const mock = fakeEngine(root);
      const engine = async (
        method: string,
        route: string,
        body?: Record<string, unknown>,
      ) =>
        route.endsWith("/changes") ? changes : mock.engine(method, route, body);
      await expect(
        replaceAuthEmail(engine, ownedAuth(root), validateEmailConfig(values), {
          root,
          project: "senmiva",
          mailPort: "15434",
        }),
      ).rejects.toThrow(/writable Auth data/);
      expect(mock.calls.every((call) => call.method === "GET")).toBe(true);
      expect(mock.entries.get(originalId)?.State.Running).toBe(true);
    },
  );

  it("leaves disabled delivery untouched and exposes only verified local inbox metadata", async () => {
    const root = await workspace();
    await writeFile(
      path.join(root, ".env.local"),
      "PRIVATE_EXISTING=preserve-me\n",
    );
    const mock = fakeEngine(root);
    expect(
      await ensureConfiguredEmail(root, {}, { engine: mock.engine }),
    ).toEqual({
      mode: "local",
      inboxUrl: "http://127.0.0.1:15434",
      applied: false,
    });
    expect(mock.calls.every((call) => call.method === "GET")).toBe(true);
    const runtime = await readFile(path.join(root, ".env.local"), "utf8");
    expect(runtime).toContain("PRIVATE_EXISTING=preserve-me");
    expect(runtime).toContain('AUTH_EMAIL_DELIVERY="local"');
    expect(runtime).not.toContain(privateValue);
  });

  it.each([null, []])(
    "accepts empty Docker changes %j and applies only Auth while preserving database/mailbox containers",
    async (changes) => {
      const root = await workspace();
      const mock = fakeEngine(root);
      const engine = async (
        method: string,
        route: string,
        body?: Record<string, unknown>,
      ) =>
        route.endsWith("/changes") ? changes : mock.engine(method, route, body);
      const result = await replaceAuthEmail(
        engine,
        ownedAuth(root),
        validateEmailConfig(values),
        { root, project: "senmiva", mailPort: "15434" },
      );
      expect(result).toEqual({
        mode: "smtp",
        applied: true,
        backupPreserved: false,
      });
      expect(mock.entries.has(originalId)).toBe(false);
      expect(mock.entries.get(replacementId)?.State.Running).toBe(true);
      // A random Auth backup-name suffix can contain "db". Check actual
      // Docker resources and names rather than matching query substrings.
      for (const call of mock.calls) {
        const route = new URL(call.route, "http://engine.test");
        const [, resource, identity] = route.pathname.split("/");
        expect(
          (resource === "containers" &&
            [originalId, replacementId, "create"].includes(identity)) ||
            (resource === "networks" && identity === "senmiva-local"),
        ).toBe(true);
        const name = route.searchParams.get("name");
        if (name !== null)
          expect(name).toMatch(
            /^supabase_auth_senmiva(?:_smtp_backup_[a-f0-9]{8})?$/,
          );
      }
      expect(
        mock.calls
          .filter((call) => call.method === "DELETE")
          .every((call) => call.route.endsWith("v=false")),
      ).toBe(true);
      const runtime = await readFile(path.join(root, ".env.local"), "utf8");
      expect(runtime).toContain('AUTH_EMAIL_DELIVERY="smtp"');
      expect(runtime).toContain('AUTH_EMAIL_INBOX_URL=""');
      expect(runtime).not.toContain(privateValue);
      expect(runtime).not.toContain(values.SMTP_TEST_RECIPIENT);
    },
  );

  it("rolls back the original running Auth and keeps runtime notices unchanged on failure", async () => {
    const root = await workspace();
    const runtime =
      'AUTH_EMAIL_DELIVERY="local"\nPRIVATE_EXISTING=preserve-me\n';
    await writeFile(path.join(root, ".env.local"), runtime);
    const mock = fakeEngine(root, true);
    await expect(
      replaceAuthEmail(
        mock.engine,
        ownedAuth(root),
        validateEmailConfig(values),
        { root, project: "senmiva", mailPort: "15434" },
      ),
    ).rejects.toThrow("original Auth configuration was restored");
    expect(mock.entries.has(replacementId)).toBe(false);
    expect(mock.entries.get(originalId)).toMatchObject({
      Name: "/supabase_auth_senmiva",
      State: { Running: true },
    });
    expect(authEnvironment(mock.entries.get(originalId))).toMatchObject({
      GOTRUE_SMTP_HOST: "supabase_inbucket_senmiva",
      GOTRUE_JWT_SECRET: "existing_private_auth_secret",
    });
    expect(await readFile(path.join(root, ".env.local"), "utf8")).toBe(runtime);
    expect(
      mock.calls.some(
        (call) => call.method === "DELETE" && call.route.includes(originalId),
      ),
    ).toBe(false);
  });

  it("preserves original container metadata when rollback itself needs recovery", async () => {
    const root = await workspace();
    const mock = fakeEngine(root, true, true);
    await expect(
      replaceAuthEmail(
        mock.engine,
        ownedAuth(root),
        validateEmailConfig(values),
        { root, project: "senmiva", mailPort: "15434" },
      ),
    ).rejects.toThrow("original container and all data volumes were preserved");
    expect(mock.entries.has(originalId)).toBe(true);
    expect(
      mock.calls.some(
        (call) => call.method === "DELETE" && call.route.includes(originalId),
      ),
    ).toBe(false);
  });

  it("reports status without mutations or SMTP credential/recipient fields", async () => {
    const root = await workspace();
    const mock = fakeEngine(root);
    const result = await checkLocalEmail(root, {}, { engine: mock.engine });
    expect(result).toEqual({
      configured: false,
      active: "local",
      matchesConfiguration: null,
    });
    expect(mock.calls.every((call) => call.method === "GET")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(privateValue);
    expect(
      JSON.stringify(
        emailDeliveryMetadata(ownedAuth(root), "senmiva", "15434"),
      ),
    ).not.toContain("SMTP");
    expect(smtpEnvironment(validateEmailConfig(values))).toMatchObject({
      GOTRUE_SMTP_PORT: "465",
    });
  });
});
