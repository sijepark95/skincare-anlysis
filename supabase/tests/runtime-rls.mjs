/**
 * Execute the actual migrations and seed against PGlite (PostgreSQL WASM).
 * Install the pinned runner outside the project, then run this file:
 * npm install --prefix <temp>/senmiva-pglite-rls --no-save --package-lock=false @electric-sql/pglite@0.5.8
 * node supabase/tests/runtime-rls.mjs
 * SENMIVA_PGLITE_DIR may override that temporary dependency directory.
 *
 * This harness uses real pgcrypto, SQL, triggers, FKs, roles and RLS. Only the
 * Supabase-managed auth schema/JWT accessor functions are stubbed. It does not
 * replace a full Supabase/pgTAP run, HTTP authorization, concurrency or Auth tests.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dependencyDir = process.env.SENMIVA_PGLITE_DIR ?? join(tmpdir(), "senmiva-pglite-rls");
const moduleDir = join(dependencyDir, "node_modules", "@electric-sql", "pglite", "dist");
const { PGlite } = await import(pathToFileURL(join(moduleDir, "index.js")).href);
const { pgcrypto } = await import(pathToFileURL(join(moduleDir, "contrib", "pgcrypto.js")).href);
const db = new PGlite({ extensions: { pgcrypto } });
const supabaseDir = fileURLToPath(new URL("../", import.meta.url));
let passed = 0;
let failed = 0;

const query = async (sql, params = []) => (await db.query(sql, params)).rows;
const scalar = async (sql, params = []) => Object.values((await query(sql, params))[0] ?? {})[0];
const test = async (name, body) => {
  try { await body(); passed += 1; process.stdout.write(`PASS ${name}\n`); }
  catch (error) { failed += 1; process.stderr.write(`FAIL ${name}: ${error.message}\n`); }
};
const rejectCode = async (body, code) => {
  try { await body(); } catch (error) { assert.equal(error.code, code, error.message); return; }
  assert.fail(`Expected PostgreSQL error ${code}.`);
};
const asRole = async (role, userId, anonymous, body, commit = false) => {
  await db.exec(`begin; set local role ${role};`);
  try {
    await query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [userId ?? "", JSON.stringify({ sub: userId, is_anonymous: anonymous })]);
    const result = await body();
    await db.exec(commit ? "commit" : "rollback");
    return result;
  } catch (error) { await db.exec("rollback"); throw error; }
};

try {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create role supabase_auth_admin nologin;
    create schema auth;
    create table auth.users(id uuid primary key, email text, encrypted_password text,
      is_anonymous boolean, email_confirmed_at timestamptz,
      raw_app_meta_data jsonb, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    grant usage on schema auth to anon,authenticated;
    grant execute on function auth.uid(),auth.jwt() to anon,authenticated;
  `);
  const migrations = (await readdir(join(supabaseDir, "migrations"))).filter((name) => name.endsWith(".sql")).sort();
  for (const name of migrations) {
    await db.exec(await readFile(join(supabaseDir, "migrations", name), "utf8"));
    process.stdout.write(`MIGRATED ${name}\n`);
  }
  await test("production migrations provide global reference data without demo tenant seed", async () => {
    assert.equal(await scalar("select count(*)::int from public.organizations"),0);
    assert.equal(await scalar("select count(*)::int from public.ingredients"),40);
    assert.equal(await scalar("select count(*)::int from public.concerns"),4);
    assert.equal(await scalar("select count(*)::int from public.skin_types"),5);
    assert.equal(await scalar("select count(*)::int from public.questionnaire_versions where active"),1);
  });
  await db.exec(await readFile(join(supabaseDir, "seed.sql"), "utf8"));
  process.stdout.write(`SEEDED; ${await scalar("select version()")}; real pgcrypto loaded\n`);

  const orgA = await scalar("select id from public.organizations order by created_at,id limit 1");
  const storeA = await scalar("select id from public.stores where org_id=$1 order by id limit 1", [orgA]);
  const variantA = await scalar("select id from public.product_variants where org_id=$1 order by sku limit 1", [orgA]);
  const formulationA = await scalar("select formulation_version_id from public.variant_formulations where org_id=$1 and variant_id=$2", [orgA, variantA]);
  const policyA = await scalar("select id from public.recommendation_policy_versions where org_id=$1 and status='published' order by version desc limit 1", [orgA]);
  const ids = {
    orgB: "a0000000-0000-4000-8000-000000000001", storeA2: "a0000000-0000-4000-8000-000000000002", storeB: "a0000000-0000-4000-8000-000000000003",
    ownerA: "a0000000-0000-4000-8000-000000000011", managerA: "a0000000-0000-4000-8000-000000000012", viewerA: "a0000000-0000-4000-8000-000000000013", ownerB: "a0000000-0000-4000-8000-000000000014",
    deviceUserA: "a0000000-0000-4000-8000-000000000015", deviceUserB: "a0000000-0000-4000-8000-000000000016", unpaired: "a0000000-0000-4000-8000-000000000017", unpaired2: "a0000000-0000-4000-8000-000000000018",
    deviceA: "a0000000-0000-4000-8000-000000000021", deviceB: "a0000000-0000-4000-8000-000000000022", managerMembership: "a0000000-0000-4000-8000-000000000023", viewerMembership: "a0000000-0000-4000-8000-000000000024",
    brandB: "a0000000-0000-4000-8000-000000000025", categoryB: "a0000000-0000-4000-8000-000000000026", request: "a0000000-0000-4000-8000-000000000027",
  };
  for (const userId of [ids.ownerA,ids.managerA,ids.viewerA,ids.ownerB,ids.deviceUserA,ids.deviceUserB,ids.unpaired,ids.unpaired2]) await query("insert into auth.users(id) values($1)", [userId]);
  await query("insert into public.organizations(id,name) values($1,'Other tenant')", [ids.orgB]);
  await query("insert into public.stores(id,org_id,name) values($1,$2,'Second store'),($3,$4,'Other tenant store')", [ids.storeA2,orgA,ids.storeB,ids.orgB]);
  await query("insert into public.memberships(org_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')", [orgA,ids.ownerA,ids.orgB,ids.ownerB]);
  await query("insert into public.memberships(id,org_id,user_id,role) values($1,$2,$3,'manager'),($4,$2,$5,'viewer')", [ids.managerMembership,orgA,ids.managerA,ids.viewerMembership,ids.viewerA]);
  await query("insert into public.membership_stores(org_id,membership_id,store_id) values($1,$2,$4),($1,$3,$4)", [orgA,ids.managerMembership,ids.viewerMembership,storeA]);
  await query("insert into public.devices(id,org_id,store_id,auth_user_id,label) values($1,$2,$3,$4,'Kiosk A'),($5,$6,$7,$8,'Kiosk B')", [ids.deviceA,orgA,storeA,ids.deviceUserA,ids.deviceB,ids.orgB,ids.storeB,ids.deviceUserB]);
  await query("insert into public.brands(id,org_id,name) values($1,$2,'Other brand')", [ids.brandB,ids.orgB]);
  await query("insert into public.categories(id,org_id,name) values($1,$2,'serum')", [ids.categoryB,ids.orgB]);
  await query("insert into public.store_daily_metrics(org_id,store_id,day) values($1,$2,current_date),($1,$3,current_date),($4,$5,current_date)", [orgA,storeA,ids.storeA2,ids.orgB,ids.storeB]);

  await test("every public domain table enables RLS", async () => {
    assert.equal(await scalar("select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity"), 0);
  });
  await test("anonymous role has no direct customer or catalog table access", async () => {
    await rejectCode(() => asRole("anon",null,false,() => query("select * from public.products")), "42501");
  });
  await test("Auth signup hook allows server anonymous devices and email business identities without trusting user metadata", async () => {
    await asRole("supabase_auth_admin",null,false,async () => {
      assert.deepEqual(await scalar("select public.senmiva_before_user_created($1::jsonb)",[JSON.stringify({user:{is_anonymous:true}})]),{});
      assert.deepEqual(await scalar("select public.senmiva_before_user_created($1::jsonb)",[JSON.stringify({user:{is_anonymous:false,email:"owner@example.invalid",app_metadata:{provider:"email"},user_metadata:{role:"owner",organization_id:orgA}}})]),{});
      for (const event of [{}, {user:{is_anonymous:false}}, {user:{is_anonymous:"true"}}, {user:{is_anonymous:null}}, {user:{user_metadata:{is_anonymous:true}}}, {user:{is_anonymous:false,email:"owner@example.invalid",app_metadata:{provider:"google"},user_metadata:{provider:"email"}}}]) {
        assert.equal((await scalar("select public.senmiva_before_user_created($1::jsonb)",[JSON.stringify(event)])).error.http_code,403);
      }
    });
  });
  await test("browser and API roles cannot directly invoke the Auth signup hook", async () => {
    for (const role of ["anon","authenticated","service_role"]) await rejectCode(() => asRole(role,null,false,() => query("select public.senmiva_before_user_created('{}'::jsonb)")),"42501");
  });
  const onboarding = {
    owner: "a5000000-0000-4000-8000-000000000001", unconfirmed: "a5000000-0000-4000-8000-000000000002",
    anonymous: "a5000000-0000-4000-8000-000000000003", inactive: "a5000000-0000-4000-8000-000000000004",
    manager: "a5000000-0000-4000-8000-000000000005", oauth: "a5000000-0000-4000-8000-000000000006",
    passwordless: "a5000000-0000-4000-8000-000000000007",
  };
  for (const [kind,userId] of Object.entries(onboarding)) await query(
    "insert into auth.users(id,email,encrypted_password,is_anonymous,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)",
    [userId, `${kind}@example.invalid`, kind === "passwordless" ? "" : "test-verifier", kind === "anonymous", kind === "unconfirmed" ? null : new Date().toISOString(), JSON.stringify({provider:kind === "oauth" ? "google" : "email"}), JSON.stringify({role:"owner",organization_id:orgA,email_confirmed:true,is_anonymous:false,provider:"email"})],
  );
  await query("insert into public.memberships(org_id,user_id,role,active) values($1,$2,'owner',false),($1,$3,'manager',true)",[orgA,onboarding.inactive,onboarding.manager]);
  let newOwnerContext;
  await test("owner setup eligibility reveals only a boolean for the caller's verified account", async () => {
    assert.equal(await asRole("authenticated",onboarding.owner,false,() => scalar("select public.owner_setup_eligible()")),true);
    for (const anonymous of [null,undefined,"false",true]) assert.equal(await asRole("authenticated",onboarding.owner,anonymous,() => scalar("select public.owner_setup_eligible()")),false);
    for (const kind of ["unconfirmed","inactive","manager","oauth","passwordless"]) assert.equal(await asRole("authenticated",onboarding[kind],false,() => scalar("select public.owner_setup_eligible()")),false);
    for (const anonymous of [true,false]) assert.equal(await asRole("authenticated",onboarding.anonymous,anonymous,() => scalar("select public.owner_setup_eligible()")),false);
    for (const role of ["anon","service_role","analysis_writer"]) await rejectCode(() => asRole(role,null,false,() => scalar("select public.owner_setup_eligible()")),"42501");
  });
  await test("owner setup cannot reuse an enrolled device identity even if an operator changes its Auth type", async () => {
    const fixture = "a5000000-0000-4000-8000-000000000099";
    await query("insert into public.devices(id,org_id,store_id,auth_user_id,label) values($1,$2,$3,$4,'Identity boundary fixture')",[fixture,orgA,storeA,onboarding.owner]);
    assert.equal(await asRole("authenticated",onboarding.owner,false,() => scalar("select public.owner_setup_eligible()")),false);
    await rejectCode(() => asRole("authenticated",onboarding.owner,false,() => scalar("select public.create_owner_workspace('Enrolled device business','Store')")),"42501");
    await query("delete from public.devices where id=$1",[fixture]);
  });
  await test("owner onboarding rejects unconfirmed, anonymous, inactive, manager and unsupported identities", async () => {
    for (const kind of ["unconfirmed","inactive","manager","oauth","passwordless"]) await rejectCode(() => asRole("authenticated",onboarding[kind],false,() => scalar("select public.create_owner_workspace('Forbidden business','Store')")),"42501");
    for (const anonymous of [true,false]) await rejectCode(() => asRole("authenticated",onboarding.anonymous,anonymous,() => scalar("select public.create_owner_workspace('Forbidden business','Store')")),"42501");
    assert.equal(await scalar("select count(*)::int from public.organizations where name='Forbidden business'"),0);
  });
  await test("unauthenticated and trusted-writer roles cannot invoke owner onboarding", async () => {
    for (const role of ["anon","service_role","analysis_writer"]) await rejectCode(() => asRole(role,null,false,() => scalar("select public.create_owner_workspace('Forbidden business','Store')")),"42501");
  });
  await test("owner onboarding validates names before creating records", async () => {
    for (const name of [null," ","x".repeat(121),"Business\nName"]) await rejectCode(() => asRole("authenticated",onboarding.owner,false,() => scalar("select public.create_owner_workspace($1,'Store')",[name])),"22023");
  });
  await test("confirmed business owner receives a fresh normalized workspace regardless of tenant metadata", async () => {
    newOwnerContext = await asRole("authenticated",onboarding.owner,false,() => scalar("select public.create_owner_workspace('  New business  ','  First store  ')"),true);
    assert.equal(newOwnerContext.organization_name,"New business");
    assert.equal(newOwnerContext.role,"owner");
    assert.equal(newOwnerContext.stores[0].name,"First store");
    assert.equal(newOwnerContext.stores[0].currency,"USD");
    assert.equal(newOwnerContext.stores[0].location,"");
    assert.notEqual(newOwnerContext.organization_id,orgA);
    assert.equal(await scalar("select count(*)::int from public.memberships where user_id=$1",[onboarding.owner]),1);
    assert.equal(await scalar("select count(*)::int from public.stores where org_id=$1",[newOwnerContext.organization_id]),1);
    assert.equal(await scalar("select count(*)::int from public.products where org_id=$1",[newOwnerContext.organization_id]),0);
  });
  await test("new owner receives a published immutable mock policy with exactly 19 normalized rules", async () => {
    assert.deepEqual(await query("select status,source from public.recommendation_policy_versions where org_id=$1",[newOwnerContext.organization_id]),[{status:"published",source:"mock-onboarding-v1"}]);
    assert.equal(await scalar("select count(*)::int from public.concern_ingredient_rules where org_id=$1",[newOwnerContext.organization_id]),19);
    await rejectCode(() => query("update public.recommendation_policy_versions set source='operator-configured' where org_id=$1",[newOwnerContext.organization_id]),"23514");
    await rejectCode(() => query("delete from public.concern_ingredient_rules where org_id=$1",[newOwnerContext.organization_id]),"23514");
  });
  await test("owner onboarding retries return one workspace and cannot create a second organization", async () => {
    assert.equal(await asRole("authenticated",onboarding.owner,false,() => scalar("select public.owner_setup_eligible()")),false);
    assert.deepEqual(await asRole("authenticated",onboarding.owner,false,() => scalar("select public.create_owner_workspace('New business','First store')"),true),newOwnerContext);
    await rejectCode(() => asRole("authenticated",onboarding.owner,false,() => scalar("select public.create_owner_workspace('Different business','First store')")),"23505");
    assert.equal(await scalar("select count(*)::int from public.memberships where user_id=$1",[onboarding.owner]),1);
  });
  await test("new owner cannot read another tenant or bypass narrow onboarding writes", async () => {
    await asRole("authenticated",onboarding.owner,false,async () => {
      assert.deepEqual((await query("select id from public.organizations")).map(row => row.id),[newOwnerContext.organization_id]);
    });
    await rejectCode(() => asRole("authenticated",onboarding.owner,false,() => scalar("select public.read_store_catalog($1)",[storeA])),"42501");
    await rejectCode(() => asRole("authenticated",onboarding.owner,false,() => query("insert into public.organizations(name) values('Direct bypass')")),"42501");
  });
  await test("owner reads only their tenant organizations and stores", async () => {
    await asRole("authenticated",ids.ownerA,false,async () => {
      assert.deepEqual((await query("select id from public.organizations")).map((row) => row.id), [orgA]);
      assert.equal(await scalar("select count(*)::int from public.stores"),2);
    });
  });
  await test("anonymous JWT cannot borrow a staff membership", async () => {
    await rejectCode(() => asRole("authenticated",ids.ownerA,true,() => query("select public.staff_context()")), "42501");
  });
  await test("manager reads only assigned stores and their aggregate metrics", async () => {
    await asRole("authenticated",ids.managerA,false,async () => {
      assert.deepEqual((await query("select id from public.stores")).map((row) => row.id),[storeA]);
      assert.equal(await scalar("select count(*)::int from public.store_daily_metrics"),1);
      assert.ok((await query("select * from public.read_store_catalog($1)",[storeA])).length > 0);
    });
    await rejectCode(() => asRole("authenticated",ids.managerA,false,() => query("select * from public.read_store_catalog($1)",[ids.storeA2])), "42501");
  });
  await test("viewer can read assigned metrics but not individual customer sessions or catalog RPC", async () => {
    await asRole("authenticated",ids.viewerA,false,async () => {
      assert.equal(await scalar("select count(*)::int from public.store_daily_metrics"),1);
      assert.equal(await scalar("select count(*)::int from public.kiosk_sessions"),0);
    });
    await rejectCode(() => asRole("authenticated",ids.viewerA,false,() => query("select * from public.read_store_catalog($1)",[storeA])), "42501");
  });
  await test("all client table writes are denied even to organization owners", async () => {
    await rejectCode(() => asRole("authenticated",ids.ownerA,false,() => query("update public.store_listings set stock=999 where org_id=$1",[orgA])), "42501");
  });
  await test("tenant-safe product/brand/category FK rejects a cross-tenant relationship", async () => {
    await rejectCode(() => query("insert into public.products(org_id,brand_id,category_id,name) values($1,$2,$3,'Cross tenant product')",[orgA,ids.brandB,ids.categoryB]), "23503");
  });
  await test("tenant-safe membership/store FK rejects cross-tenant assignment", async () => {
    await rejectCode(() => query("insert into public.membership_stores values($1,$2,$3)",[orgA,ids.managerMembership,ids.storeB]), "23503");
  });
  await test("published formulation and policy snapshots cannot be updated", async () => {
    await rejectCode(() => query("update public.formulation_versions set complete=false where id=$1",[formulationA]), "23514");
    await rejectCode(() => query("update public.recommendation_policy_versions set version=999 where id=$1",[policyA]), "23514");
  });
  await test("published normalized child rows cannot be updated or deleted", async () => {
    await rejectCode(() => query("delete from public.formulation_ingredients where formulation_version_id=$1",[formulationA]), "23514");
    await rejectCode(() => query("update public.concern_ingredient_rules set relevance=1 where policy_version_id=$1",[policyA]), "23514");
  });
  await test("published formulation children cannot be moved to a draft version", async () => {
    const target = await scalar("insert into public.formulation_versions(org_id,product_id,version) select org_id,product_id,999 from public.formulation_versions where id=$1 returning id",[formulationA]);
    await rejectCode(() => query("update public.formulation_ingredients set formulation_version_id=$1 where formulation_version_id=$2",[target,formulationA]),"23514");
  });
  await test("catalog batch import rolls back all drafts when one listing has invalid stock", async () => {
    const valid = { sku: "ATOMIC-VALID", brand: "Atomic test", name: "Atomic serum", category: "serum", price_minor: 2000, stock: 1, ingredients: ["Aqua","Glycerin"], skin_types: ["dry"], formulation_complete: true };
    const invalid = { ...valid, sku: "ATOMIC-INVALID", stock: -1 };
    await rejectCode(() => asRole("authenticated",ids.ownerA,false,() => query("select public.import_catalog_drafts($1,$2::jsonb)",[storeA,JSON.stringify([valid,invalid])]),true),"23514");
    assert.equal(await scalar("select count(*)::int from public.product_variants where org_id=$1 and sku like 'ATOMIC-%'",[orgA]),0);
    assert.equal(await scalar("select count(*)::int from public.brands where org_id=$1 and name='Atomic test'",[orgA]),0);
  });
  await test("catalog RPC rejects missing or null array payloads", async () => {
    const valid = { sku: "NULL-TEST", brand: "Null test", name: "Null test serum", category: "serum", price_minor: 2000, stock: 1, ingredients: ["Aqua"], skin_types: [], formulation_complete: false };
    for (const payload of [null,{}, { ...valid, ingredients: null }, { ...valid, skin_types: null }]) {
      await rejectCode(() => asRole("authenticated",ids.ownerA,false,() => query("select public.save_catalog_draft($1,$2::jsonb)",[storeA,JSON.stringify(payload)])),"22023");
    }
  });
  const unresolvedDraft = { sku: "UNRESOLVED-REVIEW", brand: "Review test", name: "Review serum", category: "serum", price_minor: 2000, stock: 1, ingredients: ["Aqua","Unreviewed Extract"], skin_types: ["dry"], formulation_complete: true };
  let unresolvedVariant;
  await test("unknown ingredients round-trip in drafts and always mark the formula incomplete", async () => {
    unresolvedVariant = await asRole("authenticated",ids.ownerA,false,() => scalar("select public.save_catalog_draft($1,$2::jsonb)",[storeA,JSON.stringify(unresolvedDraft)]),true);
    const rows = await asRole("authenticated",ids.ownerA,false,() => query("select * from public.read_store_catalog($1) where id=$2",[storeA,unresolvedVariant]));
    assert.deepEqual(rows[0].ingredients,["Aqua","Unreviewed Extract"]);
    assert.deepEqual(rows[0].unresolved_ingredients,["Unreviewed Extract"]);
    assert.equal(rows[0].formulation_complete,false);
  });
  await test("unresolved draft ingredients prevent publication through RPC and direct status change", async () => {
    await rejectCode(() => asRole("authenticated",ids.ownerA,false,() => query("select public.publish_catalog_variant($1)",[unresolvedVariant])),"22023");
    await rejectCode(() => query("update public.formulation_versions set status='published',published_at=now(),complete=true where org_id=$1 and product_id=(select product_id from public.product_variants where id=$2)",[orgA,unresolvedVariant]),"23514");
  });
  await test("resolving a draft permits publication while preserving per-store visibility", async () => {
    await asRole("authenticated",ids.ownerA,false,async () => {
      await query("select public.save_catalog_draft($1,$2::jsonb)",[storeA,JSON.stringify({ ...unresolvedDraft, ingredients: ["Aqua","Glycerin"] })]);
      await query("select public.publish_catalog_variant($1)",[unresolvedVariant]);
      const [row] = await query("select * from public.read_store_catalog($1) where id=$2",[storeA,unresolvedVariant]);
      assert.equal(row.status,"published");
      assert.equal(row.visible,false);
      assert.deepEqual(row.unresolved_ingredients,[]);
    },true);
  });
  await test("unpaired anonymous device cannot start a consultation", async () => {
    await rejectCode(() => asRole("authenticated",ids.unpaired,true,() => query("select public.start_kiosk_session()")), "42501");
  });
  await test("paired device catalog is its own store's published, visible and in-stock listings", async () => {
    await asRole("authenticated",ids.deviceUserA,true,async () => {
      const rows = await query("select * from public.read_store_catalog($1)",[storeA]);
      assert.ok(rows.length > 0);
      assert.ok(rows.every((row) => row.organization_id === orgA && row.store_id === storeA && row.status === "published" && row.visible && row.stock > 0 && row.formulation_complete));
    });
    await rejectCode(() => asRole("authenticated",ids.deviceUserA,true,() => query("select * from public.read_store_catalog($1)",[ids.storeB])), "42501");
  });
  await test("authenticated clients cannot invoke analysis writer functions", async () => {
    await rejectCode(() => asRole("authenticated",ids.ownerA,false,() => query("select public.write_analysis_result($1,$2,'mock','test','demo','[]')",[ids.request,ids.request])), "42501");
  });
  await test("dedicated writer has no unrestricted table permissions or maintenance access", async () => {
    await rejectCode(() => asRole("analysis_writer",null,false,() => query("select * from public.kiosk_sessions")), "42501");
    await rejectCode(() => asRole("analysis_writer",null,false,() => query("select private.cleanup_expired_data()")), "42501");
  });
  const sessionA = await asRole("authenticated",ids.deviceUserA,true,() => scalar("select public.start_kiosk_session()"),true);
  const sessionB = await asRole("authenticated",ids.deviceUserB,true,() => scalar("select public.start_kiosk_session()"),true);
  await test("session start is idempotent with one active session per device", async () => {
    assert.equal(await asRole("authenticated",ids.deviceUserA,true,() => scalar("select public.start_kiosk_session()")),sessionA);
    assert.equal(await scalar("select count(*)::int from public.kiosk_sessions where device_id=$1 and status='active'",[ids.deviceA]),1);
  });
  await test("device RLS sees its own active session and never the other tenant session", async () => {
    await asRole("authenticated",ids.deviceUserA,true,async () => assert.deepEqual((await query("select id from public.kiosk_sessions")).map((row) => row.id),[sessionA]));
    await rejectCode(() => asRole("authenticated",ids.deviceUserA,true,() => query("select public.read_kiosk_session($1)",[sessionB])), "42501");
  });
  await test("writer cannot analyze before consent and completed questionnaire", async () => {
    await rejectCode(() => asRole("analysis_writer",null,false,() => query("select public.write_analysis_result($1,$2,'mock','test','demo','[]')",[sessionA,ids.request])), "42501");
  });
  await test("declining consent immediately ends the consultation without analysis", async () => {
    await asRole("authenticated",ids.deviceUserB,true,async () => {
      await query("select public.record_consent($1,'2026-10-mvp',false)",[sessionB]);
      assert.equal(await scalar("select count(*)::int from public.kiosk_sessions where id=$1",[sessionB]),0);
    });
    // The test transaction rolls back, keeping the original second session for expiry checks.
  });
  await test("cancelling after questionnaire completion does not count an analyzed consultation", async () => {
    const before = await scalar("select coalesce(sum(sessions_completed),0)::int from public.store_daily_metrics where org_id=$1 and store_id=$2",[ids.orgB,ids.storeB]);
    await asRole("authenticated",ids.deviceUserB,true,async () => {
      await query("select public.record_consent($1,'2026-10-mvp',true)",[sessionB]);
      await query("select public.save_answers($1,'dry',array['dehydration'],array[]::text[])",[sessionB]);
      await query("select public.finish_kiosk_session($1)",[sessionB]);
      await query("select public.finish_kiosk_session($1)",[sessionB]);
      await db.exec("reset role");
      assert.equal(await scalar("select coalesce(sum(sessions_completed),0)::int from public.store_daily_metrics where org_id=$1 and store_id=$2",[ids.orgB,ids.storeB]),before);
      assert.equal(await scalar("select status from public.kiosk_sessions where id=$1",[sessionB]),"finished");
    });
  });
  await asRole("authenticated",ids.deviceUserA,true,async () => {
    await query("select public.record_consent($1,'2026-10-mvp',true)",[sessionA]);
    await query("select public.save_answers($1,'dry',array['dehydration','texture'],array[]::text[])",[sessionA]);
  },true);
  await test("consent choice is immutable and only supported policy versions are accepted", async () => {
    await rejectCode(() => asRole("authenticated",ids.deviceUserA,true,() => query("select public.record_consent($1,'2026-10-mvp',false)",[sessionA])), "22023");
  });
  await test("writer rejects real-model claims in mock release", async () => {
    await rejectCode(() => asRole("analysis_writer",null,false,() => query("select public.write_analysis_result($1,$2,'model','test','demo','[]')",[sessionA,ids.request])), "22023");
  });
  const observation = JSON.stringify([{ concern_id: "dehydration", score: 0.5, level: "moderate" }]);
  const analysisA = await asRole("analysis_writer",null,false,() => scalar("select public.write_analysis_result($1,$2,'mock','test-mock','demo',$3::jsonb)",[sessionA,ids.request,observation]),true);
  await test("analysis request idempotency returns the existing normalized analysis", async () => {
    assert.equal(await asRole("analysis_writer",null,false,() => scalar("select public.write_analysis_result($1,$2,'mock','test-mock','demo',$3::jsonb)",[sessionA,ids.request,observation])),analysisA);
    assert.equal(await scalar("select count(*)::int from public.observations where analysis_id=$1",[analysisA]),1);
  });
  await test("session result disclaimer explicitly excludes photo and AI measurement", async () => {
    const data = await asRole("authenticated",ids.deviceUserA,true,() => scalar("select public.read_kiosk_session($1)",[sessionA]));
    assert.equal(data.analysis.disclaimer,"Demo results generated from your questionnaire, not from a photo or AI skin measurement. For cosmetic guidance only; not a medical diagnosis.");
  });
  await test("answers are locked after analysis", async () => {
    await rejectCode(() => asRole("authenticated",ids.deviceUserA,true,() => query("select public.save_answers($1,'normal',array['texture'],array[]::text[])",[sessionA])), "22023");
  });
  await test("staff cannot read individual consultation answers or analysis rows", async () => {
    await asRole("authenticated",ids.ownerA,false,async () => {
      assert.equal(await scalar("select count(*)::int from public.analyses"),0);
      assert.equal(await scalar("select count(*)::int from public.session_concerns"),0);
    });
  });
  const match = (await query("select vf.variant_id,c.slug concern,i.inci_name ingredient,r.relevance from public.variant_formulations vf join public.store_listings l on l.org_id=vf.org_id and l.variant_id=vf.variant_id join public.formulation_ingredients fi on fi.org_id=vf.org_id and fi.formulation_version_id=vf.formulation_version_id join public.concern_ingredient_rules r on r.org_id=fi.org_id and r.ingredient_id=fi.ingredient_id join public.concerns c on c.id=r.concern_id join public.ingredients i on i.id=r.ingredient_id where vf.org_id=$1 and r.policy_version_id=$2 and c.slug='dehydration' and l.store_id=$3 and l.visible and l.stock>0 order by r.relevance desc,vf.variant_id limit 1",[orgA,policyA,storeA]))[0];
  assert.ok(match,"Seed must contain an approved hydration ingredient match.");
  const items = JSON.stringify([{ variant_id: match.variant_id, score: match.relevance, matched_ingredients: [match.ingredient], reasons: [{ concern: match.concern, ingredient: match.ingredient, relevance: match.relevance }] }]);
  await test("recommendation persistence rejects ineligible store inventory", async () => {
    await db.exec("begin");
    try {
      await query("update public.store_listings set stock=0 where org_id=$1 and store_id=$2 and variant_id=$3",[orgA,storeA,match.variant_id]);
      await db.exec("set local role analysis_writer");
      await rejectCode(() => query("select public.persist_recommendations($1,$2,$3,$4::jsonb)",[sessionA,analysisA,policyA,items]),"22023");
    } finally { await db.exec("rollback"); }
  });
  await test("recommendation persistence rejects mismatched ingredient reasons", async () => {
    const invalid = JSON.stringify([{ variant_id: match.variant_id, score: 3, matched_ingredients: ["Unreviewed Extract"], reasons: [{ concern: "dehydration", ingredient: "Unreviewed Extract", relevance: 3 }] }]);
    await rejectCode(() => asRole("analysis_writer",null,false,() => query("select public.persist_recommendations($1,$2,$3,$4::jsonb)",[sessionA,analysisA,policyA,invalid])),"22023");
  });
  await test("recommendation persistence rejects a deactivated store", async () => {
    await db.exec("begin");
    try {
      await query("update public.stores set active=false where id=$1",[storeA]);
      await db.exec("set local role analysis_writer");
      await rejectCode(() => query("select public.persist_recommendations($1,$2,$3,$4::jsonb)",[sessionA,analysisA,policyA,items]),"42501");
    } finally { await db.exec("rollback"); }
  });
  await test("recommendation persistence rejects missing or null matching reasons", async () => {
    for (const reasons of [undefined,null]) {
      const invalid = JSON.stringify([{ variant_id: match.variant_id, score: 3, reasons, matched_ingredients: reasons }]);
      await rejectCode(() => asRole("analysis_writer",null,false,() => query("select public.persist_recommendations($1,$2,$3,$4::jsonb)",[sessionA,analysisA,policyA,invalid])),"22023");
    }
  });
  const run = await asRole("analysis_writer",null,false,() => scalar("select public.persist_recommendations($1,$2,$3,$4::jsonb)",[sessionA,analysisA,policyA,items]),true);
  await test("validated recommendation run is idempotent and readable only by its device", async () => {
    assert.equal(await asRole("analysis_writer",null,false,() => scalar("select public.persist_recommendations($1,$2,$3,$4::jsonb)",[sessionA,analysisA,policyA,items])),run);
    const data = await asRole("authenticated",ids.deviceUserA,true,() => scalar("select public.read_kiosk_session($1)",[sessionA]));
    assert.equal(data.recommendations.length,1);
    assert.equal(data.analysis.mode,"mock");
    assert.deepEqual(data.recommendations[0].matched_ingredients,[match.ingredient]);
  });
  await test("finish purges answers, observations and recommendations while retaining minimal consent", async () => {
    await asRole("authenticated",ids.deviceUserA,true,() => query("select public.finish_kiosk_session($1)",[sessionA]),true);
    assert.equal(await scalar("select count(*)::int from public.analyses where session_id=$1",[sessionA]),0);
    assert.equal(await scalar("select count(*)::int from public.session_concerns where session_id=$1",[sessionA]),0);
    assert.equal(await scalar("select count(*)::int from public.recommendation_runs where session_id=$1",[sessionA]),0);
    assert.equal(await scalar("select count(*)::int from public.consents where session_id=$1",[sessionA]),1);
    assert.equal(await scalar("select skin_type_id from public.kiosk_sessions where id=$1",[sessionA]),null);
  });
  await test("finish is idempotent and the finished session becomes unreadable", async () => {
    await asRole("authenticated",ids.deviceUserA,true,() => query("select public.finish_kiosk_session($1)",[sessionA]),true);
    assert.equal(await scalar("select sum(sessions_completed)::int from public.store_daily_metrics where org_id=$1 and store_id=$2",[orgA,storeA]),1);
    await rejectCode(() => asRole("authenticated",ids.deviceUserA,true,() => query("select public.read_kiosk_session($1)",[sessionA])),"42501");
  });
  await test("privacy cleanup expires idle sessions and removes retained metadata on schedule", async () => {
    await query("update public.kiosk_sessions set last_activity_at=now()-interval '16 minutes' where id=$1",[sessionB]);
    const result = await scalar("select private.cleanup_expired_data()");
    assert.equal(result.expired_sessions,1);
    assert.equal(await scalar("select status from public.kiosk_sessions where id=$1",[sessionB]),"expired");
    await query("update public.consents set recorded_at=now()-interval '31 days' where session_id=$1",[sessionA]);
    await query("insert into public.audit_events(org_id,action,created_at) values($1,'test.old',now()-interval '91 days')",[orgA]);
    const retention = await scalar("select private.cleanup_expired_data()");
    assert.equal(retention.deleted_consents,1);
    assert.ok(retention.deleted_audits >= 1);
  });
  await test("pairing code is single use and stores only its hash", async () => {
    const code = await asRole("authenticated",ids.ownerA,false,() => scalar("select public.create_pairing_code($1,'New kiosk')",[storeA]),true);
    assert.match(code.pairing_code,/^[A-F0-9]{16}$/);
    await asRole("authenticated",ids.unpaired,true,() => query("select public.pair_device($1)",[code.pairing_code]),true);
    await rejectCode(() => asRole("authenticated",ids.unpaired2,true,() => query("select public.pair_device($1)",[code.pairing_code])),"22023");
    assert.equal(await scalar("select count(*)::int from public.device_pairing_codes where used_at is not null"),1);
  });
  await test("revoking a device blocks new consultations immediately", async () => {
    await asRole("authenticated",ids.ownerA,false,() => query("select public.revoke_device($1)",[ids.deviceA]),true);
    await rejectCode(() => asRole("authenticated",ids.deviceUserA,true,() => query("select public.start_kiosk_session()")),"42501");
  });
} catch (error) {
  failed += 1;
  process.stderr.write(`FATAL setup or fixture failure [${error.code ?? "assertion"}]: ${error.message}\n`);
} finally {
  await db.close();
  process.stdout.write(`\nRuntime PostgreSQL checks: ${passed} passed, ${failed} failed.\n`);
  if (failed) process.exitCode = 1;
}
