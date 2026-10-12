/** Live local Supabase/Auth + production BFF + private FastAPI acceptance test.
 * Fixture writes are deliberately forbidden against remote projects. Secrets are
 * read from ignored environment files and passed to children only in memory.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { chromium, expect as browserExpect } from "@playwright/test";
import postgres from "postgres";
import {
  loadSetupEnv,
  parseDatabaseUrl,
  postgresOptions,
} from "./lib/supabase-setup-config.mjs";
import {
  capturedSignupCode,
  cleanupSmokeMail,
  localMailOrigin,
} from "./lib/supabase-smoke-mail.mjs";
import { dockerEngine, engineSocket } from "./supabase-local-start.mjs";

const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const capturedCommand = promisify(execFile);

/** Fixture signup must never send test mail through an external provider. */
export function assertCapturedMailTransport(container, project, root) {
  const labels = container.Config?.Labels ?? {};
  const environment = Object.fromEntries(
    (container.Config?.Env ?? []).map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
  if (
    container.Name !== `/supabase_auth_${project}` ||
    labels["com.supabase.cli.project"] !== project ||
    path.resolve(labels["com.supabase.cli.workdir"] || "") !==
      path.resolve(root) ||
    environment.GOTRUE_SMTP_HOST !== `supabase_inbucket_${project}` ||
    environment.GOTRUE_SMTP_PORT !== "1025"
  )
    throw new Error(
      "Local fixture tests require this workspace's captured email transport. External SMTP is active or the Auth container cannot be verified; no signup mail was sent.",
    );
}

async function verifyCapturedMailTransport(root, env) {
  const project = readFileSync(
    path.join(root, "supabase", "config.toml"),
    "utf8",
  ).match(/^project_id\s*=\s*"([a-zA-Z0-9_-]+)"/m)?.[1];
  if (!project) throw new Error("Local email transport project is invalid.");
  let container;
  try {
    let endpoint = env.DOCKER_HOST;
    if (!endpoint) {
      const { stdout } = await capturedCommand(
        "docker",
        ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
        { cwd: root, env, windowsHide: true, maxBuffer: 65536, timeout: 10000 },
      );
      endpoint = JSON.parse(stdout);
    }
    const engine = dockerEngine(engineSocket(endpoint));
    container = await engine(
      "GET",
      `/containers/supabase_auth_${project}/json`,
    );
  } catch {
    throw new Error(
      "Local email transport could not be verified; no signup mail was sent.",
    );
  }
  assertCapturedMailTransport(container, project, root);
}

/** Do not broaden this allowlist to gateways, remote hosts, or arbitrary DNS. */
export function liveSmokeConfig(env) {
  const required = (name) => {
    if (!env[name]?.trim())
      throw new Error(`Configure ${name} before the live Supabase test.`);
    return env[name].trim();
  };
  let api;
  try {
    api = new URL(required("NEXT_PUBLIC_SUPABASE_URL"));
  } catch {
    throw new Error("Configure a valid local NEXT_PUBLIC_SUPABASE_URL.");
  }
  const admin = parseDatabaseUrl(required("SUPABASE_ADMIN_DATABASE_URL"));
  const writer = parseDatabaseUrl(
    required("ANALYSIS_DATABASE_URL"),
    "ANALYSIS_DATABASE_URL",
  );
  if (
    api.protocol !== "http:" ||
    !loopback.has(api.hostname) ||
    api.username ||
    api.password ||
    api.search ||
    api.hash ||
    api.pathname !== "/" ||
    !loopback.has(admin.hostname) ||
    !loopback.has(writer.hostname)
  )
    throw new Error(
      "Live fixture tests require loopback-only local Supabase API, admin, and writer connections. Remote projects are refused.",
    );
  if (admin.host !== writer.host || admin.pathname !== writer.pathname)
    throw new Error(
      "Local admin and restricted writer connections must target the same database.",
    );
  return {
    apiUrl: api.origin,
    publishableKey: required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    serviceKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    adminUrl: admin.toString(),
    writerUrl: writer.toString(),
  };
}

/** Keep chunked Supabase cookies and the independent staff/device jars intact. */
export class SmokeCookieJar {
  values = new Map();
  update(headers) {
    for (const header of headers) {
      const pair = header.split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (/;\s*max-age=0(?:;|$)/i.test(header) || value === "")
        this.values.delete(name);
      else this.values.set(name, value);
    }
  }
  header() {
    return [...this.values]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
  accessToken(namespace) {
    const unchunked = this.values.get(namespace);
    const value =
      unchunked ??
      [...this.values]
        .filter(([name]) => new RegExp(`^${namespace}\\.\\d+$`).test(name))
        .sort(
          ([a], [b]) =>
            Number(a.split(".").at(-1)) - Number(b.split(".").at(-1)),
        )
        .map(([, part]) => part)
        .join("");
    if (!value) return null;
    try {
      const raw = value.startsWith("base64-")
        ? Buffer.from(value.slice(7), "base64url").toString()
        : value;
      const session = JSON.parse(raw);
      return typeof session.access_token === "string"
        ? session.access_token
        : null;
    } catch {
      return null;
    }
  }
}

const fixtureTables = [
  "session_complete_preview_slots",
  "session_complete_preview_plans",
  "session_complete_preview_consents",
  "session_complete_photo_consents",
  "session_complete_analysis_attempts",
  "session_complete_guest_context",
  "session_complete_skin_concerns",
  "session_complete_skin_profiles",
  "session_complete_base_choices",
  "session_complete_saved_guides",
  "complete_beauty_saved_products",
  "complete_beauty_saved_guides",
  "store_weekly_beauty_demographics",
  "cosmetic_variant_shades",
  "cosmetic_color_details",
  "cosmetic_base_details",
  "cosmetic_shade_versions",
  "recommendation_item_reasons",
  "recommendation_item_ingredients",
  "recommendation_items",
  "recommendation_runs",
  "observations",
  "analyses",
  "session_excluded_ingredients",
  "session_concerns",
  "consents",
  "kiosk_sessions",
  "audit_events",
  "store_daily_metrics",
  "device_pairing_codes",
  "devices",
  "membership_stores",
  "memberships",
  "store_listings",
  "variant_formulations",
  "unresolved_formulation_ingredients",
  "formulation_skin_types",
  "formulation_ingredients",
  "formulation_versions",
  "product_variants",
  "products",
  "brands",
  "categories",
  "concern_ingredient_rules",
  "recommendation_policy_versions",
  "stores",
];

/** Only the generated fixture UUIDs may reach cleanup. Transaction-local trigger
 * bypass lets the local test dispose its immutable published snapshots without
 * changing shared triggers or weakening runtime roles. Rollback resets the GUC.
 */
export async function cleanupSmokeFixtures(sql, fixtures) {
  if (
    fixtures.length !== 2 ||
    fixtures.some(
      (f) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          f.orgId,
        ) || !f.name.startsWith("Senmiva smoke "),
    )
  )
    throw new Error(
      "Refusing cleanup without two generated smoke tenant identities.",
    );
  await sql.begin(async (transaction) => {
    const rows =
      await transaction`select id,name from public.organizations where id in ${transaction(fixtures.map((f) => f.orgId))} for update`;
    for (const row of rows) {
      const fixture = fixtures.find((f) => f.orgId === row.id);
      if (!fixture || fixture.name !== row.name)
        throw new Error("Smoke fixture ownership changed; cleanup refused.");
    }
    await transaction.unsafe("set local session_replication_role = replica");
    for (const table of fixtureTables)
      await transaction.unsafe(
        `delete from public.${table} where org_id = any($1::uuid[])`,
        [fixtures.map((f) => f.orgId)],
      );
    await transaction.unsafe(
      "delete from public.organizations where id = any($1::uuid[])",
      [fixtures.map((f) => f.orgId)],
    );
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function ready(url, children) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (children.some((child) => child.exitCode !== null))
      throw new Error(
        "A local acceptance-test server stopped before becoming ready.",
      );
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(700) })).ok) return;
    } catch {
      /* service is still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Local acceptance-test servers did not become ready.");
}

export async function runSupabaseSmoke(
  root = process.cwd(),
  inherited = process.env,
) {
  const env = loadSetupEnv(root, inherited);
  const config = liveSmokeConfig(env);
  await verifyCapturedMailTransport(root, env);
  const mailOrigin = localMailOrigin(
    readFileSync(path.join(root, "supabase", "config.toml"), "utf8"),
  );
  const python =
    env.SENMIVA_PYTHON ||
    path.join(
      root,
      "services",
      "analysis",
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
  if (!existsSync(python))
    throw new Error(
      "Create services/analysis/.venv or configure SENMIVA_PYTHON first.",
    );
  if (!existsSync(path.join(root, ".next", "BUILD_ID")))
    throw new Error(
      "Build the application before running the live Supabase test.",
    );
  const sql = postgres(
    config.adminUrl,
    postgresOptions(config.adminUrl, env, root),
  );
  const admin = createClient(config.apiUrl, config.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const fixtures = ["A", "B"].map((suffix) => ({
    orgId: randomUUID(),
    storeId: randomUUID(),
    policyId: randomUUID(),
    name: `Senmiva smoke ${randomUUID()} ${suffix}`,
    email: `senmiva-smoke-${randomUUID()}@example.test`,
    password: `Aa1!${randomBytes(32).toString("hex")}`,
  }));
  const users = new Set();
  const fixtureEmails = new Set(fixtures.map((fixture) => fixture.email));
  const jars = [];
  const children = [];
  let browser;
  let browserContext;
  let browserCookies;
  let provisioned = false;
  let failed = false;
  const analysisKey = randomBytes(32).toString("hex");
  const origin = `http://127.0.0.1:${await freePort()}`;
  const analysisOrigin = `http://127.0.0.1:${await freePort()}`;
  // Child output can contain database connection errors. Never forward it: report
  // the failing stage only. Test passwords, tokens and connection strings stay private.
  function launch(command, args, options) {
    const child = spawn(command, args, {
      ...options,
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", () => {
      failed = true;
    });
    children.push(child);
  }
  function jar() {
    const value = new SmokeCookieJar();
    jars.push(value);
    return value;
  }
  async function request(cookies, route, method = "GET", body, expected = 200) {
    const response = await fetch(`${origin}/api/v1/${route}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookies.header(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = response.headers.getSetCookie();
    cookies.update(set);
    const data = await response.json();
    const code = /^[a-z_]{1,60}$/.test(data?.error?.code ?? "")
      ? ` (${data.error.code})`
      : "";
    assert.equal(
      response.status,
      expected,
      `${method} ${route} returned status ${response.status}${code}; expected ${expected}.`,
    );
    return { data, set };
  }
  async function rest(token, route, options = {}) {
    return fetch(`${config.apiUrl}${route}`, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        apikey: config.publishableKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
    });
  }
  async function rememberDeviceUser(cookies) {
    const token = cookies.accessToken("senmiva-device");
    if (!token) return;
    const response = await rest(token, "/auth/v1/user");
    assert.equal(
      response.status,
      200,
      "The actual Auth server must verify the device JWT.",
    );
    const user = await response.json();
    assert.equal(user.is_anonymous, true);
    users.add(user.id);
  }
  try {
    // Verify cleanup support before creating any disposable fixture snapshots.
    await sql.begin(async (transaction) => {
      await transaction.unsafe("set local session_replication_role = replica");
    });
    // Tenant A comes from the public owner UI below. Tenant B exercises the
    // existing administrator-created account/provisioning path independently.
    for (const fixture of fixtures.slice(1)) {
      const created = await admin.auth.admin.createUser({
        email: fixture.email,
        password: fixture.password,
        email_confirm: true,
      });
      if (created.error || !created.data.user)
        throw new Error(
          "Local Auth administrator could not create a disposable acceptance-test user.",
        );
      users.add(created.data.user.id);
      fixture.userId = created.data.user.id;
    }
    await sql.begin(async (transaction) => {
      for (const fixture of fixtures.slice(1)) {
        await transaction`insert into public.organizations(id,name) values(${fixture.orgId},${fixture.name})`;
        await transaction`insert into public.stores(id,org_id,name,currency) values(${fixture.storeId},${fixture.orgId},'Smoke Beauty Studio','USD')`;
        await transaction`insert into public.memberships(org_id,user_id,role) values(${fixture.orgId},${fixture.userId},'owner')`;
        await transaction`insert into public.recommendation_policy_versions(id,org_id,version) values(${fixture.policyId},${fixture.orgId},1)`;
        const inserted =
          await transaction`insert into public.concern_ingredient_rules(org_id,policy_version_id,concern_id,ingredient_id,relevance)
          select ${fixture.orgId},${fixture.policyId},c.id,i.id,3 from public.concerns c cross join public.ingredients i where c.slug='dehydration' and i.inci_name='Glycerin' returning policy_version_id`;
        assert.equal(
          inserted.length,
          1,
          "Apply the reference-data migration before the live test.",
        );
        await transaction`update public.recommendation_policy_versions set status='published',published_at=now() where id=${fixture.policyId}`;
      }
    });
    provisioned = true;
    const childBaseEnv = { ...inherited };
    delete childBaseEnv.SUPABASE_SERVICE_ROLE_KEY;
    delete childBaseEnv.SUPABASE_ADMIN_DATABASE_URL;
    launch(
      python,
      [
        "-m",
        "uvicorn",
        "senmiva_analysis.main:app",
        "--app-dir",
        "src",
        "--host",
        "127.0.0.1",
        "--port",
        new URL(analysisOrigin).port,
        "--no-access-log",
      ],
      {
        cwd: path.join(root, "services", "analysis"),
        env: {
          ...childBaseEnv,
          ANALYSIS_API_KEY: analysisKey,
          ANALYSIS_PROVIDER: "mock",
        },
      },
    );
    await ready(`${analysisOrigin}/healthz`, children);
    // Administrator credentials are never handed to either runtime process.
    const nextEnv = {
      ...childBaseEnv,
      NODE_ENV: "production",
      APP_MODE: "supabase",
      NEXT_PUBLIC_APP_URL: origin,
      NEXT_PUBLIC_SUPABASE_URL: config.apiUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: config.publishableKey,
      ANALYSIS_DATABASE_URL: config.writerUrl,
      ANALYSIS_SERVICE_URL: analysisOrigin,
      ANALYSIS_API_KEY: analysisKey,
      NEXT_TELEMETRY_DISABLED: "1",
    };
    delete nextEnv.SUPABASE_SERVICE_ROLE_KEY;
    delete nextEnv.SUPABASE_ADMIN_DATABASE_URL;
    launch(
      process.execPath,
      [
        path.join(root, "node_modules", "next", "dist", "bin", "next"),
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        new URL(origin).port,
      ],
      { cwd: root, env: nextEnv },
    );
    await ready(`${origin}/api/v1/healthz`, children);
    assert.equal(
      failed,
      false,
      "Acceptance-test processes must start successfully.",
    );
    const [a, b] = fixtures;
    const owner = jar();
    const other = jar();
    const fresh = jar();
    await request(fresh, "management/overview", "GET", undefined, 401);
    await request(fresh, "kiosk/sessions", "POST", {}, 401);
    let signupStage = "Chromium owner signup startup";
    try {
      browser = await chromium.launch({ headless: true });
      browserContext = await browser.newContext({
        baseURL: origin,
        viewport: { width: 1024, height: 768 },
      });
      browserCookies = owner;
      const signupPage = await browserContext.newPage();
      signupStage = "owner signup form";
      await signupPage.goto("/management/login");
      signupStage = "owner signup navigation";
      await signupPage.getByRole("link", { name: /Sign up/ }).click();
      await signupPage.waitForURL(`${origin}/management/signup`);
      await browserExpect(
        signupPage.getByRole("heading", { name: "A fresh start." }),
      ).toBeVisible();
      signupStage = "owner signup email input";
      await signupPage.getByLabel("Email address").fill(a.email);
      signupStage = "owner signup password input";
      await signupPage.getByLabel("Password", { exact: true }).fill(a.password);
      signupStage = "owner signup password confirmation input";
      await signupPage.getByLabel("Confirm password").fill(a.password);
      const formState = await signupPage.locator("form").evaluate((form) => {
        const fields = [...form.querySelectorAll("input")];
        const passwords = fields.filter((input) => input.type === "password");
        return {
          invalid: fields
            .filter((input) => !input.validity.valid)
            .map((input) => input.name),
          matching: passwords[0]?.value === passwords[1]?.value,
        };
      });
      if (formState.invalid.length || !formState.matching) {
        signupStage = `owner signup validation ${formState.invalid.join(",") || "password_mismatch"}`;
        throw new Error("Signup form did not contain valid matching fields");
      }
      signupStage = "owner signup submission";
      const [signupResponse] = await Promise.all([
        signupPage.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/v1/auth/signup",
          { timeout: 10000 },
        ),
        signupPage
          .getByRole("button", { name: "Create owner account" })
          .click(),
      ]);
      if (!signupResponse.ok()) {
        const result = await signupResponse.json();
        const code = /^[a-z_]{1,60}$/.test(result?.error?.code ?? "")
          ? result.error.code
          : "request_failed";
        signupStage = `owner signup status ${signupResponse.status()} code ${code}`;
        throw new Error("Signup request failed");
      }
      signupStage = "owner confirmation screen";
      await browserExpect(
        signupPage.getByLabel("Verification code"),
      ).toBeVisible();
      const accounts =
        await sql`select id,email_confirmed_at from auth.users where email=${a.email}`;
      assert.equal(accounts.length, 1);
      a.userId = accounts[0].id;
      users.add(a.userId);
      assert.equal(accounts[0].email_confirmed_at, null);
      assert.equal(
        (
          await sql`select count(*)::integer as total from public.memberships where user_id=${a.userId}`
        )[0].total,
        0,
        "Unconfirmed signup must not create membership authority.",
      );
      assert.equal(
        (await request(fresh, "auth/account")).data.authenticated,
        false,
      );
      await request(
        fresh,
        "auth/login",
        "POST",
        { email: a.email, password: a.password },
        403,
      );
      signupStage = "captured confirmation code and email verification";
      const confirmationCode = await capturedSignupCode(mailOrigin, a.email);
      await request(
        fresh,
        "auth/verify-email",
        "POST",
        {
          email: a.email,
          token: confirmationCode === "000000" ? "000001" : "000000",
        },
        400,
      );
      await signupPage.getByLabel("Verification code").fill(confirmationCode);
      await signupPage.getByRole("button", { name: "Verify email" }).click();
      await signupPage.waitForURL(`${origin}/management/setup`);
      for (const cookie of await browserContext.cookies(origin))
        owner.values.set(cookie.name, cookie.value);
      const confirmed = (await request(owner, "auth/account")).data;
      assert.equal(confirmed.authenticated, true);
      assert.equal(confirmed.needsWorkspace, true);
      assert.equal(confirmed.staff, null);
      await request(owner, "management/overview", "GET", undefined, 401);
      signupStage = "new isolated owner workspace";
      await signupPage.getByLabel("Company name").fill(a.name);
      await signupPage
        .getByLabel("First store name")
        .fill("Smoke Beauty Studio");
      await signupPage
        .getByRole("button", { name: "Create workspace" })
        .click();
      await signupPage.waitForURL(`${origin}/management`);
      for (const cookie of await browserContext.cookies(origin))
        owner.values.set(cookie.name, cookie.value);
      const context = (await request(owner, "context")).data.staff;
      a.orgId = context.organizationId;
      a.storeId = context.stores[0].id;
      assert.notEqual(a.orgId, b.orgId);
      assert.equal(context.role, "owner");
      const createdOrganization =
        await sql`select name from public.organizations where id=${a.orgId}`;
      assert.equal(createdOrganization[0].name, a.name);
      const createdPolicies =
        await sql`select id from public.recommendation_policy_versions where org_id=${a.orgId} and status='published'`;
      assert.equal(createdPolicies.length, 1);
      a.policyId = createdPolicies[0].id;
      assert.equal(
        (
          await sql`select count(*)::integer as total from public.concern_ingredient_rules where org_id=${a.orgId} and policy_version_id=${a.policyId}`
        )[0].total,
        19,
      );
      assert.equal(
        (await request(owner, "auth/account")).data.needsWorkspace,
        false,
      );
      await browser.close();
      browser = undefined;
      browserContext = undefined;
      browserCookies = undefined;
      console.log(
        "PASS real Chromium owner signup: captured email confirmation, isolated workspace and first-store creation",
      );
    } catch {
      throw new Error(`Local browser acceptance failed during ${signupStage}.`);
    }

    // Auth metadata is untrusted. Even direct public signup cannot join an
    // existing tenant or gain owner authority before confirmation/workspace setup.
    const spoofEmail = `senmiva-smoke-${randomUUID()}@example.test`;
    fixtureEmails.add(spoofEmail);
    const publicAuth = createClient(config.apiUrl, config.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const spoof = await publicAuth.auth.signUp({
      email: spoofEmail,
      password: `Aa1!${randomBytes(32).toString("hex")}`,
      options: {
        data: { is_anonymous: true, role: "owner", organization_id: b.orgId },
      },
    });
    if (spoof.data.user) users.add(spoof.data.user.id);
    assert.equal(spoof.error, null);
    assert.equal(spoof.data.session, null);
    assert.equal(spoof.data.user?.is_anonymous, false);
    assert.equal(
      (
        await sql`select count(*)::integer as total from public.memberships where user_id=${spoof.data.user.id}`
      )[0].total,
      0,
    );
    console.log(
      "PASS real Auth owner signup: email confirmation required and forged metadata creates no tenant authority",
    );

    await request(owner, "auth/logout", "POST", {});
    await request(
      owner,
      "auth/login",
      "POST",
      { email: a.email, password: "incorrect-test-password" },
      401,
    );
    const login = await request(owner, "auth/login", "POST", {
      email: a.email,
      password: a.password,
    });
    assert.ok(
      login.set.some(
        (value) =>
          value.startsWith("senmiva-staff") &&
          /HttpOnly/i.test(value) &&
          /SameSite=Lax/i.test(value),
      ),
    );
    await request(other, "auth/login", "POST", {
      email: b.email,
      password: b.password,
    });
    assert.equal(
      (await request(owner, "context")).data.staff.organizationId,
      a.orgId,
    );
    await request(
      owner,
      `management/overview?storeId=${b.storeId}`,
      "GET",
      undefined,
      403,
    );
    console.log(
      "PASS actual Supabase Auth: staff login, secure cookies and verified tenant context",
    );

    const product = {
      sku: "SMOKE-CLEAN",
      brand: "Smoke fixture",
      name: "Smoke Hydrating Serum",
      category: "serum",
      priceMinor: 1200,
      currency: "USD",
      stock: 5,
      visible: false,
      ingredients: ["Water", "Glycerin"],
      formulaComplete: true,
      suitableSkinTypes: ["dry"],
    };
    await request(owner, "management/products", "POST", product, 201);
    await request(
      owner,
      "management/products",
      "POST",
      {
        ...product,
        sku: "SMOKE-EXCLUDED",
        name: "Smoke Scented Serum",
        ingredients: ["Water", "Glycerin", "Parfum"],
      },
      201,
    );
    const catalog = (await request(owner, "management/catalog")).data.products;
    assert.equal(catalog.length, 2);
    for (const item of catalog) {
      await request(
        owner,
        `management/products/${item.id}/publish`,
        "POST",
        {},
      );
      await request(owner, `management/products/${item.id}/listing`, "PATCH", {
        priceMinor: 1200,
        stock: 5,
        visible: true,
      });
    }
    const code = (
      await request(owner, "management/pairing-codes", "POST", {
        label: "Smoke tablet A",
      })
    ).data.code;
    const paired = (await request(owner, "device/pair", "POST", { code })).data;
    await rememberDeviceUser(owner);
    assert.equal(paired.organizationId, a.orgId);
    assert.equal(paired.storeId, a.storeId);
    const both = (await request(owner, "context")).data;
    assert.equal(both.staff.organizationId, a.orgId);
    assert.equal(both.device.deviceId, paired.deviceId);
    await request(fresh, "device/pair", "POST", { code }, 400);
    await rememberDeviceUser(fresh);
    const codeB = (
      await request(other, "management/pairing-codes", "POST", {
        label: "Smoke tablet B",
      })
    ).data.code;
    await request(other, "device/pair", "POST", { code: codeB });
    await rememberDeviceUser(other);
    console.log(
      "PASS actual anonymous Auth: isolated device credentials and single-use pairing codes",
    );

    const staffToken = owner.accessToken("senmiva-staff");
    const deviceToken = owner.accessToken("senmiva-device");
    assert.ok(staffToken && deviceToken && staffToken !== deviceToken);
    const ownOrganizations = await rest(
      staffToken,
      "/rest/v1/organizations?select=id",
    );
    assert.equal(ownOrganizations.status, 200);
    assert.deepEqual(
      (await ownOrganizations.json()).map((row) => row.id),
      [a.orgId],
    );
    const anonymousRead = await rest(null, "/rest/v1/organizations?select=id");
    assert.equal(
      anonymousRead.ok,
      false,
      "The anon role must have no application table access.",
    );
    const directWrite = await rest(staffToken, "/rest/v1/organizations", {
      method: "POST",
      body: JSON.stringify({ name: "Denied direct write" }),
    });
    assert.equal(
      directWrite.ok,
      false,
      "Staff table mutations must go through scoped RPCs.",
    );
    const deviceStaff = await rest(deviceToken, "/rest/v1/rpc/staff_context", {
      method: "POST",
      body: "{}",
    });
    assert.equal(deviceStaff.status, 403);
    const deviceMembers = await rest(
      deviceToken,
      "/rest/v1/memberships?select=id",
    );
    assert.equal(deviceMembers.status, 200);
    assert.deepEqual(await deviceMembers.json(), []);

    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(owner, "kiosk/sessions", "POST", {}, 201),
      ),
    );
    const id = concurrent[0].data.id;
    assert.ok(
      concurrent.every((result) => result.data.id === id),
      "Concurrent starts must reuse one active device session.",
    );
    await request(other, `kiosk/sessions/${id}`, "GET", undefined, 403);
    await request(owner, `kiosk/sessions/${id}/consent`, "POST", {
      accepted: true,
    });
    const answers = {
      skinType: "dry",
      concerns: ["dehydration"],
      excludedIngredients: ["Parfum"],
      sensitive: false,
    };
    await request(owner, `kiosk/sessions/${id}/answers`, "PUT", answers);
    const result = (
      await request(owner, `kiosk/sessions/${id}/analysis`, "POST", {})
    ).data;
    assert.equal(result.analysis.mode, "mock");
    assert.equal(result.analysis.model_version, "mock-1.0");
    assert.equal(result.recommendations.length, 1);
    assert.equal(result.recommendations[0].product.sku, "SMOKE-CLEAN");
    const stored =
      await sql`select a.mode,a.model_version,count(o.concern_id)::integer as observations from public.analyses a join public.observations o on o.org_id=a.org_id and o.analysis_id=a.id where a.org_id=${a.orgId} and a.session_id=${id} group by a.id`;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].observations, 1);
    const staffSessionRead = await rest(
      staffToken,
      `/rest/v1/kiosk_sessions?select=id&id=eq.${id}`,
    );
    assert.equal(staffSessionRead.status, 200);
    assert.deepEqual(await staffSessionRead.json(), []);
    console.log(
      "PASS actual REST RLS, concurrent sessions, private FastAPI mock and normalized recommendation persistence",
    );

    await request(owner, `kiosk/sessions/${id}/finish`, "POST", {});
    await request(owner, `kiosk/sessions/${id}`, "GET", undefined, 403);
    const purged =
      await sql`select skin_type_id,skin_sensitive,answers_completed_at,(select count(*)::integer from public.analyses where session_id=${id}) as analyses,(select count(*)::integer from public.session_concerns where session_id=${id}) as concerns from public.kiosk_sessions where org_id=${a.orgId} and id=${id}`;
    assert.equal(purged[0].skin_type_id, null);
    assert.equal(purged[0].skin_sensitive, null);
    assert.equal(purged[0].answers_completed_at, null);
    assert.equal(purged[0].analyses, 0);
    assert.equal(purged[0].concerns, 0);
    await request(owner, "auth/logout", "POST", {});
    const afterLogout = (await request(owner, "context")).data;
    assert.equal(afterLogout.staff, null);
    assert.equal(afterLogout.device.deviceId, paired.deviceId);
    await request(owner, "auth/login", "POST", {
      email: a.email,
      password: a.password,
    });
    const active = (await request(owner, "kiosk/sessions", "POST", {}, 201))
      .data.id;
    await request(owner, `kiosk/sessions/${active}/consent`, "POST", {
      accepted: true,
    });
    await request(owner, `kiosk/sessions/${active}/answers`, "PUT", answers);
    await request(
      other,
      `management/devices/${paired.deviceId}`,
      "DELETE",
      {},
      404,
    );
    await request(owner, `management/devices/${paired.deviceId}`, "DELETE", {});
    await request(owner, "kiosk/sessions", "POST", {}, 401);
    const revoked =
      await sql`select status,skin_type_id,answers_completed_at from public.kiosk_sessions where org_id=${a.orgId} and id=${active}`;
    assert.equal(revoked[0].status, "expired");
    assert.equal(revoked[0].skin_type_id, null);
    assert.equal(revoked[0].answers_completed_at, null);
    const repairCode = (
      await request(owner, "management/pairing-codes", "POST", {
        label: "Smoke repaired tablet",
      })
    ).data.code;
    const repaired = (
      await request(owner, "device/pair", "POST", { code: repairCode })
    ).data;
    await rememberDeviceUser(owner);
    assert.notEqual(repaired.deviceId, paired.deviceId);
    assert.notEqual(owner.accessToken("senmiva-device"), deviceToken);
    assert.equal(
      (await request(owner, "context")).data.staff.organizationId,
      a.orgId,
    );
    console.log(
      "PASS finish privacy purge, staff-only logout, immediate device revocation and fresh-identity re-pairing",
    );

    // Use only this run's disposable staff account. No persistent owner login,
    // trace, request-body recording or console forwarding enters the browser test.
    let browserStage = "Chromium startup";
    try {
      browser = await chromium.launch({ headless: true });
      browserContext = await browser.newContext({
        baseURL: origin,
        viewport: { width: 1024, height: 768 },
      });
      browserCookies = jar();
      const management = await browserContext.newPage();
      browserStage = "staff form sign-in";
      await management.goto("/management/login");
      await management.getByLabel("Email address").fill(a.email);
      await management.getByLabel("Password", { exact: true }).fill(a.password);
      await management
        .getByRole("button", { name: "Sign in to workspace" })
        .click();
      await management.waitForURL(`${origin}/management`);
      await browserExpect(
        management.getByRole("heading", { name: "Your store, at a glance." }),
      ).toBeVisible();

      browserStage = "store device code creation";
      await management
        .getByRole("link", { name: "Devices", exact: true })
        .click();
      await management.getByRole("button", { name: "Pair new device" }).click();
      const dialog = management.getByRole("dialog", {
        name: "Pair a new device",
      });
      const label = "Smoke browser tablet";
      await dialog.getByLabel("Device name").fill(label);
      await dialog.getByRole("button", { name: "Create pairing code" }).click();
      const codeDisplay = dialog.getByLabel("Pairing code");
      await browserExpect(codeDisplay).toBeVisible();
      const browserCode = (await codeDisplay.textContent()).replace(/\s/g, "");
      assert.match(browserCode, /^[A-F0-9]{16}$/);

      browserStage = "tablet pairing form";
      const tablet = await browserContext.newPage();
      await tablet.goto("/kiosk/pair");
      await tablet
        .getByLabel("Pairing code", { exact: true })
        .fill(browserCode);
      await tablet.getByRole("button", { name: "Pair this tablet" }).click();
      await tablet.waitForURL(`${origin}/kiosk`);
      await browserExpect(
        tablet.getByRole("heading", {
          name: /A little insight.*A brighter you/,
        }),
      ).toBeVisible();
      await browserExpect(
        tablet.getByRole("button", { name: "Let's get started" }),
      ).toBeEnabled();
      for (const cookie of await browserContext.cookies(origin))
        browserCookies.values.set(cookie.name, cookie.value);
      await rememberDeviceUser(browserCookies);
      const browserContextResponse = await browserContext.request.get(
        `${origin}/api/v1/context`,
      );
      assert.equal(browserContextResponse.status(), 200);
      const liveBrowserContext = await browserContextResponse.json();
      assert.equal(liveBrowserContext.staff.organizationId, a.orgId);
      assert.equal(liveBrowserContext.device.storeId, a.storeId);

      browserStage = "workspace device list refresh";
      await management.reload();
      const deviceCard = management.getByRole("article").filter({
        has: management.getByRole("heading", { name: label, exact: true }),
      });
      await browserExpect(
        deviceCard.getByText("Paired", { exact: true }),
      ).toBeVisible();
      browserStage = "workspace device revoke submission";
      const [revokeResponse] = await Promise.all([
        management.waitForResponse(
          (response) =>
            response.request().method() === "DELETE" &&
            new URL(response.url()).pathname.startsWith(
              "/api/v1/management/devices/",
            ),
        ),
        deviceCard
          .getByRole("button", { name: "Revoke device access" })
          .click(),
      ]);
      if (!revokeResponse.ok()) {
        const result = await revokeResponse.json();
        const code = /^[a-z_]{1,60}$/.test(result?.error?.code ?? "")
          ? result.error.code
          : "request_failed";
        browserStage = `workspace revoke status ${revokeResponse.status()} code ${code}`;
        throw new Error("Browser revocation failed");
      }
      browserStage = "workspace revoked device status";
      await browserExpect(
        deviceCard.getByText("Revoked", { exact: true }),
      ).toBeVisible();
      browserStage = "verified revoked browser context";
      const revokedContextResponse = await browserContext.request.get(
        `${origin}/api/v1/context`,
      );
      assert.equal(revokedContextResponse.status(), 200);
      const revokedBrowserContext = await revokedContextResponse.json();
      assert.equal(revokedBrowserContext.staff.organizationId, a.orgId);
      assert.equal(revokedBrowserContext.device, null);
      browserStage = "kiosk recovery after device revocation";
      await tablet.reload();
      await browserExpect(
        tablet.getByRole("link", { name: "Pair this tablet" }),
      ).toBeVisible();
      console.log(
        "PASS real Chromium UI: staff login, store code creation, tablet pairing, kiosk welcome and immediate device revocation",
      );
    } catch {
      // Playwright errors can include filled fields or request diagnostics.
      // Report a fixed stage label only; generated passwords and cookies stay private.
      throw new Error(
        `Local browser acceptance failed during ${browserStage}.`,
      );
    }
  } finally {
    if (browserContext && browserCookies) {
      try {
        for (const cookie of await browserContext.cookies(origin))
          browserCookies.values.set(cookie.name, cookie.value);
      } catch {
        /* A disconnected browser may already have been closed. */
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* Continue restricted tenant/Auth cleanup after a browser failure. */
      }
    }
    for (const child of children.reverse()) child.kill();
    // Pending anonymous users from an invalid code are not represented in devices.
    // Every jar was created inside this test; capture them before removing Auth data.
    for (const cookies of jars) {
      try {
        await rememberDeviceUser(cookies);
      } catch {
        /* revoked identity may already be gone */
      }
    }
    let cleanupFailed = false;
    try {
      // A failed UI navigation may follow a successful workspace transaction.
      // Discover only this run's exact generated identity/name before cleanup.
      const createdOwner =
        await sql`select id from auth.users where email=${fixtures[0].email}`;
      if (createdOwner.length === 1) {
        users.add(createdOwner[0].id);
        const createdWorkspace =
          await sql`select o.id from public.organizations o join public.memberships m on m.org_id=o.id where m.user_id=${createdOwner[0].id} and o.name=${fixtures[0].name}`;
        if (createdWorkspace.length === 1)
          fixtures[0].orgId = createdWorkspace[0].id;
      }
      const pairedUsers = provisioned
        ? await sql`select auth_user_id from public.devices where org_id in ${sql(fixtures.map((f) => f.orgId))}`
        : [];
      for (const row of pairedUsers) users.add(row.auth_user_id);
      if (provisioned) await cleanupSmokeFixtures(sql, fixtures);
      await cleanupSmokeMail(mailOrigin, [...fixtureEmails]);
    } catch {
      cleanupFailed = true;
    }
    if (!cleanupFailed) {
      for (const userId of users) {
        try {
          const removed = await admin.auth.admin.deleteUser(userId);
          if (removed.error) cleanupFailed = true;
        } catch {
          cleanupFailed = true;
        }
      }
    }
    await sql.end({ timeout: 5 });
    if (cleanupFailed)
      throw new Error(
        "Local smoke fixture cleanup failed. Inspect only tenants whose names begin Senmiva smoke in local Studio; no remote data was touched.",
      );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runSupabaseSmoke().catch((error) => {
    // Deliberately omit stack/raw driver errors, which can expose connection data.
    const safe =
      error instanceof assert.AssertionError ||
      (error instanceof Error &&
        /^(Configure |Local |Live |Build |Create |Apply |A local |The actual |Acceptance-test |Refusing |Smoke |Remote )/.test(
          error.message,
        ));
    console.error(
      safe
        ? error.message
        : "Live Supabase acceptance test failed. Check local services, migrations and restricted writer configuration.",
    );
    process.exitCode = 1;
  });
}
