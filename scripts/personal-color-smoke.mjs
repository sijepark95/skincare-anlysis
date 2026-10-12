/** Local no-email acceptance: real anonymous pairing/BFF and synthetic typed color output.
 * No image, external AI request, staff signup, customer account or existing catalog write.
 * Merchant publication RPCs run as a DB-only fixture staff claim, not a live staff login.
 */
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { loadSetupEnv, postgresOptions } from "./lib/supabase-setup-config.mjs";
import {
  liveSmokeConfig,
  SmokeCookieJar,
  cleanupSmokeFixtures,
} from "./supabase-smoke.mjs";

if (process.argv.length === 2) {
  console.log(
    "Prepared only: --local-synthetic runs generated local color fixtures. No database, network, photo or external AI request was accessed.",
  );
  process.exit(0);
}
if (process.argv.length !== 3 || process.argv[2] !== "--local-synthetic") {
  console.error(
    "Usage: node scripts/personal-color-smoke.mjs --local-synthetic",
  );
  process.exit(1);
}
const env = loadSetupEnv(),
  config = liveSmokeConfig(env);
const sql = postgres(config.adminUrl, postgresOptions(config.adminUrl, env));
const writer = postgres(
  config.writerUrl,
  postgresOptions(config.writerUrl, env),
);
const options = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
};
const admin = createClient(config.apiUrl, config.serviceKey, options);
const anonymous = createClient(config.apiUrl, config.publishableKey, options);
const origin = "http://127.0.0.1:3000";
const fixtures = ["A", "B"].map((suffix) => ({
  orgId: randomUUID(),
  storeId: randomUUID(),
  name: `Senmiva smoke color ${randomUUID()} ${suffix}`,
}));
const jars = [new SmokeCookieJar(), new SmokeCookieJar()];
const users = new Set(),
  variants = new Map();
const otherStore = randomUUID();
const colorTables = [
  "session_color_quality_flags",
  "session_color_analyses",
  "session_color_preferences",
  "session_color_attempts",
  "session_color_consents",
];
const extraTables = [
  ...colorTables,
  "variant_shades",
  "variant_shade_versions",
  "analysis_vision_features",
  "analysis_vision_quality_flags",
  "analysis_vision_outputs",
  "session_vision_attempts",
  "session_vision_consents",
  "recommendation_product_explanations",
  "recommendation_explanation_runs",
  "session_explanation_consents",
];
const noticeVersion = "2026-10-personal-color-photo-v1";
let provisioned = false,
  failed = false,
  stage = "readiness",
  responseFailure = "";

async function request(
  route,
  method = "GET",
  body,
  expected = 200,
  jar = jars[0],
) {
  const response = await fetch(`${origin}/api/v1/${route}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: {
      Origin: origin,
      Cookie: jar.header(),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  jar.update(response.headers.getSetCookie());
  const data = await response.json();
  const code = /^[a-z_]{1,60}$/.test(data?.error?.code ?? "")
    ? data.error.code
    : "unexpected_response";
  if (response.status !== expected)
    responseFailure = ` HTTP ${response.status} (${code}).`;
  assert.equal(response.status, expected, `HTTP ${response.status} (${code})`);
  return data;
}
async function register(
  tx,
  key,
  {
    storeId = fixtures[0].storeId,
    published = true,
    stock = 3,
    visible = true,
    excluded = false,
    warm = false,
  } = {},
) {
  const draft = {
    brand: "Synthetic color fixture",
    name: `Synthetic ${key}; not a retail product`,
    category: "lip_color",
    sku: `COLOR-${key.toUpperCase()}`,
    ingredients: [
      "Polyglyceryl-2 Triisostearate",
      "Candelilla Cera (Euphorbia Cerifera (Candelilla) Wax)",
      "CI 77891",
      "CI 45380",
      ...(excluded ? ["Menthol"] : []),
    ],
    skin_types: [],
    formulation_complete: published,
    price_minor: 2400,
    stock,
  };
  const [row] =
    await tx`select public.save_catalog_draft(${storeId}::uuid,${tx.json(draft)}::jsonb) id`;
  variants.set(key, row.id);
  if (!published) return;
  await tx`select public.publish_catalog_variant(${row.id}::uuid)`;
  const shade = {
    shadeName: warm ? "Fixture warm coral" : "Fixture soft rose",
    hueFamily: warm ? "coral" : "rose",
    undertone: warm ? "warm" : "cool",
    intensity: "soft",
    finish: "satin",
    swatchHex: warm ? "#C88174" : "#B77D93",
    reviewed: true,
  };
  await tx`select public.publish_lip_shade(${storeId}::uuid,${row.id}::uuid,${tx.json(shade)}::jsonb)`;
  await tx`select public.update_store_listing(${storeId}::uuid,${row.id}::uuid,2400,${stock},${visible})`;
}
async function newSession() {
  const session = await request("kiosk/sessions", "POST", {}, 201);
  await request(`kiosk/sessions/${session.id}/consent`, "POST", {
    accepted: true,
    visionAccepted: false,
  });
  await request(`kiosk/sessions/${session.id}/answers`, "PUT", {
    skinType: "dry",
    concerns: ["dehydration"],
    sensitive: false,
    excludedIngredients: ["Menthol"],
  });
  return session.id;
}
function assertMatches(state, keys) {
  assert.deepEqual(
    new Set(state.recommendations.map(({ product }) => product.id)),
    new Set(keys.map((key) => variants.get(key))),
  );
  assert.ok(
    state.recommendations.every(
      ({ product, shade, reasons }) =>
        product.organizationId === fixtures[0].orgId &&
        product.storeId === fixtures[0].storeId &&
        shade.variantId === product.id &&
        shade.reviewed === true &&
        reasons.length >= 2,
    ),
  );
}
async function countAttempts(id) {
  return (
    await sql`select count(*)::int n from public.session_color_attempts where session_id=${id}`
  )[0].n;
}

try {
  const health = await request("healthz");
  assert.equal(health.mode, "supabase");
  assert.equal(health.analysis, "openai");
  stage = "anonymous-only no-email fixture creation";
  const { data, error } = await anonymous.auth.signInAnonymously();
  assert.equal(error, null);
  assert.equal(data.user?.is_anonymous, true);
  users.add(data.user.id);
  const codes = fixtures.map(() =>
    randomBytes(8).toString("hex").toUpperCase(),
  );
  await sql.begin(async (tx) => {
    for (const [index, fixture] of fixtures.entries()) {
      await tx`insert into public.organizations(id,name) values(${fixture.orgId},${fixture.name})`;
      await tx`insert into public.stores(id,org_id,name) values(${fixture.storeId},${fixture.orgId},'Synthetic personal color fixture')`;
      await tx`insert into public.device_pairing_codes(org_id,store_id,code_hash,label,created_by,expires_at) values(${fixture.orgId},${fixture.storeId},${createHash("sha256").update(codes[index]).digest()},'Synthetic color tablet',${data.user.id},now()+interval '10 minutes')`;
      await tx`insert into public.memberships(org_id,user_id,role) values(${fixture.orgId},${data.user.id},'owner')`;
    }
    await tx`insert into public.stores(id,org_id,name) values(${otherStore},${fixtures[0].orgId},'Synthetic same-tenant other store')`;
    // Privileged transaction-local fixture claim exercises publication RPCs only.
    // No signed staff token is fabricated and the anonymous Auth row stays anonymous.
    await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: data.user.id, is_anonymous: false })},true)`;
    await tx.unsafe("set local role authenticated");
    await register(tx, "eligible");
    await register(tx, "warm", { warm: true });
    await register(tx, "hidden", { visible: false });
    await register(tx, "zero", { stock: 0 });
    await register(tx, "excluded", { excluded: true });
    await register(tx, "draft", { published: false, visible: false });
    await register(tx, "other-store", { storeId: otherStore });
    await register(tx, "foreign-tenant", { storeId: fixtures[1].storeId });
    await tx.unsafe("reset role");
    await tx`delete from public.memberships where user_id=${data.user.id} and org_id in ${tx(fixtures.map((f) => f.orgId))}`;
  });
  provisioned = true;
  stage = "real paired-device sessions";
  for (const [index, fixture] of fixtures.entries()) {
    const paired = await request(
      "device/pair",
      "POST",
      { code: codes[index] },
      200,
      jars[index],
    );
    assert.equal(paired.organizationId, fixture.orgId);
  }
  const id = await newSession();
  const token = jars[0].accessToken("senmiva-device");
  assert.ok(token);
  const guest = createClient(config.apiUrl, config.publishableKey, {
    ...options,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  let state = await request(`kiosk/sessions/${id}/color`);
  assert.equal(state.photoAvailable, true);
  assert.equal(state.consent, false);
  assert.equal(state.attempted, false);
  assert.equal(state.analysis, null);
  assert.equal(state.preferences, null);
  assertMatches(state, []);
  await request(`kiosk/sessions/${id}/color`, "GET", undefined, 403, jars[1]);
  stage = "separate consent, durable claim and restricted synthetic output";
  await request(`kiosk/sessions/${id}/color-consent`, "POST", {
    accepted: true,
    noticeVersion,
  });
  const claim = await guest.rpc("claim_kiosk_color_analysis", {
    p_session_id: id,
  });
  assert.equal(claim.error, null);
  assert.equal(claim.data, true);
  const requestId = randomUUID();
  assert.notEqual(requestId, id);
  const result = {
    request_id: requestId,
    mode: "openai_color",
    model_version: "gpt-4.1-mini-2025-04-14",
    prompt_version: "personal-color-suggestion-v1",
    image_quality: "usable",
    undertone: "cool",
    chroma: "soft",
    quality_flags: [],
  };
  await writer`select public.write_openai_color_analysis(${id}::uuid,${requestId}::uuid,${result.model_version},${writer.json(result)}::jsonb)`;
  state = await request(`kiosk/sessions/${id}/color`);
  assert.deepEqual(state.analysis, result);
  assert.equal(state.preferences, null);
  assertMatches(state, []);
  assert.equal(await countAttempts(id), 1);
  stage =
    "guest confirmation, actual reviewed formula/shade matches and filters";
  state = await request(`kiosk/sessions/${id}/color-preferences`, "POST", {
    paletteId: "cool_soft",
    finish: "satin",
  });
  assertMatches(state, ["eligible"]);
  assert.deepEqual(
    (await request(`kiosk/sessions/${id}/color`)).recommendations,
    state.recommendations,
  );
  const [recognized] =
    await sql`select count(*)::int n from public.unresolved_formulation_ingredients u join public.variant_formulations vf on vf.org_id=u.org_id and vf.formulation_version_id=u.formulation_version_id where vf.variant_id=${variants.get("eligible")}`;
  assert.equal(recognized.n, 0);
  stage = "palette change is photo-free and inventory stays current";
  state = await request(`kiosk/sessions/${id}/color-preferences`, "POST", {
    paletteId: "warm_soft",
    finish: "satin",
  });
  assertMatches(state, ["warm"]);
  assert.equal(await countAttempts(id), 1);
  assert.deepEqual(state.analysis, result);
  state = await request(`kiosk/sessions/${id}/color-preferences`, "POST", {
    paletteId: "cool_soft",
    finish: "gloss",
  });
  assertMatches(state, []);
  await request(`kiosk/sessions/${id}/color-preferences`, "POST", {
    paletteId: "cool_soft",
    finish: "satin",
  });
  await sql`update public.store_listings set stock=0 where org_id=${fixtures[0].orgId} and store_id=${fixtures[0].storeId} and variant_id=${variants.get("eligible")}`;
  assertMatches(await request(`kiosk/sessions/${id}/color`), []);
  stage = "withdrawal invalidates any late response and clears preferences";
  await request(`kiosk/sessions/${id}/color-consent`, "POST", {
    accepted: false,
    noticeVersion,
  });
  state = await request(`kiosk/sessions/${id}/color`);
  assert.equal(state.analysis, null);
  assert.equal(state.preferences, null);
  assert.equal(state.attempted, true);
  assertMatches(state, []);
  await request(`kiosk/sessions/${id}/color-consent`, "POST", {
    accepted: true,
    noticeVersion,
  });
  assert.equal(
    (await guest.rpc("claim_kiosk_color_analysis", { p_session_id: id })).data,
    false,
  );
  await assert.rejects(
    writer`select public.write_openai_color_analysis(${id}::uuid,${requestId}::uuid,${result.model_version},${writer.json(result)}::jsonb)`,
    (error) => error.code === "42501",
  );
  stage = "finish purge and manual photo-free continuation";
  await request(`kiosk/sessions/${id}/finish`, "POST", {});
  await request(`kiosk/sessions/${id}/color`, "GET", undefined, 403);
  for (const table of colorTables)
    assert.equal(
      (
        await sql.unsafe(
          `select count(*)::int n from public.${table} where org_id=$1`,
          [fixtures[0].orgId],
        )
      )[0].n,
      0,
    );
  const manualId = await newSession();
  const manual = await request(
    `kiosk/sessions/${manualId}/color-preferences`,
    "POST",
    { paletteId: "warm_soft", finish: "satin" },
  );
  assertMatches(manual, ["warm"]);
  assert.equal(manual.consent, false);
  assert.equal(manual.analysis, null);
  assert.equal(manual.attempted, false);
  assert.equal(await countAttempts(manualId), 0);
  await request(`kiosk/sessions/${manualId}/finish`, "POST", {});
  console.log(
    "PASS real two-tenant anonymous pairing/BFF + restricted writer: separate color consent and opaque request ID; no matches before guest confirmation; reviewed INCI/formula/shade RPC fixtures; draft/stock/visibility/exclusion/other-store/other-tenant/finish filters; photo-free palette changes; durable attempt and late-withdrawal rejection; finish purge; manual palette without photo consent or attempt. No photo or external AI request used.",
  );
} catch {
  failed = true;
  console.error(
    `Personal color acceptance failed during ${stage}.${responseFailure} No credentials, guest content or provider bodies are printed.`,
  );
} finally {
  try {
    for (const row of await sql`select auth_user_id from public.devices where org_id in ${sql(fixtures.map((f) => f.orgId))}`)
      users.add(row.auth_user_id);
    if (provisioned) {
      await sql.begin(async (tx) => {
        const owned =
          await tx`select id,name from public.organizations where id in ${tx(fixtures.map((f) => f.orgId))} for update`;
        assert.ok(
          owned.every((row) =>
            fixtures.some((f) => f.orgId === row.id && f.name === row.name),
          ),
        );
        await tx.unsafe("set local session_replication_role = replica");
        for (const table of extraTables)
          await tx.unsafe(
            `delete from public.${table} where org_id=any($1::uuid[])`,
            [fixtures.map((f) => f.orgId)],
          );
      });
      await cleanupSmokeFixtures(sql, fixtures);
    }
    for (const id of users) {
      const check = await admin.auth.admin.getUserById(id);
      assert.equal(check.error, null);
      assert.equal(check.data.user?.is_anonymous, true);
      assert.equal((await admin.auth.admin.deleteUser(id)).error, null);
    }
    console.log(
      "PASS only generated color tenant/device/anonymous Auth fixtures removed; active user catalog unchanged; no email endpoints called.",
    );
  } catch {
    failed = true;
    console.error(
      "Color fixture cleanup failed. Inspect only generated Senmiva smoke color tenants.",
    );
  }
  await Promise.all([sql.end({ timeout: 3 }), writer.end({ timeout: 3 })]);
  if (failed) process.exitCode = 1;
}
