/** Local-only developer onboarding; never creates or modifies a hosted project. */
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import {
  parseDatabaseUrl,
  postgresOptions,
} from "./lib/supabase-setup-config.mjs";

const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function localApi(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Local API configuration is invalid.");
  }
  if (
    !loopback.has(url.hostname) ||
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Local preparation refuses remote or credential-bearing API URLs.",
    );
  return url;
}

/** Validate every target before writing any environment file or calling Auth. */
export function assertLocalPrepareTarget(
  status,
  runtime = {},
  administrator = {},
) {
  const api = localApi(status.API_URL);
  const database = parseDatabaseUrl(status.DB_URL);
  if (!loopback.has(database.hostname))
    throw new Error("Local preparation refuses a remote database.");
  for (const values of [runtime, administrator]) {
    if (
      values.NEXT_PUBLIC_SUPABASE_URL &&
      localApi(values.NEXT_PUBLIC_SUPABASE_URL).origin !== api.origin
    )
      throw new Error(
        "An existing Supabase environment targets another project. Refusing to overwrite it.",
      );
    for (const name of [
      "SUPABASE_ADMIN_DATABASE_URL",
      "ANALYSIS_DATABASE_URL",
    ]) {
      if (!values[name]) continue;
      const existing = parseDatabaseUrl(values[name], name);
      if (
        !loopback.has(existing.hostname) ||
        existing.host !== database.host ||
        existing.pathname !== database.pathname
      )
        throw new Error(
          "An existing database environment targets another project. Refusing to overwrite it.",
        );
    }
    if (values.NEXT_PUBLIC_APP_URL) {
      let app;
      try {
        app = new URL(values.NEXT_PUBLIC_APP_URL);
      } catch {
        throw new Error(
          "Existing app origin is invalid; review it before local preparation.",
        );
      }
      if (!loopback.has(app.hostname) || app.protocol !== "http:")
        throw new Error(
          "A hosted application environment already exists. Refusing to overwrite it.",
        );
    }
  }
  if (!(status.PUBLISHABLE_KEY || status.ANON_KEY) || !status.SERVICE_ROLE_KEY)
    throw new Error("Local Supabase status is missing its API keys.");
  for (const values of [runtime, administrator]) {
    if (
      values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY &&
      ![status.PUBLISHABLE_KEY, status.ANON_KEY].includes(
        values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      )
    )
      throw new Error(
        "An existing API key does not belong to this local stack. Refusing to overwrite it.",
      );
    if (
      values.SUPABASE_SERVICE_ROLE_KEY &&
      values.SUPABASE_SERVICE_ROLE_KEY !== status.SERVICE_ROLE_KEY
    )
      throw new Error(
        "An existing administrator key does not belong to this local stack. Refusing to overwrite it.",
      );
  }
  return { apiUrl: api.origin, databaseUrl: database.toString() };
}

/** Replace named entries only; retain comments, unrelated settings and secrets. */
export function updateLocalEnv(original, changes) {
  let result = original;
  for (const [name, value] of Object.entries(changes)) {
    const line = `${name}=${JSON.stringify(value)}`;
    const expression = new RegExp(`^${name}=.*$`, "gm");
    result = expression.test(result)
      ? result.replace(expression, () => line)
      : `${result.trimEnd()}\n${line}\n`;
  }
  return result.replace(/^\n/, "");
}

async function captured(
  command,
  args,
  options,
  failureMessage = "Local Supabase status failed. Check Docker and the local Supabase services.",
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let tooLarge = false;
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 262144) {
        tooLarge = true;
        child.kill();
      }
    });
    // Do not forward CLI output: local status contains server-only keys.
    child.stderr.resume();
    child.on("error", () => reject(new Error(failureMessage)));
    child.on("exit", (code) =>
      code === 0 && !tooLarge
        ? resolve(output)
        : reject(new Error(failureMessage)),
    );
  });
}

async function atomicFile(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const pending = `${file}.${randomUUID()}.tmp`;
  await writeFile(pending, content, { mode: 0o600, flag: "wx" });
  await rename(pending, file);
}

export async function prepareLocalSupabase(
  root = process.cwd(),
  inherited = process.env,
) {
  const runtimeFile = path.join(root, ".env.local");
  const adminFile = path.join(root, ".env.supabase-admin.local");
  const runtimeText = existsSync(runtimeFile)
    ? await readFile(runtimeFile, "utf8")
    : "# Local Supabase runtime. Never commit.\n";
  const adminText = existsSync(adminFile)
    ? await readFile(adminFile, "utf8")
    : "# Operator-only LOCAL Supabase settings. Never commit or deploy.\n";
  const runtime = parseEnv(runtimeText);
  const administrator = parseEnv(adminText);
  const rawStatus = await captured(
    process.execPath,
    [
      path.join(root, "node_modules", "supabase", "dist", "supabase.js"),
      "status",
      "-o",
      "json",
    ],
    { cwd: root, env: inherited },
  );
  let status;
  try {
    status = JSON.parse(rawStatus);
  } catch {
    throw new Error("Local Supabase status did not return valid JSON.");
  }
  const target = assertLocalPrepareTarget(status, runtime, administrator);
  // Shell-provided overrides must pass the same guard and cannot redirect setup.
  assertLocalPrepareTarget(status, inherited, inherited);
  const key = runtime.ANALYSIS_API_KEY || randomBytes(32).toString("hex");
  if (key.length < 32)
    throw new Error(
      "Existing analysis API key is too short; review it before local preparation.",
    );
  const url = parseDatabaseUrl(target.databaseUrl);
  const identity = createHash("sha256")
    .update(`${url.hostname}:${url.port}/${url.pathname}`)
    .digest("hex");
  const credentialsFile = path.join(
    root,
    ".local",
    "supabase",
    identity,
    "owner.env",
  );
  const credentials = existsSync(credentialsFile)
    ? parseEnv(await readFile(credentialsFile, "utf8"))
    : {};
  const email =
    administrator.SUPABASE_OWNER_EMAIL ||
    credentials.SUPABASE_OWNER_EMAIL ||
    "local-owner@senmiva.test";
  if (
    credentials.SUPABASE_OWNER_EMAIL &&
    credentials.SUPABASE_OWNER_EMAIL !== email
  )
    throw new Error(
      "Existing local owner credentials name another account. Refusing to replace them.",
    );
  const sql = postgres(target.databaseUrl, postgresOptions(target.databaseUrl));
  const authOptions = {
    auth: { persistSession: false, autoRefreshToken: false },
  };
  const admin = createClient(
    target.apiUrl,
    status.SERVICE_ROLE_KEY,
    authOptions,
  );
  let generated = false;
  try {
    const users =
      await sql`select id,email_confirmed_at,is_anonymous from auth.users where lower(email)=lower(${email}) and deleted_at is null`;
    if (
      users.length > 1 ||
      (users.length === 1 &&
        (users[0].is_anonymous || !users[0].email_confirmed_at))
    )
      throw new Error(
        "Existing local owner must be one confirmed non-anonymous Auth account. No account was changed.",
      );
    if (!users.length) {
      const password =
        credentials.SUPABASE_OWNER_PASSWORD ||
        `Aa1!${randomBytes(32).toString("base64url")}`;
      if (!credentials.SUPABASE_OWNER_PASSWORD) {
        // Save before creation so a crash/retry never loses the generated password.
        await atomicFile(
          credentialsFile,
          `# LOCAL DEVELOPMENT LOGIN ONLY. Never commit or deploy.\nSUPABASE_OWNER_EMAIL=${JSON.stringify(email)}\nSUPABASE_OWNER_PASSWORD=${JSON.stringify(password)}\n`,
        );
      }
      const created = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (created.error || !created.data.user)
        throw new Error(
          "Local administrator creation failed. Existing accounts were not modified.",
        );
      generated = true;
    } else if (credentials.SUPABASE_OWNER_PASSWORD) {
      const verifier = createClient(
        target.apiUrl,
        status.PUBLISHABLE_KEY || status.ANON_KEY,
        authOptions,
      );
      const login = await verifier.auth.signInWithPassword({
        email,
        password: credentials.SUPABASE_OWNER_PASSWORD,
      });
      if (login.error)
        throw new Error(
          "Saved local owner credentials no longer sign in. Recover them deliberately; no password was rotated.",
        );
      await verifier.auth.signOut({ scope: "local" });
    }
    const available =
      await sql`select name from pg_available_extensions where name='pg_cron'`;
    if (!available.length)
      throw new Error(
        "Local PostgreSQL does not provide pg_cron. Use the supported local Supabase database image.",
      );
    await sql.unsafe("create extension if not exists pg_cron");
  } finally {
    await sql.end({ timeout: 5 });
  }
  await atomicFile(
    runtimeFile,
    updateLocalEnv(runtimeText, {
      APP_MODE: "supabase",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
      NEXT_PUBLIC_SUPABASE_URL: target.apiUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
        runtime.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
        status.PUBLISHABLE_KEY ||
        status.ANON_KEY,
      ANALYSIS_SERVICE_URL:
        runtime.ANALYSIS_SERVICE_URL || "http://127.0.0.1:8000",
      ANALYSIS_API_KEY: key,
    }),
  );
  await atomicFile(
    adminFile,
    updateLocalEnv(adminText, {
      SUPABASE_ADMIN_DATABASE_URL: target.databaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
      SUPABASE_ORGANIZATION_NAME:
        administrator.SUPABASE_ORGANIZATION_NAME || "Senmiva Local Studio",
      SUPABASE_STORE_NAME:
        administrator.SUPABASE_STORE_NAME || "Local Beauty Studio",
      SUPABASE_STORE_CURRENCY: administrator.SUPABASE_STORE_CURRENCY || "USD",
      SUPABASE_OWNER_EMAIL: email,
    }),
  );
  await captured(
    process.execPath,
    [
      path.join(root, "scripts", "supabase-setup.mjs"),
      "--init",
      "--mock-policy",
    ],
    {
      cwd: root,
      env: {
        ...inherited,
        SUPABASE_ADMIN_DATABASE_URL: target.databaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
        SUPABASE_ORGANIZATION_NAME:
          administrator.SUPABASE_ORGANIZATION_NAME || "Senmiva Local Studio",
        SUPABASE_STORE_NAME:
          administrator.SUPABASE_STORE_NAME || "Local Beauty Studio",
        SUPABASE_STORE_CURRENCY: administrator.SUPABASE_STORE_CURRENCY || "USD",
        SUPABASE_OWNER_EMAIL: email,
      },
    },
    "Local database provisioning failed. Run npm run supabase:init for safe diagnostics.",
  );
  console.log(
    "Local Supabase, confirmed owner, workspace, restricted writer, mock policy and privacy cleanup are ready.",
  );
  console.log(`Administrator email: ${email}`);
  if (generated || existsSync(credentialsFile))
    console.log(
      `The local login password is in the ignored file: ${credentialsFile}`,
    );
  else
    console.log(
      "Your existing administrator password was preserved. Use that account's current password.",
    );
  console.log("Start the connected application with npm run dev:connected.");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  prepareLocalSupabase().catch((error) => {
    const safe =
      error instanceof Error &&
      /^(Local |Existing |An existing |A hosted |Saved local )/.test(
        error.message,
      );
    console.error(
      safe
        ? error.message
        : "Local preparation failed. Review existing environment targets, Docker/Supabase availability, confirmed owner and pg_cron; credentials were not printed or silently rotated.",
    );
    process.exitCode = 1;
  });
}
