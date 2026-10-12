/** Loopback-only generated fixtures. No photo, provider request, signup or email.
 * Staff catalog authorization exists only inside a fixture database transaction.
 */
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { loadSetupEnv, postgresOptions } from "./lib/supabase-setup-config.mjs";
import { liveSmokeConfig, SmokeCookieJar } from "./supabase-smoke.mjs";

if (process.argv.length === 2) {
  console.log(
    "Prepared only. Use --local-synthetic for generated loopback fixtures; no photo, external AI, signup or email is used.",
  );
  process.exit(0);
}
if (process.argv.length !== 3 || process.argv[2] !== "--local-synthetic") {
  console.error(
    "Usage: node scripts/beauty-complete-acceptance.mjs --local-synthetic",
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
  name: `Senmiva smoke complete ${randomUUID()} ${suffix}`,
}));
const users = new Set(),
  variants = new Map(),
  jars = [new SmokeCookieJar(), new SmokeCookieJar()];
const publicJar = new SmokeCookieJar();
const photoNotice = "2026-10-beauty-complete-photo-v1",
  previewNotice = "2026-10-beauty-preview-v1",
  saveNotice = "2026-10-complete-save-v1";
const preferences = {
  paletteId: "cool_soft",
  faceShape: "oval",
  hairLength: "any",
  mood: "fresh",
  finish: "any",
};
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
async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  assert.equal(error?.code ?? null, null, `RPC ${name} rejected`);
  return data;
}
async function register(tx, category) {
  const fixture = fixtures[0];
  const draft = {
    brand: "Synthetic complete fixture",
    name: `Synthetic ${category}; not a retail product`,
    category,
    sku: `COMPLETE-${category.toUpperCase()}`,
    ingredients: ["Aqua", "Niacinamide"],
    skin_types: [],
    formulation_complete: true,
    price_minor: 2000,
    stock: 3,
  };
  const [row] =
    await tx`select public.save_catalog_draft(${fixture.storeId}::uuid,${tx.json(draft)}::jsonb) id`;
  variants.set(category, row.id);
  await tx`select public.publish_catalog_variant(${row.id}::uuid)`;
  await tx`select public.update_store_listing(${fixture.storeId}::uuid,${row.id}::uuid,2000,3,true)`;
  if (category === "serum") return;
  const shade = {
    category,
    shadeName: "Synthetic cool candidate",
    undertone: "cool",
    finish: "satin",
    swatchHex: "#B77D93",
    reviewed: true,
    ...(["foundation", "concealer"].includes(category)
      ? { depth: "medium", coverage: "medium" }
      : { hueFamily: "rose", intensity: "soft" }),
  };
  await tx`select public.publish_cosmetic_shade(${fixture.storeId}::uuid,${row.id}::uuid,${tx.json(shade)}::jsonb)`;
}
async function newSession() {
  const { id } = await request("kiosk/sessions", "POST", {}, 201);
  await request(`kiosk/sessions/${id}/consent`, "POST", {
    accepted: true,
    visionAccepted: false,
  });
  await request(`kiosk/sessions/${id}/beauty-context`, "POST", {
    ageBand: "25-34",
    locale: "ko",
    analyticsConsent: false,
  });
  return id;
}
async function confirm(id) {
  return request(`kiosk/sessions/${id}/beauty-complete-preferences`, "POST", {
    preferences,
    baseDepth: "medium",
    baseUndertone: "cool",
    concealerPurpose: "match",
  });
}
function hash(token) {
  return createHash("sha256").update(token).digest("hex");
}
async function save(guest, id, variantIds) {
  const token = randomBytes(32).toString("base64url");
  const data = await rpc(guest, "create_complete_beauty_guide", {
    p_session_id: id,
    p_token_hash: hash(token),
    p_notice_version: saveNotice,
    p_variant_ids: variantIds,
  });
  assert.ok(data.expiresAt);
  return token;
}
try {
  const health = await request("healthz");
  assert.equal(health.mode, "supabase");
  assert.equal(health.analysis, "openai");
  stage = "generated anonymous-only tenant and reviewed catalog fixtures";
  const auth = await anonymous.auth.signInAnonymously();
  assert.equal(auth.error, null);
  assert.equal(auth.data.user?.is_anonymous, true);
  users.add(auth.data.user.id);
  const codes = fixtures.map(() =>
    randomBytes(8).toString("hex").toUpperCase(),
  );
  await sql.begin(async (tx) => {
    for (const [index, fixture] of fixtures.entries()) {
      await tx`insert into public.organizations(id,name) values(${fixture.orgId},${fixture.name})`;
      await tx`insert into public.stores(id,org_id,name) values(${fixture.storeId},${fixture.orgId},'Synthetic complete fixture')`;
      await tx`insert into public.device_pairing_codes(org_id,store_id,code_hash,label,created_by,expires_at) values(${fixture.orgId},${fixture.storeId},${Buffer.from(hash(codes[index]), "hex")},'Synthetic complete tablet',${auth.data.user.id},now()+interval '10 minutes')`;
      await tx`insert into public.memberships(org_id,user_id,role) values(${fixture.orgId},${auth.data.user.id},'owner')`;
    }
    await tx`insert into public.recommendation_policy_versions(org_id,version) values(${fixtures[0].orgId},1)`;
    await tx`insert into public.concern_ingredient_rules select ${fixtures[0].orgId},p.id,c.id,i.id,2 from public.recommendation_policy_versions p cross join public.concerns c cross join public.ingredients i where p.org_id=${fixtures[0].orgId} and c.slug='texture' and i.inci_name='Niacinamide'`;
    await tx`update public.recommendation_policy_versions set status='published',published_at=now() where org_id=${fixtures[0].orgId}`;
    await tx`select set_config('request.jwt.claims',${JSON.stringify({ sub: auth.data.user.id, is_anonymous: false })},true)`;
    await tx.unsafe("set local role authenticated");
    for (const category of [
      "serum",
      "lip_color",
      "blush",
      "eye_color",
      "foundation",
      "concealer",
    ])
      await register(tx, category);
    await tx.unsafe("reset role");
    await tx`delete from public.memberships where user_id=${auth.data.user.id} and org_id in ${tx(fixtures.map((f) => f.orgId))}`;
  });
  provisioned = true;
  stage = "actual BFF pairing, guest context and default unknown profile";
  for (const [index, fixture] of fixtures.entries())
    assert.equal(
      (
        await request(
          "device/pair",
          "POST",
          { code: codes[index] },
          200,
          jars[index],
        )
      ).organizationId,
      fixture.orgId,
    );
  const id = await newSession();
  const accessToken = jars[0].accessToken("senmiva-device");
  assert.ok(accessToken);
  const guest = createClient(config.apiUrl, config.publishableKey, {
    ...options,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  let state = await request(`kiosk/sessions/${id}/beauty-complete`);
  assert.deepEqual(state.skinProfile, {
    skinType: "unsure",
    concerns: [],
    excludedIngredients: [],
  });
  assert.equal(state.analysis, null);
  assert.equal(state.completeConsent, false);
  assert.equal(state.attempted, false);
  await request(
    `kiosk/sessions/${id}/beauty-complete`,
    "GET",
    undefined,
    403,
    jars[1],
  );
  stage =
    "separate combined consent, durable guest claim and synthetic restricted writer";
  await request(`kiosk/sessions/${id}/beauty-complete-consent`, "POST", {
    accepted: true,
    noticeVersion: photoNotice,
  });
  const requestId = await rpc(guest, "kiosk_claim_complete_analysis", {
    p_session_id: id,
  });
  const beauty = {
    request_id: requestId,
    mode: "openai_beauty",
    model_version: "gpt-4.1-mini-2025-04-14",
    prompt_version: "beauty-style-suggestion-v2",
    image_quality: "usable",
    quality_flags: [],
    undertone: "cool",
    chroma: "soft",
    face_shape: "oval",
    eye_shape: "almond",
    nose_shape: "medium",
    lip_fullness: "medium",
  };
  const skin = {
    prompt_version: "visible-appearance-eval-v1",
    image_quality: "usable",
    quality_flags: [],
    observed_features: {
      visible_pores: "visible",
      visible_redness: "uncertain",
      visible_spots: "not_visible",
      visible_fine_lines: "not_visible",
      visible_flaking: "not_visible",
    },
  };
  await writer`select public.write_openai_complete_analysis(${id}::uuid,${requestId}::uuid,${writer.json(beauty)}::jsonb,${writer.json(skin)}::jsonb)`;
  stage = "strict live read, skin persistence and all five cosmetic categories";
  state = await request(`kiosk/sessions/${id}/beauty-complete-skin`, "POST", {
    skinType: "unsure",
    concerns: [],
    excludedIngredients: [],
  });
  assert.equal(state.analysis.skin.observed_features.visible_pores, "visible");
  assert.equal(state.analysis.animalVibe, "uncertain");
  assert.deepEqual(
    state.skinRecommendations.map((item) => item.product.id),
    [variants.get("serum")],
  );
  assert.ok(
    state.skinRecommendations[0].reasons.some(
      (reason) =>
        reason.concern === "texture" && reason.ingredient === "Niacinamide",
    ),
  );
  state = await confirm(id);
  assert.deepEqual(
    new Set(state.cosmetics.map((item) => item.shade.category)),
    new Set(["lip_color", "blush", "eye_color", "foundation", "concealer"]),
  );
  assert.deepEqual(state.beauty.preferences, preferences);
  const [primary] =
    await sql`select answers_completed_at,skin_type_id,skin_sensitive from public.kiosk_sessions where id=${id}`;
  assert.deepEqual(primary, {
    answers_completed_at: null,
    skin_type_id: null,
    skin_sensitive: null,
  });
  stage =
    "nine-slot live metadata admission without any generated image or provider call";
  await request(`kiosk/sessions/${id}/beauty-preview-consent`, "POST", {
    accepted: true,
    noticeVersion: previewNotice,
  });
  const plan = await rpc(guest, "kiosk_create_preview_plan", {
    p_session_id: id,
  });
  state = await request(`kiosk/sessions/${id}/beauty-complete`);
  assert.equal(state.preview.slots.length, 9);
  assert.ok(state.preview.deadline);
  await rpc(guest, "kiosk_claim_preview_slot", {
    p_session_id: id,
    p_plan_id: plan.id,
    p_slot: 0,
  });
  await rpc(guest, "kiosk_complete_preview_slot", {
    p_session_id: id,
    p_plan_id: plan.id,
    p_slot: 0,
    p_status: "failed",
  });
  assert.equal(
    (await request(`kiosk/sessions/${id}/beauty-complete`)).preview.slots[0]
      .status,
    "failed",
  );
  stage = "local HTTPS gate and actual public BFF complete capability union";
  assert.equal(state.beauty.sharingAvailable, false);
  await request(
    `kiosk/sessions/${id}/beauty-complete-share`,
    "POST",
    { accepted: true, noticeVersion: saveNotice },
    409,
  );
  const token = await save(guest, id, [...variants.values()]);
  let shared = await request(
    "shared-results/read",
    "POST",
    { token },
    200,
    publicJar,
  );
  assert.equal(shared.version, "beauty-complete-guide-v1");
  assert.equal(shared.locale, "ko");
  assert.equal(shared.products.length, 6);
  assert.ok(shared.products.every((product) => product.available));
  assert.deepEqual(shared.preferences, preferences);
  assert.equal(publicJar.header(), "");
  for (const forbidden of [
    "analysis",
    "skinVision",
    "photo",
    "gender",
    "animalVibe",
    "ratios",
    "organizationId",
    "storeId",
    "tokenHash",
  ])
    assert.equal(forbidden in shared, false);
  const [stored] =
    await sql`select token_hash,expires_at,created_at from public.complete_beauty_saved_guides where token_hash=${hash(token)}`;
  assert.equal(stored.token_hash, hash(token));
  assert.notEqual(stored.token_hash, token);
  assert.equal(
    stored.expires_at.getTime() - stored.created_at.getTime(),
    7 * 86400000,
  );
  await sql`update public.store_listings set stock=0 where org_id=${fixtures[0].orgId} and variant_id=${variants.get("serum")}`;
  shared = await request(
    "shared-results/read",
    "POST",
    { token },
    200,
    publicJar,
  );
  assert.equal(
    shared.products.find(
      (product) => product.variantId === variants.get("serum"),
    ).available,
    false,
  );
  stage =
    "finish purges transient complete data while explicit saved guide survives";
  await request(`kiosk/sessions/${id}/beauty-complete-finish`, "POST", {
    gender: "prefer_not_to_say",
  });
  await request(`kiosk/sessions/${id}/beauty-complete`, "GET", undefined, 403);
  for (const table of [
    "session_complete_guest_context",
    "session_complete_photo_consents",
    "session_complete_analysis_attempts",
    "session_complete_preview_plans",
    "session_beauty_preferences",
    "session_beauty_analyses",
    "analyses",
  ])
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
      await rpc(anonymous, "read_complete_beauty_guide", {
        p_token_hash: hash(token),
      })
    ).preferences,
    preferences,
  );
  await request("shared-results/revoke", "POST", { token }, 200, publicJar);
  assert.equal(
    await rpc(anonymous, "read_complete_beauty_guide", {
      p_token_hash: hash(token),
    }),
    null,
  );
  await request("shared-results/read", "POST", { token }, 404, publicJar);
  stage =
    "photo-free optional goals save eligible skincare without a fabricated analysis";
  await sql`update public.store_listings set stock=3 where org_id=${fixtures[0].orgId} and variant_id=${variants.get("serum")}`;
  const manualId = await newSession();
  await confirm(manualId);
  state = await request(
    `kiosk/sessions/${manualId}/beauty-complete-skin`,
    "POST",
    { skinType: "unsure", concerns: ["texture"], excludedIngredients: [] },
  );
  assert.equal(state.analysis, null);
  assert.equal(state.attempted, false);
  assert.deepEqual(
    state.skinRecommendations.map((item) => item.product.id),
    [variants.get("serum")],
  );
  const manualToken = await save(guest, manualId, [variants.get("serum")]);
  assert.equal(
    (
      await request(
        "shared-results/read",
        "POST",
        { token: manualToken },
        200,
        publicJar,
      )
    ).products.length,
    1,
  );
  await request(`kiosk/sessions/${manualId}/beauty-complete-finish`, "POST", {
    gender: null,
  });
  await request(
    "shared-results/revoke",
    "POST",
    { token: manualToken },
    200,
    publicJar,
  );
  console.log(
    "PASS complete beauty actual BFF/anonymous pairing/strict schemas/restricted synthetic writer: pores to reviewed skincare, five confirmed cosmetic categories, unknown questionnaire, nine slot metadata, local sharing gate, hash-only seven-day capability, cookie-free public complete result/read/revoke, original availability, Finish purge and manual skincare save. No photo, external AI, email, signup, tunnel or user catalog mutation.",
  );
} catch (error) {
  failed = true;
  const location =
    typeof error?.stack === "string"
      ? (error.stack
          .split("\n")
          .find((line) => line.includes("beauty-complete-acceptance.mjs:"))
          ?.trim() ?? "")
      : "";
  console.error(
    `Complete beauty acceptance failed during ${stage}.${responseFailure} ${location} No credentials, capability tokens, customer content or provider bodies are printed.`,
  );
} finally {
  try {
    if (provisioned) {
      for (const row of await sql`select auth_user_id from public.devices where org_id in ${sql(fixtures.map((f) => f.orgId))}`)
        users.add(row.auth_user_id);
      await sql.begin(async (tx) => {
        const owned =
          await tx`select id,name from public.organizations where id in ${tx(fixtures.map((f) => f.orgId))} for update`;
        assert.equal(owned.length, 2);
        assert.ok(
          owned.every((row) =>
            fixtures.some((f) => f.orgId === row.id && f.name === row.name),
          ),
        );
        // Immutable fixture snapshots need transaction-local bypass, scoped only to
        // the exact generated tenant IDs whose original names were checked above.
        await tx.unsafe("set local session_replication_role = replica");
        const tables =
          await tx`select table_name from information_schema.columns where table_schema='public' and column_name='org_id' order by table_name`;
        for (const { table_name: table } of tables) {
          assert.match(table, /^[a-z_]+$/);
          await tx.unsafe(
            `delete from public.${table} where org_id=any($1::uuid[])`,
            [fixtures.map((f) => f.orgId)],
          );
        }
        await tx`delete from public.organizations where id in ${tx(fixtures.map((f) => f.orgId))}`;
      });
    }
    for (const id of users) {
      const check = await admin.auth.admin.getUserById(id);
      assert.equal(check.error, null);
      assert.equal(check.data.user?.is_anonymous, true);
      assert.equal((await admin.auth.admin.deleteUser(id)).error, null);
    }
    console.log(
      "PASS only generated complete tenant/device/anonymous Auth/capability fixtures removed; user catalog preserved and no email endpoints called.",
    );
  } catch {
    failed = true;
    console.error(
      "Complete fixture cleanup failed. Inspect only generated Senmiva smoke complete tenants.",
    );
  }
  await Promise.all([sql.end({ timeout: 3 }), writer.end({ timeout: 3 })]);
  if (failed) process.exitCode = 1;
}
