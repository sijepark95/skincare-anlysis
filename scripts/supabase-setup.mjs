/** Operator-only provisioning. Never run in a request handler or ship admin credentials. */
import postgres from "postgres";
import {
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  readFile,
  readdir,
  mkdir,
  writeFile,
  rename,
  open,
  unlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  loadSetupEnv,
  parseDatabaseUrl,
  postgresOptions,
  validateMigrationHistory,
  validatePolicy,
  writerConnectionUrl,
  validateSetupCurrency,
  validateWriterFunctions,
} from "./lib/supabase-setup-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const role = "senmiva_analysis_login";
const jobName = "senmiva-private-cleanup";
const cleanupCommand = "select private.cleanup_expired_data();";
const knownTables = [
  "organizations",
  "stores",
  "memberships",
  "devices",
  "ingredients",
  "analyses",
  "kiosk_sessions",
  "recommendation_policy_versions",
  "concern_ingredient_rules",
  "membership_stores",
  "device_pairing_codes",
  "brands",
  "categories",
  "products",
  "product_variants",
  "ingredient_aliases",
  "skin_types",
  "concerns",
  "formulation_versions",
  "formulation_ingredients",
  "unresolved_formulation_ingredients",
  "formulation_skin_types",
  "variant_formulations",
  "store_listings",
  "questionnaire_versions",
  "consents",
  "session_concerns",
  "session_excluded_ingredients",
  "observations",
  "recommendation_runs",
  "recommendation_items",
  "recommendation_item_ingredients",
  "recommendation_item_reasons",
  "audit_events",
  "store_daily_metrics",
  "analysis_model_outputs",
  "analysis_visual_heads",
  "analysis_visual_probabilities",
  "analysis_ingredient_candidates",
  "analysis_input_coverage",
  "session_explanation_consents",
  "recommendation_explanation_runs",
  "recommendation_product_explanations",
  "session_vision_consents",
  "session_vision_attempts",
  "analysis_vision_outputs",
  "analysis_vision_features",
  "analysis_vision_quality_flags",
];

function setupPaths(adminUrl) {
  const identity = createHash("sha256")
    .update(`${adminUrl.hostname}:${adminUrl.port}/${adminUrl.pathname}`)
    .digest("hex");
  const directory = resolve(root, ".local/supabase", identity);
  return {
    identity,
    stateFile: resolve(directory, "setup.json"),
    secretFile: resolve(directory, "writer.env"),
    lockFile: resolve(directory, "setup.lock"),
  };
}

function invalid(message) {
  const error = new Error(message);
  error.operatorMessage = true;
  throw error;
}
async function atomicFile(file, content) {
  await mkdir(dirname(file), { recursive: true });
  const pending = `${file}.${randomUUID()}.tmp`;
  await writeFile(pending, content, { mode: 0o600, flag: "wx" });
  await rename(pending, file);
}
function scramVerifier(password) {
  // PostgreSQL receives a SCRAM verifier, never the reusable plaintext password.
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const stored = createHash("sha256").update(clientKey).digest("base64");
  const server = createHmac("sha256", salted)
    .update("Server Key")
    .digest("base64");
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${stored}:${server}`;
}
async function migrationsOnDisk() {
  const directory = resolve(root, "supabase/migrations");
  return Promise.all(
    (await readdir(directory))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .sort()
      .map(async (name) => ({
        version: name.split("_")[0],
        name: name.slice(name.indexOf("_") + 1, -4),
        sql: await readFile(resolve(directory, name), "utf8"),
      })),
  );
}
async function migrationPlan(sql, migrations) {
  const [{ present }] =
    await sql`select to_regclass('supabase_migrations.schema_migrations') is not null as present`;
  const applied = present
    ? (
        await sql`select version from supabase_migrations.schema_migrations order by version`
      ).map((row) => row.version)
    : [];
  let pending;
  try {
    pending = validateMigrationHistory(applied, migrations);
  } catch (error) {
    invalid(error.message);
  }
  if (!applied.length) {
    const existing =
      await sql`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','v','m','S') and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')`;
    if (existing.length)
      invalid(
        "Untracked application tables exist in public. Use a dedicated empty Supabase project or review migration history; existing data will not be adopted or overwritten.",
      );
    const [{ functions }] =
      await sql`select count(*)::int as functions from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('staff_context','device_context','pair_device','write_analysis_result')`;
    if (functions)
      invalid(
        "Senmiva functions exist without migration history. Review this database before setup.",
      );
  }
  return pending;
}
async function applyMigrations(sql, migrations) {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('senmiva-setup-migrations'))`;
    const pending = await migrationPlan(tx, migrations);
    await tx`create schema if not exists supabase_migrations`;
    await tx`create table if not exists supabase_migrations.schema_migrations(version text primary key, statements text[], name text)`;
    for (const migration of pending) {
      await tx.unsafe(migration.sql);
      // Compatible with Supabase CLI history; future changes use new migration files.
      await tx`insert into supabase_migrations.schema_migrations(version,statements,name) values(${migration.version},${tx.array([migration.sql])},${migration.name})`;
      process.stdout.write(`Staged migration ${migration.version}.\n`);
    }
  });
}
async function inspect(sql, migrations, adminUrl) {
  const pending = await migrationPlan(sql, migrations);
  const [{ auth }] =
    await sql`select to_regclass('auth.users') is not null as auth`;
  if (!auth)
    invalid(
      "This is not an initialized Supabase database: auth.users is missing.",
    );
  process.stdout.write(
    `Database reachable. Pending Senmiva migrations: ${pending.length}.\n`,
  );
  if (pending.length) return false;
  const tables =
    await sql`select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'`;
  const missing = knownTables.filter(
    (name) => !tables.some((table) => table.relname === name),
  );
  if (
    missing.length ||
    tables.some(
      (table) => knownTables.includes(table.relname) && !table.relrowsecurity,
    )
  )
    invalid("Required Senmiva tables or RLS protections are missing.");
  const hook = await sql`select p.prosecdef,
    has_function_privilege('supabase_auth_admin',p.oid,'EXECUTE') as auth,
    has_function_privilege('anon',p.oid,'EXECUTE') as anonymous,
    has_function_privilege('authenticated',p.oid,'EXECUTE') as client,
    has_function_privilege('service_role',p.oid,'EXECUTE') as service
    from pg_proc p where p.oid=to_regprocedure('public.senmiva_before_user_created(jsonb)')`;
  if (
    hook.length !== 1 ||
    hook[0].prosecdef ||
    !hook[0].auth ||
    hook[0].anonymous ||
    hook[0].client ||
    hook[0].service
  )
    invalid(
      "Before User Created hook is missing or has unexpected privileges. Apply the current migrations and review Auth hook configuration.",
    );
  const { stateFile } = setupPaths(adminUrl);
  const state = existsSync(stateFile)
    ? JSON.parse(await readFile(stateFile, "utf8"))
    : undefined;
  const [{ owners }] =
    await sql`select count(*)::int as owners from public.memberships m join auth.users u on u.id=m.user_id where m.active and m.role='owner' and not u.is_anonymous and u.email_confirmed_at is not null and (${state?.organizationId ?? null}::uuid is null or (m.org_id=${state?.organizationId ?? null}::uuid and lower(u.email)=lower(${state?.ownerEmail ?? null}::text)))`;
  const [{ policies }] =
    await sql`select count(*)::int as policies from public.recommendation_policy_versions where status='published' and (${state?.organizationId ?? null}::uuid is null or org_id=${state?.organizationId ?? null}::uuid)`;
  const [{ stores }] =
    await sql`select count(*)::int as stores from public.stores where active and (${state?.storeId ?? null}::uuid is null or (id=${state?.storeId ?? null}::uuid and org_id=${state?.organizationId ?? null}::uuid))`;
  const [{ cron }] =
    await sql`select exists(select 1 from pg_extension where extname='pg_cron') as cron`;
  const jobs = cron
    ? await sql`select active,schedule,command,username from cron.job where jobname=${jobName}`
    : [];
  const cleanup =
    jobs.length === 1 &&
    jobs[0].active &&
    jobs[0].schedule === "* * * * *" &&
    jobs[0].command === cleanupCommand;
  if (cleanup) {
    const [{ allowed }] =
      await sql`select has_schema_privilege(${jobs[0].username},'private','USAGE') and has_function_privilege(${jobs[0].username},'private.cleanup_expired_data()','EXECUTE') as allowed`;
    if (!allowed)
      invalid(
        "Cleanup job identity cannot execute the private cleanup function.",
      );
  }
  const writer =
    await sql`select rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit from pg_roles where rolname=${role}`;
  if (writer.length) await assertWriter(sql);
  process.stdout.write(
    `Confirmed active owners: ${owners}. Active stores: ${stores}. Published policies: ${policies}. Restricted writer login: ${writer.length ? "verified" : "missing"}. Minute cleanup: ${cleanup ? "scheduled" : "missing"}.\n`,
  );
  if (!cleanup)
    process.stdout.write(
      "Enable pg_cron in Database > Extensions, then run --init to schedule privacy cleanup.\n",
    );
  return (
    owners > 0 && stores > 0 && policies > 0 && writer.length > 0 && cleanup
  );
}
async function assertWriter(sql) {
  const rows =
    await sql`select rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolinherit from pg_roles where rolname=${role}`;
  const value = rows[0];
  if (
    !value ||
    !value.rolcanlogin ||
    !value.rolinherit ||
    value.rolsuper ||
    value.rolbypassrls ||
    value.rolcreatedb ||
    value.rolcreaterole ||
    value.rolreplication
  )
    invalid(
      "Existing analysis login has unexpected capabilities. Setup will not modify it.",
    );
  const grants =
    await sql`select r.rolname,m.admin_option from pg_auth_members m join pg_roles r on r.oid=m.roleid join pg_roles u on u.oid=m.member where u.rolname=${role}`;
  if (
    grants.length !== 1 ||
    grants[0].rolname !== "analysis_writer" ||
    grants[0].admin_option
  )
    invalid(
      "Analysis login must inherit only analysis_writer without an admin grant.",
    );
  const capabilities =
    await sql`select rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,rolcanlogin from pg_roles where rolname='analysis_writer'`;
  if (!capabilities[0] || Object.values(capabilities[0]).some(Boolean))
    invalid("analysis_writer capability role is unexpectedly privileged.");
  const ancestors =
    await sql`select r.rolname from pg_roles r where r.rolname not in (${role},'analysis_writer') and pg_has_role(${role},r.oid,'MEMBER')`;
  if (ancestors.length)
    invalid("Analysis login inherits unexpected roles indirectly.");
  const access =
    await sql`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and case when c.relkind in ('r','v','m') then (has_table_privilege(${role},c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(${role},c.oid,'SELECT,INSERT,UPDATE,REFERENCES')) else false end`;
  if (access.length)
    invalid(
      "Analysis login has direct application-table permissions. Setup will not reuse it.",
    );
  const sequences =
    await sql`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private') and case when c.relkind='S' then has_sequence_privilege(${role},c.oid,'SELECT,UPDATE,USAGE') else false end`;
  if (sequences.length)
    invalid("Analysis login has direct application-sequence permissions.");
  const functions =
    await sql`select format('%I.%I(%s)',n.nspname,p.proname,oidvectortypes(p.proargtypes)) as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prosecdef and has_function_privilege(${role},p.oid,'EXECUTE')`;
  validateWriterFunctions(functions);
}
async function answers(env, state) {
  const fields = {
    organizationName: env.SUPABASE_ORGANIZATION_NAME || state?.organizationName,
    storeName: env.SUPABASE_STORE_NAME || state?.storeName,
    currency: env.SUPABASE_STORE_CURRENCY || state?.currency || "USD",
    ownerEmail: env.SUPABASE_OWNER_EMAIL || state?.ownerEmail,
  };
  if (
    (!fields.organizationName || !fields.storeName || !fields.ownerEmail) &&
    !process.stdin.isTTY
  )
    invalid(
      "Set SUPABASE_ORGANIZATION_NAME, SUPABASE_STORE_NAME and SUPABASE_OWNER_EMAIL in .env.supabase-admin.local, or run --init interactively.",
    );
  if (process.stdin.isTTY) {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      fields.organizationName ||= await prompt.question(
        "Company/workspace name: ",
      );
      fields.storeName ||= await prompt.question("First store name: ");
      fields.ownerEmail ||= await prompt.question(
        "Existing confirmed administrator email: ",
      );
    } finally {
      prompt.close();
    }
  }
  for (const key of ["organizationName", "storeName", "ownerEmail"])
    fields[key] = fields[key].trim();
  try {
    fields.currency = validateSetupCurrency(fields.currency);
  } catch (error) {
    invalid(error.message);
  }
  if (
    !fields.organizationName ||
    fields.organizationName.length > 120 ||
    !fields.storeName ||
    fields.storeName.length > 120 ||
    !/^[A-Z]{3}$/.test(fields.currency) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.ownerEmail)
  )
    invalid(
      "Workspace/store names, currency or administrator email are invalid.",
    );
  return fields;
}
async function initialize(sql, adminUrl, env, policy) {
  const { stateFile, secretFile, identity } = setupPaths(adminUrl);
  let state;
  if (existsSync(stateFile)) {
    state = JSON.parse(await readFile(stateFile, "utf8"));
    if (state.databaseIdentity !== identity)
      invalid(
        "Local setup state does not match its database identity; setup will not target the wrong tenant.",
      );
  }
  const fields = await answers(env, state);
  if (
    state &&
    ["organizationName", "storeName", "currency", "ownerEmail"].some(
      (key) => state[key] !== fields[key],
    )
  )
    invalid(
      "Setup inputs differ from the saved tenant. Use an explicit reviewed migration for tenant changes.",
    );
  state ||= {
    ...fields,
    databaseIdentity: identity,
    organizationId: randomUUID(),
    storeId: randomUUID(),
    policyId: randomUUID(),
  };
  // Persist idempotency IDs before a DB commit; a crash/retry cannot duplicate tenants.
  await atomicFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  let writerUrl;
  if (existsSync(secretFile)) {
    const existing = loadSetupEnv(root, {});
    const { parseEnv } = await import("node:util");
    writerUrl =
      parseEnv(await readFile(secretFile, "utf8")).ANALYSIS_DATABASE_URL ||
      existing.ANALYSIS_DATABASE_URL;
  }
  writerUrl ||= env.ANALYSIS_DATABASE_URL;
  let password;
  const [{ exists: roleExists }] =
    await sql`select exists(select 1 from pg_roles where rolname=${role}) as exists`;
  if (roleExists && !writerUrl)
    invalid(
      "Restricted login already exists, but its secret is missing. Recover its existing writer URL or rotate the password through a deliberate administrator action.",
    );
  if (!roleExists) {
    password = randomBytes(32).toString("base64url");
    writerUrl = writerConnectionUrl(adminUrl.toString(), role, password);
    // Save only the dedicated generated credential before committing creation.
    await atomicFile(
      secretFile,
      `# Server-only restricted writer. Do not commit.\nANALYSIS_DATABASE_URL=${JSON.stringify(writerUrl)}\n`,
    );
  }
  const parsedWriter = parseDatabaseUrl(writerUrl, "ANALYSIS_DATABASE_URL");
  const expectedWriter = new URL(
    writerConnectionUrl(
      adminUrl.toString(),
      role,
      decodeURIComponent(parsedWriter.password),
    ),
  );
  if (
    parsedWriter.hostname !== expectedWriter.hostname ||
    parsedWriter.port !== expectedWriter.port ||
    parsedWriter.pathname !== expectedWriter.pathname ||
    parsedWriter.username !== expectedWriter.username
  )
    invalid(
      "Writer URL does not match this database's dedicated analysis login.",
    );
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('senmiva-setup-tenant'))`;
    const [{ cron }] =
      await tx`select exists(select 1 from pg_extension where extname='pg_cron') as cron`;
    if (!cron)
      invalid(
        "Enable pg_cron in the Supabase Database > Extensions dashboard, then retry --init. Tenant and writer changes were rolled back.",
      );
    const owners =
      await tx`select id from auth.users where lower(email)=lower(${fields.ownerEmail}) and email_confirmed_at is not null and not is_anonymous and deleted_at is null and (banned_until is null or banned_until <= now())`;
    if (owners.length !== 1)
      invalid(
        "Create and confirm exactly one non-anonymous Auth user with this email before --init. No password is accepted by this script.",
      );
    await tx`insert into public.organizations(id,name) values(${state.organizationId},${fields.organizationName}) on conflict(id) do nothing`;
    await tx`insert into public.stores(id,org_id,name,currency) values(${state.storeId},${state.organizationId},${fields.storeName},${fields.currency}) on conflict(id) do nothing`;
    const matching =
      await tx`select s.id from public.stores s join public.organizations o on o.id=s.org_id where o.id=${state.organizationId} and s.id=${state.storeId} and o.name=${fields.organizationName} and s.name=${fields.storeName} and s.currency=${fields.currency} and s.active`;
    if (matching.length !== 1)
      invalid(
        "Existing tenant/store differs from setup state. No existing records were overwritten.",
      );
    await tx`insert into public.memberships(org_id,user_id,role) values(${state.organizationId},${owners[0].id},'owner') on conflict(org_id,user_id) do nothing`;
    const owner =
      await tx`select id from public.memberships where org_id=${state.organizationId} and user_id=${owners[0].id} and role='owner' and active`;
    if (owner.length !== 1)
      invalid(
        "Existing staff membership is not an active owner. Setup will not silently elevate it.",
      );
    const canonical = [];
    for (const rule of policy.rules) {
      const refs =
        await tx`select c.id as concern_id,i.id as ingredient_id from public.concerns c cross join public.ingredients i where c.slug=${rule.concern} and i.inci_name=${rule.ingredient}`;
      if (refs.length !== 1)
        invalid(
          `Policy reference is not a canonical concern/INCI pair: ${rule.concern} / ${rule.ingredient}.`,
        );
      canonical.push({ ...refs[0], relevance: rule.relevance });
    }
    const existingPolicy =
      await tx`select id,status from public.recommendation_policy_versions where org_id=${state.organizationId} and version=${policy.version}`;
    if (existingPolicy.length) {
      const existingRules =
        await tx`select c.slug as concern,i.inci_name as ingredient,r.relevance from public.concern_ingredient_rules r join public.concerns c on c.id=r.concern_id join public.ingredients i on i.id=r.ingredient_id where r.org_id=${state.organizationId} and r.policy_version_id=${existingPolicy[0].id}`;
      const normalize = (rules) =>
        JSON.stringify(
          rules
            .map(
              (rule) => `${rule.concern}:${rule.ingredient}:${rule.relevance}`,
            )
            .sort(),
        );
      if (
        existingPolicy[0].status !== "published" ||
        normalize(existingRules) !== normalize(policy.rules)
      )
        invalid(
          "Existing policy version differs. Create a new reviewed version; published policies are immutable.",
        );
    } else {
      const policyId = randomUUID();
      await tx`insert into public.recommendation_policy_versions(id,org_id,version) values(${policyId},${state.organizationId},${policy.version})`;
      for (const rule of canonical)
        await tx`insert into public.concern_ingredient_rules(org_id,policy_version_id,concern_id,ingredient_id,relevance) values(${state.organizationId},${policyId},${rule.concern_id},${rule.ingredient_id},${rule.relevance})`;
      await tx`update public.recommendation_policy_versions set status='published',published_at=now() where org_id=${state.organizationId} and id=${policyId}`;
    }
    if (!roleExists) {
      const [{ statement }] =
        await tx`select format('create role %I login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 5 password %L',${role}::text,${scramVerifier(password)}::text) as statement`;
      await tx.unsafe(statement);
      await tx`grant analysis_writer to senmiva_analysis_login`;
      const [{ database }] = await tx`select current_database() as database`;
      const [{ statement: grant }] =
        await tx`select format('grant connect on database %I to senmiva_analysis_login',${database}::text) as statement`;
      await tx.unsafe(grant);
      await tx`alter role senmiva_analysis_login set statement_timeout='10s'`;
      await tx`alter role senmiva_analysis_login set idle_in_transaction_session_timeout='10s'`;
    }
    await assertWriter(tx);
    const jobs =
      await tx`select jobid,schedule,command,active,username from cron.job where jobname=${jobName}`;
    if (jobs.length > 1)
      invalid("Multiple cleanup jobs already exist. Review them before setup.");
    if (
      jobs.length &&
      (jobs[0].schedule !== "* * * * *" ||
        jobs[0].command !== cleanupCommand ||
        !jobs[0].active)
    )
      invalid(
        "Existing cleanup job differs or is disabled. Review it instead of silently replacing it.",
      );
    if (!jobs.length)
      await tx`select cron.schedule(${jobName},'* * * * *',${cleanupCommand})`;
  });
  const writer = postgres(writerUrl, postgresOptions(writerUrl, env, root));
  try {
    const [{ current_user: user }] = await writer`select current_user`;
    if (user !== role)
      invalid("Writer connection did not use its dedicated login.");
  } finally {
    await writer.end({ timeout: 1 });
  }
  const runtimeFile = resolve(root, ".env.local");
  const original = existsSync(runtimeFile)
    ? await readFile(runtimeFile, "utf8")
    : "";
  const line = `ANALYSIS_DATABASE_URL=${JSON.stringify(writerUrl)}`;
  const updated = /^ANALYSIS_DATABASE_URL=.*$/m.test(original)
    ? original.replace(/^ANALYSIS_DATABASE_URL=.*$/m, () => line)
    : `${original.trimEnd()}\n${line}\n`;
  await atomicFile(runtimeFile, updated);
  process.stdout.write(
    `Workspace, store, confirmed owner, mock policy, restricted writer and minute cleanup are ready.\nOrganization: ${state.organizationId}\nStore: ${state.storeId}\nThe writer URL was saved to ignored .env.local; it was not printed.\n`,
  );
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || !args.length) {
    process.stdout.write(
      "Usage: node scripts/supabase-setup.mjs --check | --migrate | --init (--mock-policy | --policy path)\n--check is read-only. --migrate applies only known missing migrations, without demo seed. --init provisions or verifies the saved tenant.\nRead docs/SUPABASE-SETUP.md first. Admin connection stays in .env.supabase-admin.local.\n",
    );
    return;
  }
  const mode = args[0];
  const policyIndex = args.indexOf("--policy");
  const validArgs =
    mode === "--init"
      ? (args.length === 2 && args[1] === "--mock-policy") ||
        (args.length === 3 && policyIndex === 1 && args[2])
      : args.length === 1;
  if (!["--check", "--migrate", "--init"].includes(mode) || !validArgs)
    invalid(
      "Invalid arguments. Use --help; never pass passwords or connection URLs as command arguments.",
    );
  const env = loadSetupEnv(root);
  let adminUrl;
  try {
    adminUrl = parseDatabaseUrl(env.SUPABASE_ADMIN_DATABASE_URL);
  } catch (error) {
    invalid(
      `${error.message} Put it in ignored .env.supabase-admin.local, never in chat or a command argument.`,
    );
  }
  if (adminUrl.port === "6543")
    invalid(
      "Setup requires a direct or session-pooler connection, not transaction pooling on port 6543.",
    );
  const sql = postgres(
    adminUrl.toString(),
    postgresOptions(adminUrl, env, root),
  );
  try {
    const migrations = await migrationsOnDisk();
    if (mode === "--check") {
      const ready = await sql.begin("read only", (tx) =>
        inspect(tx, migrations, adminUrl),
      );
      if (!ready) process.exitCode = 2;
    } else if (mode === "--migrate") {
      await applyMigrations(sql, migrations);
      process.stdout.write(
        "Migrations committed. No synthetic tenant, products or accounts were seeded.\n",
      );
    } else {
      const pending = await migrationPlan(sql, migrations);
      if (pending.length)
        invalid("Apply missing migrations with --migrate before --init.");
      const file =
        policyIndex === 1
          ? resolve(root, args[2])
          : resolve(root, "supabase/mock-policy.json");
      let policy;
      try {
        policy = validatePolicy(JSON.parse(await readFile(file, "utf8")));
      } catch (error) {
        invalid(`Policy validation failed: ${error.message}`);
      }
      const { lockFile } = setupPaths(adminUrl);
      await mkdir(dirname(lockFile), { recursive: true });
      let lock;
      try {
        lock = await open(lockFile, "wx", 0o600);
      } catch {
        invalid(
          "Another setup may be running. Inspect this database's .local/supabase/<identity>/setup.lock; after a crashed setup remove only that lock file before retrying.",
        );
      }
      try {
        await initialize(sql, adminUrl, env, policy);
        await inspect(sql, migrations, adminUrl);
      } finally {
        await lock.close();
        await unlink(lockFile);
      }
    }
  } finally {
    await sql.end({ timeout: 1 });
  }
}
try {
  await main();
} catch (error) {
  // SQL/network errors can contain credentials, rows or query literals: never dump them.
  process.stderr.write(
    error.operatorMessage
      ? `${error.message}\n`
      : `Supabase setup failed (${typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "connection or configuration error"}). Check the connection, verified TLS certificate and administrator privileges. No credentials were printed.\n`,
  );
  process.exitCode = 1;
}
