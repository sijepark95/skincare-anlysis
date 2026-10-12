import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

/**
 * Read ignored operator files without copying their secrets into process.env.
 * @param {string} root
 * @param {Record<string, string | undefined>} inherited
 * @returns {Record<string, string | undefined>}
 */
export function loadSetupEnv(root = process.cwd(), inherited = process.env) {
  let values = {};
  for (const name of [".env.local", ".env.supabase-admin.local"]) {
    const file = resolve(root, name);
    if (existsSync(file))
      values = { ...values, ...parseEnv(readFileSync(file, "utf8")) };
  }
  return { ...values, ...inherited };
}

export function parseDatabaseUrl(value, label = "SUPABASE_ADMIN_DATABASE_URL") {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a PostgreSQL connection URL.`);
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.password ||
    !url.pathname ||
    url.pathname === "/"
  )
    throw new Error(`${label} needs a host, database, username and password.`);
  if (url.hash)
    throw new Error(
      `${label} contains a URL fragment; percent-encode reserved password characters.`,
    );
  if (url.searchParams.has("options"))
    throw new Error(`${label} must not set arbitrary connection options.`);
  return url;
}

export function isLocalDatabase(url) {
  return [
    "localhost",
    "127.0.0.1",
    "::1",
    "[::1]",
    "host.docker.internal",
  ].includes(url.hostname);
}

/** Hosted connections verify their certificate; disabling TLS is not an option. */
export function postgresOptions(value, env = {}, root = process.cwd()) {
  const url = value instanceof URL ? value : parseDatabaseUrl(value);
  const caFile = env.SUPABASE_DATABASE_CA_FILE;
  return {
    max: 1,
    prepare: false,
    ssl: isLocalDatabase(url)
      ? false
      : caFile
        ? {
            rejectUnauthorized: true,
            ca: readFileSync(resolve(root, caFile), "utf8"),
          }
        : "verify-full",
    connect_timeout: 10,
    idle_timeout: 5,
    onnotice: () => undefined,
    connection: {
      application_name: "senmiva-provisioning",
      statement_timeout: "30s",
    },
  };
}

export function validateMigrationHistory(applied, migrations) {
  const expected = migrations.map((migration) => migration.version);
  if (
    new Set(applied).size !== applied.length ||
    applied.some((version, i) => version !== expected[i])
  )
    throw new Error(
      "Migration history is not a known Senmiva prefix. Stop and review this database; no changes were applied.",
    );
  return migrations.slice(applied.length);
}

/** Exact signatures prevent a same-name overload from inheriting writer authority. */
export function validateWriterFunctions(functions) {
  const expected = new Set([
    "public.write_analysis_result(uuid, uuid, text, text, text, jsonb)",
    "public.persist_recommendations(uuid, uuid, uuid, jsonb)",
    "public.write_experimental_analysis(uuid, uuid, text, text, jsonb, jsonb)",
    "public.complete_recommendation_explanation(uuid, text, text, jsonb, text, text)",
    "public.write_openai_analysis(uuid, uuid, text, text, text, jsonb)",
    "public.write_openai_color_analysis(uuid, uuid, text, jsonb)",
    "public.write_openai_beauty_analysis(uuid, uuid, text, jsonb)",
    "public.write_openai_complete_analysis(uuid, uuid, jsonb, jsonb)",
    "public.persist_complete_recommendations(uuid, uuid, jsonb)",
  ]);
  if (
    functions.length !== expected.size ||
    new Set(functions.map((entry) => entry.signature)).size !== expected.size ||
    functions.some((entry) => !expected.has(entry.signature))
  )
    throw new Error(
      "Analysis login must execute exactly the nine intended application writer functions.",
    );
}

export function writerConnectionUrl(adminValue, role, password) {
  if (!/^senmiva_[a-z0-9_]{1,40}$/.test(role))
    throw new Error("Invalid dedicated writer role name.");
  const url = parseDatabaseUrl(adminValue);
  const username = decodeURIComponent(url.username);
  const pooled = url.hostname.endsWith(".pooler.supabase.com");
  if (pooled && !username.includes("."))
    throw new Error(
      "The pooler administrator username must include the project reference.",
    );
  url.username = pooled
    ? `${role}.${username.slice(username.lastIndexOf(".") + 1)}`
    : role;
  url.password = password;
  // The writer uses the same direct/session endpoint. Runtime enforces verified TLS.
  return url.toString();
}

export function validateSetupCurrency(value = "USD") {
  const currency = value.trim().toUpperCase();
  if (currency !== "USD")
    throw new Error(
      "This MVP supports USD stores only. Multi-currency requires a reviewed application and database change.",
    );
  return currency;
}

export function validatePolicy(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.mockOnly !== true ||
    value.reviewed !== true ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !Array.isArray(value.rules) ||
    value.rules.length < 1 ||
    value.rules.length > 500
  )
    throw new Error(
      "Policy must have mockOnly:true, reviewed:true, a positive version and 1–500 rules.",
    );
  if (
    Object.keys(value).some(
      (key) => !["mockOnly", "reviewed", "version", "rules"].includes(key),
    )
  )
    throw new Error("Policy has unsupported fields.");
  const seen = new Set();
  for (const rule of value.rules) {
    if (
      !rule ||
      typeof rule !== "object" ||
      Object.keys(rule).sort().join(",") !== "concern,ingredient,relevance" ||
      !["dehydration", "texture", "uneven_tone", "fine_lines"].includes(
        rule.concern,
      ) ||
      typeof rule.ingredient !== "string" ||
      !rule.ingredient.trim() ||
      rule.ingredient.length > 160 ||
      ![1, 2, 3].includes(rule.relevance)
    )
      throw new Error(
        "Policy contains an invalid concern, canonical INCI ingredient or relevance.",
      );
    const identity = `${rule.concern}:${rule.ingredient.trim().toLowerCase()}`;
    if (seen.has(identity))
      throw new Error("Policy contains duplicate concern/ingredient rules.");
    seen.add(identity);
  }
  return value;
}
