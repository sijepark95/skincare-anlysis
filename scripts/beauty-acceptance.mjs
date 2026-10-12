/** Local no-email acceptance: real anonymous pairing/BFF and synthetic typed beauty output.
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
    "Prepared only: --local-synthetic runs generated local beauty fixtures. No database, network, photo or external AI request was accessed.",
  );
  process.exit(0);
}
if (process.argv.length !== 3 || process.argv[2] !== "--local-synthetic") {
  console.error("Usage: node scripts/beauty-acceptance.mjs --local-synthetic");
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
  name: `Senmiva smoke beauty ${randomUUID()} ${suffix}`,
}));
const jars = [new SmokeCookieJar(), new SmokeCookieJar()];
const users = new Set(),
  variants = new Map();
const otherStore = randomUUID();
const beautyTables = [
  "session_beauty_quality_flags",
  "session_beauty_analyses",
  "session_beauty_preferences",
  "session_beauty_attempts",
  "session_beauty_consents",
];
const extraTables = [
  "session_beauty_saved_guides",
  "beauty_saved_guide_products",
  "beauty_saved_guides",
  ...beautyTables,
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
const noticeVersion = "2026-10-beauty-photo-v1";
const saveNoticeVersion = "2026-10-beauty-save-v1";
const preferences = {
  paletteId: "cool_soft",
  faceShape: "oval",
  hairLength: "medium",
  mood: "fresh",
  finish: "satin",
};
const publicJar = new SmokeCookieJar();
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
    brand: "Synthetic beauty fixture",
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
  await request(`kiosk/sessions/${session.id}/beauty-exclusions`, "POST", {
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
    await sql`select count(*)::int n from public.session_beauty_attempts where session_id=${id}`
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
      await tx`insert into public.stores(id,org_id,name) values(${fixture.storeId},${fixture.orgId},'Synthetic primary beauty fixture')`;
      await tx`insert into public.device_pairing_codes(org_id,store_id,code_hash,label,created_by,expires_at) values(${fixture.orgId},${fixture.storeId},${createHash("sha256").update(codes[index]).digest()},'Synthetic beauty tablet',${data.user.id},now()+interval '10 minutes')`;
      await tx`insert into public.memberships(org_id,user_id,role) values(${fixture.orgId},${data.user.id},'owner')`;
    }
    await tx`insert into public.stores(id,org_id,name) values(${otherStore},${fixtures[0].orgId},'Synthetic same-tenant other store')`;
    // Database-only authorization fixture. No staff token, signup or email is created.
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
  stage =
    "real anonymous pairing and primary beauty without skin questionnaire";
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
  let state = await request(`kiosk/sessions/${id}/beauty`);
  assert.equal(state.photoAvailable, true);
  assert.equal(state.consent, false);
  assert.equal(state.attempted, false);
  assert.equal(state.analysis, null);
  assert.equal(state.preferences, null);
  assert.equal(state.guide, null);
  assertMatches(state, []);
  assert.deepEqual(state.excludedIngredients, ["Menthol"]);
  assert.ok(state.ingredients.includes("Menthol"));
  const [primary] =
    await sql`select answers_completed_at,skin_type_id,skin_sensitive from public.kiosk_sessions where id=${id}`;
  assert.equal(primary.answers_completed_at, null);
  assert.equal(primary.skin_type_id, null);
  assert.equal(primary.skin_sensitive, null);
  assert.equal(
    (
      await sql`select count(*)::int n from public.analyses where session_id=${id}`
    )[0].n,
    0,
  );
  await request(`kiosk/sessions/${id}/beauty`, "GET", undefined, 403, jars[1]);
  stage =
    "separate beauty consent, durable claim and restricted synthetic output";
  await request(`kiosk/sessions/${id}/beauty-consent`, "POST", {
    accepted: true,
    noticeVersion,
  });
  const claim = await guest.rpc("claim_kiosk_beauty_analysis", {
    p_session_id: id,
  });
  assert.equal(claim.error, null);
  assert.equal(claim.data, true);
  const requestId = randomUUID();
  assert.notEqual(requestId, id);
  const result = {
    request_id: requestId,
    mode: "openai_beauty",
    model_version: "gpt-4.1-mini-2025-04-14",
    prompt_version: "beauty-style-suggestion-v1",
    image_quality: "usable",
    undertone: "cool",
    chroma: "soft",
    face_shape: "oval",
    quality_flags: [],
  };
  await writer`select public.write_openai_beauty_analysis(${id}::uuid,${requestId}::uuid,${result.model_version},${writer.json(result)}::jsonb)`;
  state = await request(`kiosk/sessions/${id}/beauty`);
  assert.deepEqual(state.analysis, result);
  assert.equal(state.preferences, null);
  assert.equal(state.guide, null);
  assertMatches(state, []);
  assert.equal(await countAttempts(id), 1);
  stage =
    "guest confirmation derives makeup, hair and jewelry with actual store products";
  state = await request(
    `kiosk/sessions/${id}/beauty-preferences`,
    "POST",
    preferences,
  );
  assertMatches(state, ["eligible"]);
  assert.deepEqual(state.preferences, preferences);
  assert.equal(state.guide.version, "beauty-style-guide-v1");
  assert.equal(state.guide.palette.id, preferences.paletteId);
  assert.equal(state.guide.confirmedFaceShape, preferences.faceShape);
  for (const key of ["makeupMoods", "hairCuts", "hairColors", "jewelry"])
    assert.ok(state.guide[key].length > 0);
  assert.deepEqual(
    (await request(`kiosk/sessions/${id}/beauty`)).guide,
    state.guide,
  );
  stage =
    "local sharing is disabled without public HTTPS; capability save uses owned RPC only";
  assert.equal(state.sharingAvailable, false);
  await request(
    `kiosk/sessions/${id}/beauty-share`,
    "POST",
    { accepted: true, noticeVersion: saveNoticeVersion },
    409,
  );
  // Deliberately bypass only the HTTPS publication gate for local acceptance. No env
  // setting, tunnel, publicly usable URL or raw token persistence is introduced.
  const rawShareToken = randomBytes(32).toString("base64url");
  const shareHash = createHash("sha256").update(rawShareToken).digest("hex");
  const saved = await guest.rpc("create_kiosk_beauty_guide", {
    p_session_id: id,
    p_token_hash: shareHash,
    p_notice_version: saveNoticeVersion,
    p_accepted: true,
  });
  assert.equal(saved.error, null);
  assert.ok(saved.data.expiresAt);
  const [stored] =
    await sql`select token_hash,expires_at,created_at from public.beauty_saved_guides where token_hash=${shareHash}`;
  assert.equal(stored.token_hash, shareHash);
  assert.notEqual(stored.token_hash, rawShareToken);
  assert.equal(
    stored.expires_at.getTime() - stored.created_at.getTime(),
    7 * 24 * 60 * 60 * 1000,
  );
  stage = "public saved-guide BFF reads without guest or staff cookies";
  const shared = await request(
    "shared-results/read",
    "POST",
    { token: rawShareToken },
    200,
    publicJar,
  );
  stage = "public saved-guide version pin";
  assert.equal(shared.guideVersion, "beauty-style-guide-v1");
  stage = "public saved-guide confirmed choices";
  assert.deepEqual(shared.preferences, preferences);
  stage = "public saved-guide deterministic styling content";
  assert.deepEqual(shared.guide, state.guide);
  stage = "public saved-guide eligible product references";
  assert.deepEqual(
    shared.products.map(({ variantId }) => variantId),
    [variants.get("eligible")],
  );
  assert.equal(shared.products[0].available, true);
  stage = "public saved-guide cookie-free boundary";
  assert.equal(publicJar.header(), "");
  for (const key of [
    "sessionId",
    "analysis",
    "answers",
    "excludedIngredients",
    "organizationId",
    "storeId",
    "token",
    "tokenHash",
  ])
    assert.equal(key in shared, false);
  await request(
    "shared-results/read",
    "POST",
    { token: randomBytes(32).toString("base64url") },
    404,
    publicJar,
  );
  stage =
    "style changes and live availability never alter saved confirmed choices";
  const changedPreferences = {
    ...preferences,
    paletteId: "warm_soft",
    faceShape: "unsure",
    mood: "defined",
    hairLength: "long",
  };
  state = await request(
    `kiosk/sessions/${id}/beauty-preferences`,
    "POST",
    changedPreferences,
  );
  assertMatches(state, ["warm"]);
  assert.equal(await countAttempts(id), 1);
  assert.deepEqual(state.analysis, result);
  const unchanged = await request(
    "shared-results/read",
    "POST",
    { token: rawShareToken },
    200,
    publicJar,
  );
  assert.deepEqual(unchanged.preferences, preferences);
  assert.deepEqual(unchanged.products, shared.products);
  await sql`update public.store_listings set stock=0 where org_id=${fixtures[0].orgId} and store_id=${fixtures[0].storeId} and variant_id=${variants.get("eligible")}`;
  const unavailable = await request(
    "shared-results/read",
    "POST",
    { token: rawShareToken },
    200,
    publicJar,
  );
  assert.equal(unavailable.products.length, 1);
  assert.equal(unavailable.products[0].variantId, variants.get("eligible"));
  assert.equal(unavailable.products[0].available, false);
  stage =
    "photo withdrawal and finish purge transient data while explicit saved guide survives";
  await request(`kiosk/sessions/${id}/beauty-consent`, "POST", {
    accepted: false,
    noticeVersion,
  });
  state = await request(`kiosk/sessions/${id}/beauty`);
  assert.equal(state.analysis, null);
  assert.equal(state.preferences, null);
  assert.equal(state.attempted, true);
  assertMatches(state, []);
  await request(`kiosk/sessions/${id}/beauty-consent`, "POST", {
    accepted: true,
    noticeVersion,
  });
  assert.equal(
    (await guest.rpc("claim_kiosk_beauty_analysis", { p_session_id: id })).data,
    false,
  );
  await assert.rejects(
    writer`select public.write_openai_beauty_analysis(${id}::uuid,${requestId}::uuid,${result.model_version},${writer.json(result)}::jsonb)`,
    (error) => error.code === "42501",
  );
  await request(`kiosk/sessions/${id}/finish`, "POST", {});
  await request(`kiosk/sessions/${id}/beauty`, "GET", undefined, 403);
  for (const table of [...beautyTables, "session_beauty_saved_guides"])
    assert.equal(
      (
        await sql.unsafe(
          `select count(*)::int n from public.${table} where org_id=$1`,
          [fixtures[0].orgId],
        )
      )[0].n,
      0,
    );
  assert.deepEqual(
    (
      await request(
        "shared-results/read",
        "POST",
        { token: rawShareToken },
        200,
        publicJar,
      )
    ).preferences,
    preferences,
  );
  stage = "public capability revocation makes saved guide unreadable";
  await request(
    "shared-results/revoke",
    "POST",
    { token: randomBytes(32).toString("base64url") },
    200,
    publicJar,
  );
  await request(
    "shared-results/read",
    "POST",
    { token: rawShareToken },
    200,
    publicJar,
  );
  await request(
    "shared-results/revoke",
    "POST",
    { token: rawShareToken },
    200,
    publicJar,
  );
  await request(
    "shared-results/read",
    "POST",
    { token: rawShareToken },
    404,
    publicJar,
  );
  stage = "manual primary beauty works without photo consent or questionnaire";
  const manualId = await newSession();
  const manual = await request(
    `kiosk/sessions/${manualId}/beauty-preferences`,
    "POST",
    changedPreferences,
  );
  assertMatches(manual, ["warm"]);
  assert.equal(manual.consent, false);
  assert.equal(manual.analysis, null);
  assert.equal(manual.attempted, false);
  assert.equal(await countAttempts(manualId), 0);
  assert.ok(manual.guide);
  await request(`kiosk/sessions/${manualId}/finish`, "POST", {});
  const [metrics] =
    await sql`select sessions_started,sessions_analyzed,sessions_completed from public.store_daily_metrics where org_id=${fixtures[0].orgId} and store_id=${fixtures[0].storeId} and day=(now() at time zone 'UTC')::date`;
  assert.equal(metrics.sessions_started, 2);
  assert.equal(metrics.sessions_analyzed, 1);
  assert.equal(metrics.sessions_completed, 1);
  console.log(
    "PASS primary beauty live BFF + real two-tenant anonymous pairing + restricted writer: zero skin questionnaire/analysis; explicit beauty consent; synthetic bounded observations; no style/product auto-confirmation; makeup/hair/jewelry guide and eligible registered products; exclusion/draft/stock/visibility/store/tenant guards; one durable attempt; local HTTPS sharing gate; hash-only seven-day save via owned RPC; cookie-free public read/current availability/revoke; immutable saved choices survive finish; complete transient purge; manual no-photo guide. No image, external AI, email, public tunnel or user catalog mutation.",
  );
} catch (error) {
  failed = true;
  const location =
    typeof error?.stack === "string"
      ? (error.stack
          .split("\n")
          .find((line) => line.includes("beauty-acceptance.mjs:"))
          ?.trim() ?? "")
      : "";
  console.error(
    `Beauty acceptance failed during ${stage}.${responseFailure} ${location} No credentials, capability tokens, guest content or provider bodies are printed.`,
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
      "PASS only generated beauty tenant/device/anonymous Auth/saved-guide fixtures removed; active user catalog unchanged; no email endpoints called.",
    );
  } catch {
    failed = true;
    console.error(
      "Beauty fixture cleanup failed. Inspect only generated Senmiva smoke beauty tenants.",
    );
  }
  await Promise.all([sql.end({ timeout: 3 }), writer.end({ timeout: 3 })]);
  if (failed) process.exitCode = 1;
}
