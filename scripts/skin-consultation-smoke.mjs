/** Local no-email acceptance for professional interpretation and registered-store matches.
 * Synthetic enum observations are injected through the restricted writer AFTER a real
 * paired-device consent/claim. No image, customer record or external AI request is used.
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
    "Prepared only: --local-synthetic runs generated local fixtures. No database, network, photo or external AI request was accessed.",
  );
  process.exit(0);
}
if (process.argv.length !== 3 || process.argv[2] !== "--local-synthetic") {
  console.error(
    "Usage: node scripts/skin-consultation-smoke.mjs --local-synthetic",
  );
  process.exit(1);
}
const env = loadSetupEnv();
const config = liveSmokeConfig(env); // Rejects remote API and both database connections.
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
const jar = new SmokeCookieJar();
const fixtures = ["A", "B"].map((suffix) => ({
  orgId: randomUUID(),
  storeId: randomUUID(),
  name: `Senmiva smoke consultation ${randomUUID()} ${suffix}`,
}));
const ids = {
  brand: randomUUID(),
  category: randomUUID(),
  policy: randomUUID(),
  nextPolicy: randomUUID(),
  otherStore: randomUUID(),
};
const users = new Set();
const variants = new Map();
const outputTables = [
  "analysis_vision_features",
  "analysis_vision_quality_flags",
  "analysis_vision_outputs",
  "session_vision_attempts",
  "session_vision_consents",
  "recommendation_product_explanations",
  "recommendation_explanation_runs",
  "session_explanation_consents",
];
const disclaimer =
  "AI observations describe visible cosmetic features in this photo, not a diagnosis or calibrated measurement. Lighting, makeup and camera quality can affect results. Photos are processed in memory by this app and are not saved or used for training. With your consent, a metadata-stripped photo is sent to OpenAI; provider retention may apply.";
const vision = {
  prompt_version: "visible-appearance-eval-v1",
  image_quality: "usable",
  quality_flags: [],
  observed_features: {
    visible_redness: "visible",
    visible_spots: "visible",
    visible_pores: "visible",
    visible_fine_lines: "not_visible",
    visible_flaking: "visible",
  },
};
let provisioned = false,
  failed = false,
  stage = "readiness",
  responseFailure = "";

async function request(route, method = "GET", body, expected = 200) {
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
    stock = 2,
    visible = true,
    excluded = false,
  } = {},
) {
  const orgId = fixtures[0].orgId,
    productId = randomUUID(),
    formId = randomUUID(),
    variantId = randomUUID();
  variants.set(key, variantId);
  await tx`insert into public.products(id,org_id,brand_id,category_id,name) values(${productId},${orgId},${ids.brand},${ids.category},${`Synthetic ${key}; not a retail product`})`;
  await tx`insert into public.formulation_versions(id,org_id,product_id,version,complete) values(${formId},${orgId},${productId},1,true)`;
  const names = ["Glycerin", "Niacinamide", ...(excluded ? ["Parfum"] : [])];
  await tx`insert into public.formulation_ingredients(org_id,formulation_version_id,ingredient_id,position) select ${orgId},${formId},id,row_number() over(order by inci_name) from public.ingredients where inci_name in ${tx(names)}`;
  if (published)
    await tx`update public.formulation_versions set status='published',published_at=now() where id=${formId}`;
  await tx`insert into public.product_variants(id,org_id,product_id,sku) values(${variantId},${orgId},${productId},${`CONSULT-${key.toUpperCase()}`})`;
  await tx`insert into public.variant_formulations(org_id,variant_id,product_id,formulation_version_id) values(${orgId},${variantId},${productId},${formId})`;
  await tx`insert into public.store_listings(org_id,store_id,variant_id,price_minor,currency,stock,visible) values(${orgId},${storeId},${variantId},2400,'USD',${stock},${visible})`;
}

function assertReport(result) {
  const report = result.skinConsultation;
  assert.ok(
    report,
    "The live BFF must return the derived professional consultation.",
  );
  assert.equal(report.version, "skin-consultation-v1");
  assert.equal(report.status, "photo_based");
  assert.ok(report.summary.length > 30 && report.paragraphs.length >= 2);
  assert.equal(report.observations.length, 5);
  assert.ok(
    report.observations.every(
      (row) =>
        row.interpretation.length > 50 && row.recommendationUse.length > 20,
    ),
  );
  assert.deepEqual(
    report.goals.map(({ concern, source }) => ({ concern, source })),
    [
      { concern: "dehydration", source: "selected" },
      { concern: "texture", source: "photo" },
      { concern: "uneven_tone", source: "photo" },
    ],
  );
  assert.deepEqual(
    new Set(report.ingredients.map(({ ingredient }) => ingredient)),
    new Set(["Glycerin", "Niacinamide"]),
  );
  assert.ok(report.ingredients.every(({ rationale }) => rationale.length > 50));
  assert.deepEqual(
    result.recommendations.map(({ product }) => product.id),
    [variants.get("eligible")],
  );
  assert.deepEqual(
    report.products.map(({ productId }) => productId),
    [variants.get("eligible")],
  );
  assert.ok(
    report.products[0].reasons.some(({ source }) => source === "photo"),
  );
  assert.ok(
    report.products[0].reasons.some(({ source }) => source === "selected"),
  );
  assert.ok(
    report.ingredients.every(
      ({ availableInMatchedProducts, matchedProductIds }) =>
        availableInMatchedProducts &&
        matchedProductIds.length === 1 &&
        matchedProductIds[0] === variants.get("eligible"),
    ),
  );
  assert.equal(report.policyVersion, "1");
  return report;
}

try {
  const health = await request("healthz");
  assert.equal(health.mode, "supabase");
  assert.equal(health.analysis, "openai");
  stage = "anonymous no-email fixture creation";
  const { data, error } = await anonymous.auth.signInAnonymously();
  assert.equal(error, null);
  assert.equal(data.user?.is_anonymous, true);
  users.add(data.user.id);
  const pairingCode = randomBytes(8).toString("hex").toUpperCase(),
    codeHash = createHash("sha256").update(pairingCode).digest();
  await sql.begin(async (tx) => {
    for (const fixture of fixtures) {
      await tx`insert into public.organizations(id,name) values(${fixture.orgId},${fixture.name})`;
      await tx`insert into public.stores(id,org_id,name) values(${fixture.storeId},${fixture.orgId},'Synthetic consultation fixture')`;
    }
    const a = fixtures[0];
    await tx`insert into public.stores(id,org_id,name) values(${ids.otherStore},${a.orgId},'Synthetic other store')`;
    await tx`insert into public.device_pairing_codes(org_id,store_id,code_hash,label,created_by,expires_at) values(${a.orgId},${a.storeId},${codeHash},'Synthetic consultation tablet',${data.user.id},now()+interval '10 minutes')`;
    await tx`insert into public.brands(id,org_id,name) values(${ids.brand},${a.orgId},'Synthetic consultation fixture')`;
    await tx`insert into public.categories(id,org_id,name) values(${ids.category},${a.orgId},'serum')`;
    await register(tx, "eligible");
    await register(tx, "draft", { published: false, visible: false });
    await register(tx, "zero", { stock: 0 });
    await register(tx, "hidden", { visible: false });
    await register(tx, "excluded", { excluded: true });
    await register(tx, "other-store", { storeId: ids.otherStore });
    await tx`insert into public.recommendation_policy_versions(id,org_id,version,source) values(${ids.policy},${a.orgId},1,'operator-configured')`;
    for (const [concern, ingredient, relevance] of [
      ["dehydration", "Glycerin", 3],
      ["texture", "Niacinamide", 2],
      ["uneven_tone", "Niacinamide", 3],
    ])
      await tx`insert into public.concern_ingredient_rules(org_id,policy_version_id,concern_id,ingredient_id,relevance) select ${a.orgId},${ids.policy},c.id,i.id,${relevance} from public.concerns c cross join public.ingredients i where c.slug=${concern} and i.inci_name=${ingredient}`;
    await tx`update public.recommendation_policy_versions set status='published',published_at=now() where id=${ids.policy}`;
  });
  provisioned = true;
  stage = "real paired-device session and explicit consent";
  const paired = await request("device/pair", "POST", { code: pairingCode });
  assert.equal(paired.organizationId, fixtures[0].orgId);
  const [deviceRow] =
    await sql`select auth_user_id from public.devices where org_id=${fixtures[0].orgId} and id=${paired.deviceId}`;
  users.add(deviceRow.auth_user_id);
  const session = await request("kiosk/sessions", "POST", {}, 201);
  await request(`kiosk/sessions/${session.id}/consent`, "POST", {
    accepted: true,
    visionAccepted: true,
  });
  await request(`kiosk/sessions/${session.id}/answers`, "PUT", {
    skinType: "dry",
    concerns: ["dehydration"],
    sensitive: false,
    excludedIngredients: ["Parfum"],
  });
  const accessToken = jar.accessToken("senmiva-device");
  assert.ok(accessToken);
  const guest = createClient(config.apiUrl, config.publishableKey, {
    ...options,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const claim = await guest.rpc("claim_kiosk_vision_analysis", {
    p_session_id: session.id,
  });
  assert.equal(claim.error, null);
  assert.equal(claim.data, true);
  stage = "restricted writer stores strictly synthetic appearance categories";
  await writer`select public.write_openai_analysis(${session.id}::uuid,${session.id}::uuid,'gpt-4.1-mini-2025-04-14','usable',${disclaimer},${writer.json(vision)}::jsonb)`;
  const pinnedPolicy = await guest.rpc("read_kiosk_recommendation_policy", { p_session_id: session.id });
  if (pinnedPolicy.error) {
    responseFailure = ` RPC ${/^[A-Za-z0-9_]{1,20}$/.test(pinnedPolicy.error.code ?? "") ? pinnedPolicy.error.code : "unavailable"}.`;
  }
  assert.equal(pinnedPolicy.error, null);
  assert.equal(pinnedPolicy.data.id, ids.policy);
  stage =
    "cached analysis creates actual registered-store recommendations and professional report";
  const result = await request(
    `kiosk/sessions/${session.id}/analysis`,
    "POST",
    {},
  );
  const report = assertReport(result);
  assert.deepEqual(
    (await request(`kiosk/sessions/${session.id}`)).skinConsultation,
    report,
  );
  assert.deepEqual(
    (await request(`kiosk/sessions/${session.id}/analysis`, "POST", {}))
      .skinConsultation,
    report,
  );
  const [attempts] =
    await sql`select count(*)::int n from public.session_vision_attempts where org_id=${fixtures[0].orgId}`;
  assert.equal(attempts.n, 1);
  stage =
    "report policy remains pinned after a new fixture policy is published";
  await sql.begin(async (tx) => {
    await tx`insert into public.recommendation_policy_versions(id,org_id,version,source) values(${ids.nextPolicy},${fixtures[0].orgId},2,'mock-onboarding-v1')`;
    await tx`insert into public.concern_ingredient_rules(org_id,policy_version_id,concern_id,ingredient_id,relevance) select ${fixtures[0].orgId},${ids.nextPolicy},c.id,i.id,1 from public.concerns c cross join public.ingredients i where c.slug='dehydration' and i.inci_name='Water'`;
    await tx`update public.recommendation_policy_versions set status='published',published_at=now() where id=${ids.nextPolicy}`;
  });
  const current = await guest.rpc("read_recommendation_policy");
  assert.equal(current.error, null);
  assert.equal(current.data.version, 2);
  assert.deepEqual(
    (await request(`kiosk/sessions/${session.id}`)).skinConsultation,
    report,
  );
  stage =
    "current stock removal hides products while ingredient explanation remains";
  await sql`update public.store_listings set stock=0 where org_id=${fixtures[0].orgId} and store_id=${fixtures[0].storeId} and variant_id=${variants.get("eligible")}`;
  const changed = await request(`kiosk/sessions/${session.id}`);
  assert.deepEqual(changed.recommendations, []);
  assert.deepEqual(changed.skinConsultation.products, []);
  assert.deepEqual(
    new Set(
      changed.skinConsultation.ingredients.map(({ ingredient }) => ingredient),
    ),
    new Set(["Glycerin", "Niacinamide"]),
  );
  assert.ok(
    changed.skinConsultation.ingredients.every(
      ({ availableInMatchedProducts, matchedProductIds }) =>
        !availableInMatchedProducts && matchedProductIds.length === 0,
    ),
  );
  stage =
    "finish purges transient observations, recommendations and original policy reference";
  await request(`kiosk/sessions/${session.id}/finish`, "POST", {});
  await request(`kiosk/sessions/${session.id}`, "GET", undefined, 403);
  for (const table of [
    ...outputTables,
    "analyses",
    "observations",
    "recommendation_runs",
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
  console.log(
    "PASS real paired-device BFF + restricted writer + registered synthetic catalog: professional five-feature interpretation, independent INCI shortlist, exact eligible product reasons, draft/stock/visibility/exclusion/other-store filters, original policy after version change, cached reload, current availability and finish purge. No image or external AI request used.",
  );
} catch {
  failed = true;
  console.error(
    `Skin consultation acceptance failed during ${stage}.${responseFailure} No credentials, guest content or provider bodies are printed.`,
  );
} finally {
  try {
    const rows =
      await sql`select auth_user_id from public.devices where org_id in ${sql(fixtures.map(({ orgId }) => orgId))}`;
    for (const row of rows) users.add(row.auth_user_id);
    if (provisioned) {
      await sql.begin(async (tx) => {
        const owned =
          await tx`select id,name from public.organizations where id in ${tx(fixtures.map(({ orgId }) => orgId))} for update`;
        assert.ok(
          owned.every((row) =>
            fixtures.some(
              ({ orgId, name }) => row.id === orgId && row.name === name,
            ),
          ),
        );
        for (const table of outputTables)
          await tx.unsafe(
            `delete from public.${table} where org_id=any($1::uuid[])`,
            [fixtures.map(({ orgId }) => orgId)],
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
      "PASS only generated tenant/device/anonymous Auth fixtures removed; active customer store unchanged; no email endpoints called.",
    );
  } catch {
    failed = true;
    console.error(
      "Consultation fixture cleanup failed. Inspect only generated Senmiva smoke consultation tenants.",
    );
  }
  await Promise.all([sql.end({ timeout: 3 }), writer.end({ timeout: 3 })]);
  if (failed) process.exitCode = 1;
}
