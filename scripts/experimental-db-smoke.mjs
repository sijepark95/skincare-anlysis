/** No-email local acceptance: real paired-device BFF -> trained service -> restricted DB writer.
 * Only generated fixture tenants and anonymous Auth identities are created. No customer photos.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { loadSetupEnv, postgresOptions } from "./lib/supabase-setup-config.mjs";
import {
  liveSmokeConfig,
  SmokeCookieJar,
  cleanupSmokeFixtures,
} from "./supabase-smoke.mjs";

const env = loadSetupEnv();
const config = liveSmokeConfig(env); // Refuses remote API, admin and writer connections.
const origin = "http://127.0.0.1:3000";
const checkExplanationFallback = process.argv.includes(
  "--explanation-fallback",
);
// Explicit operator-only opt-in: one small real request containing synthetic facts.
const checkExplanationApi = process.argv.includes("--explanation-api");
const checkExplanation = checkExplanationFallback || checkExplanationApi;
if (
  process.argv
    .slice(2)
    .some(
      (arg) => !["--explanation-fallback", "--explanation-api"].includes(arg),
    ) ||
  (checkExplanationFallback && checkExplanationApi)
)
  throw new Error(
    "Choose at most one of --explanation-fallback or --explanation-api.",
  );
const sql = postgres(config.adminUrl, postgresOptions(config.adminUrl, env));
const authOptions = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
};
const admin = createClient(config.apiUrl, config.serviceKey, authOptions);
const anonymous = createClient(
  config.apiUrl,
  config.publishableKey,
  authOptions,
);
const fixtureTag = randomUUID();
const fixtures = ["A", "B"].map((suffix) => ({
  orgId: randomUUID(),
  storeId: randomUUID(),
  name: `Senmiva smoke experimental ${fixtureTag} ${suffix}`,
}));
const users = new Set();
const jar = new SmokeCookieJar();
const outputTables = [
  "analysis_visual_probabilities",
  "analysis_visual_heads",
  "analysis_ingredient_candidates",
  "analysis_input_coverage",
  "analysis_model_outputs",
  ...(checkExplanation
    ? [
        "recommendation_product_explanations",
        "recommendation_explanation_runs",
        "session_explanation_consents",
      ]
    : []),
];
const questionnaire = {
  skinType: "dry",
  concerns: ["dehydration"],
  excludedIngredients: ["Parfum"],
  sensitive: false,
};
const usedPhotoFeature = "visual_condition_used_source_contract_v1";
let stage = "readiness";
let provisioned = false;
let failed = false;
let responseFailure = "";

function syntheticPng() {
  const crc = (buffer) => {
    let value = 0xffffffff;
    for (const byte of buffer) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++)
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, bytes) => {
    const type = Buffer.from(name);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(Buffer.concat([type, bytes])));
    return Buffer.concat([length, type, bytes, checksum]);
  };
  const size = 256;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const index = y * (size * 3 + 1) + 1 + x * 3;
      pixels[index] = 160 + (x % 50);
      pixels[index + 1] = 130 + (y % 50);
      pixels[index + 2] = 120;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function request(
  route,
  method = "GET",
  body,
  type = "application/json",
  expected = 200,
) {
  const response = await fetch(`${origin}/api/v1/${route}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(90000),
    headers: { Origin: origin, Cookie: jar.header(), "Content-Type": type },
    body:
      body === undefined
        ? undefined
        : type === "application/json"
          ? JSON.stringify(body)
          : body,
  });
  jar.update(response.headers.getSetCookie());
  const data = await response.json();
  const safeCode = /^[a-z_]{1,60}$/.test(data?.error?.code ?? "")
    ? data.error.code
    : "unexpected_response";
  if (response.status !== expected)
    responseFailure = ` HTTP ${response.status} (${safeCode}).`;
  assert.equal(
    response.status,
    expected,
    `HTTP ${response.status} (${safeCode})`,
  );
  return data;
}

try {
  const health = await request("healthz");
  assert.equal(health.mode, "supabase");
  assert.equal(health.analysis, "experimental");
  if (checkExplanation) {
    const context = await request("context");
    assert.equal(
      context.explanationAvailable,
      checkExplanationApi,
      "Selected explanation smoke requires matching provider availability.",
    );
  }
  const inferenceHealth = await fetch("http://127.0.0.1:8000/healthz").then(
    (value) => value.json(),
  );
  assert.equal(inferenceHealth.mode, "experimental");
  await sql.begin(async (tx) => {
    await tx.unsafe("set local session_replication_role = replica");
  });

  stage = "anonymous fixture creation";
  const { data: creator, error } = await anonymous.auth.signInAnonymously();
  assert.equal(error, null);
  assert.equal(creator.user?.is_anonymous, true);
  users.add(creator.user.id);
  const pairingCode = randomBytes(8).toString("hex").toUpperCase();
  const codeHash = createHash("sha256").update(pairingCode).digest();
  const ids = {
    brand: randomUUID(),
    category: randomUUID(),
    product: randomUUID(),
    formulation: randomUUID(),
    policy: randomUUID(),
    good: randomUUID(),
    zero: randomUUID(),
    excluded: randomUUID(),
  };
  await sql.begin(async (tx) => {
    for (const fixture of fixtures) {
      await tx`insert into public.organizations(id,name) values(${fixture.orgId},${fixture.name})`;
      await tx`insert into public.stores(id,org_id,name) values(${fixture.storeId},${fixture.orgId},'Experimental fixture')`;
    }
    const a = fixtures[0];
    await tx`insert into public.device_pairing_codes(org_id,store_id,code_hash,label,created_by,expires_at) values(${a.orgId},${a.storeId},${codeHash},'Synthetic smoke tablet',${creator.user.id},now()+interval '10 minutes')`;
    await tx`insert into public.brands(id,org_id,name) values(${ids.brand},${a.orgId},'Synthetic fixture')`;
    await tx`insert into public.categories(id,org_id,name) values(${ids.category},${a.orgId},'serum')`;
    await tx`insert into public.products(id,org_id,brand_id,category_id,name) values(${ids.product},${a.orgId},${ids.brand},${ids.category},'Synthetic formula; not a retail product')`;
    await tx`insert into public.formulation_versions(id,org_id,product_id,version,complete) values(${ids.formulation},${a.orgId},${ids.product},1,true)`;
    await tx`insert into public.formulation_ingredients(org_id,formulation_version_id,ingredient_id,position) select ${a.orgId},${ids.formulation},id,row_number() over(order by inci_name) from public.ingredients where inci_name<>'Parfum'`;
    await tx`update public.formulation_versions set status='published',published_at=now() where id=${ids.formulation}`;
    for (const [key, stock] of [
      ["good", 2],
      ["zero", 0],
    ]) {
      await tx`insert into public.product_variants(id,org_id,product_id,sku) values(${ids[key]},${a.orgId},${ids.product},${`SMOKE-${key.toUpperCase()}`})`;
      await tx`insert into public.variant_formulations(org_id,variant_id,product_id,formulation_version_id) values(${a.orgId},${ids[key]},${ids.product},${ids.formulation})`;
      await tx`insert into public.store_listings(org_id,store_id,variant_id,price_minor,currency,stock,visible) values(${a.orgId},${a.storeId},${ids[key]},1000,'USD',${stock},true)`;
    }
    const excludedProduct = randomUUID();
    const excludedForm = randomUUID();
    await tx`insert into public.products(id,org_id,brand_id,category_id,name) values(${excludedProduct},${a.orgId},${ids.brand},${ids.category},'Synthetic excluded formula')`;
    await tx`insert into public.formulation_versions(id,org_id,product_id,version,complete) values(${excludedForm},${a.orgId},${excludedProduct},1,true)`;
    await tx`insert into public.formulation_ingredients(org_id,formulation_version_id,ingredient_id,position) select ${a.orgId},${excludedForm},id,row_number() over(order by inci_name) from public.ingredients`;
    await tx`update public.formulation_versions set status='published',published_at=now() where id=${excludedForm}`;
    await tx`insert into public.product_variants(id,org_id,product_id,sku) values(${ids.excluded},${a.orgId},${excludedProduct},'SMOKE-EXCLUDED')`;
    await tx`insert into public.variant_formulations(org_id,variant_id,product_id,formulation_version_id) values(${a.orgId},${ids.excluded},${excludedProduct},${excludedForm})`;
    await tx`insert into public.store_listings(org_id,store_id,variant_id,price_minor,currency,stock,visible) values(${a.orgId},${a.storeId},${ids.excluded},1000,'USD',2,true)`;
    await tx`insert into public.recommendation_policy_versions(id,org_id,version) values(${ids.policy},${a.orgId},1)`;
    await tx`insert into public.concern_ingredient_rules(org_id,policy_version_id,concern_id,ingredient_id,relevance) select ${a.orgId},${ids.policy},c.id,i.id,1 from public.ingredients i cross join public.concerns c where c.slug='dehydration'`;
    await tx`update public.recommendation_policy_versions set status='published',published_at=now() where id=${ids.policy}`;
  });
  provisioned = true;
  stage = "real BFF device pairing";
  const paired = await request("device/pair", "POST", { code: pairingCode });
  assert.equal(paired.organizationId, fixtures[0].orgId);
  const deviceRows =
    await sql`select auth_user_id from public.devices where org_id=${fixtures[0].orgId} and id=${paired.deviceId}`;
  assert.equal(deviceRows.length, 1);
  users.add(deviceRows[0].auth_user_id);
  const started = await request(
    "kiosk/sessions",
    "POST",
    {},
    "application/json",
    201,
  );
  await request(`kiosk/sessions/${started.id}/consent`, "POST", {
    accepted: true,
    ...(checkExplanationApi ? { explanationAccepted: true } : {}),
  });
  if (checkExplanationFallback) {
    // Synthetic fixture opt-in through the paired identity also checks REST schema reload.
    // The disabled provider cannot make an external request; this tests local fallback only.
    stage = "optional explanation consent REST RPC";
    const consent = await fetch(
      `${config.apiUrl}/rest/v1/rpc/record_explanation_consent`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          apikey: config.publishableKey,
          Authorization: `Bearer ${jar.accessToken("senmiva-device")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          p_session_id: started.id,
          p_accepted: true,
          p_notice_version: "2026-10-openai-explanation-v1",
        }),
      },
    );
    assert.equal(consent.status, 204);
  }
  await request(`kiosk/sessions/${started.id}/answers`, "PUT", questionnaire);

  stage = "trained photo inference and normalized persistence";
  const png = syntheticPng();
  const result = await request(
    `kiosk/sessions/${started.id}/analysis`,
    "POST",
    png,
    "image/png",
  );
  png.fill(0);
  assert.equal(result.analysis.mode, "experimental");
  assert.equal(result.analysis.quality_status, "experimental");
  assert.deepEqual(result.analysis.observations, []);
  assert.equal(result.analysis.visual.heads.length, 8);
  assert.equal(result.analysis.ingredients.candidates.length, 54);
  assert.ok(result.analysis.model_version.endsWith(":source-codes-v1"));
  const photoCoverage = result.analysis.ingredients.input_coverage;
  for (const feature of [
    "source_code_contract_aihub71886_v1",
    "source_code_meanings_unverified",
    "combined_pipeline_not_validated",
  ])
    assert.ok(photoCoverage.includes(feature));
  const photoWasUsed = photoCoverage.includes(usedPhotoFeature);
  if (photoWasUsed) {
    assert.ok(
      photoCoverage.includes("visual_condition_exact_training_category"),
    );
    assert.ok(!photoCoverage.includes("initial_skin_condition_omitted"));
    assert.ok(!photoCoverage.includes("visual_codes_not_used_for_ingredients"));
    assert.ok(
      !photoCoverage.includes("visual_condition_unseen_in_training_omitted"),
    );
  } else {
    assert.ok(
      photoCoverage.includes("visual_condition_unseen_in_training_omitted"),
    );
    assert.ok(photoCoverage.includes("initial_skin_condition_omitted"));
    assert.ok(photoCoverage.includes("visual_codes_not_used_for_ingredients"));
    assert.ok(
      !photoCoverage.includes("visual_condition_exact_training_category"),
    );
  }
  assert.deepEqual(
    result.recommendations.map((value) => value.product.id),
    [ids.good],
  );
  assert.equal(result.consentVersion, "2026-10-experimental-v1");
  const reloaded = await request(`kiosk/sessions/${started.id}`);
  assert.deepEqual(reloaded.analysis, result.analysis);
  assert.deepEqual(reloaded.recommendations, result.recommendations);
  const [stored] =
    await sql`select id from public.analyses where org_id=${fixtures[0].orgId} and session_id=${started.id}`;
  assert.ok(stored);
  const [heads] =
    await sql`select count(*)::int as n from public.analysis_visual_heads where org_id=${fixtures[0].orgId} and analysis_id=${stored.id}`;
  const [candidates] =
    await sql`select count(*)::int as n from public.analysis_ingredient_candidates where org_id=${fixtures[0].orgId} and analysis_id=${stored.id}`;
  assert.equal(heads.n, 8);
  assert.equal(candidates.n, 54);
  const storedCoverage =
    await sql`select feature from public.analysis_input_coverage where org_id=${fixtures[0].orgId} and analysis_id=${stored.id} order by feature`;
  assert.deepEqual(
    storedCoverage.map(({ feature }) => feature),
    [...photoCoverage].sort(),
  );
  // A retry uses persisted output instead of rerunning/duplicating the model.
  const retry = await request(
    `kiosk/sessions/${started.id}/analysis`,
    "POST",
    {},
  );
  assert.deepEqual(retry.analysis, result.analysis);
  if (checkExplanation) {
    stage = checkExplanationApi
      ? "one synthetic OpenAI request and normalized persistence"
      : "real explanation claim, fallback writer and reload";
    const explained = await request(
      `kiosk/sessions/${started.id}/explanation`,
      "POST",
      {},
    );
    assert.equal(
      explained.explanation.status,
      checkExplanationApi ? "generated" : "fallback",
    );
    if (checkExplanationApi)
      assert.ok(
        ["gpt-4.1-mini-2025-04-14", "gpt-4.1-mini"].includes(
          explained.explanation.modelVersion,
        ),
      );
    else assert.equal(explained.explanation.modelVersion, null);
    assert.deepEqual(explained.recommendations, result.recommendations);
    assert.deepEqual(
      explained.explanation.products.map((product) => product.productId),
      [ids.good],
    );
    const repeat = await request(
      `kiosk/sessions/${started.id}/explanation`,
      "POST",
      {},
    );
    assert.deepEqual(repeat.explanation, explained.explanation);
    assert.deepEqual(
      (await request(`kiosk/sessions/${started.id}`)).explanation,
      explained.explanation,
    );
    for (const table of [
      "session_explanation_consents",
      "recommendation_explanation_runs",
      "recommendation_product_explanations",
    ]) {
      const [count] = await sql.unsafe(
        `select count(*)::int as n from public.${table} where org_id=$1`,
        [fixtures[0].orgId],
      );
      assert.equal(count.n, 1);
    }
  }
  stage = "finish cascade";
  await request(`kiosk/sessions/${started.id}/finish`, "POST", {});
  for (const table of outputTables) {
    const [count] = await sql.unsafe(
      `select count(*)::int as n from public.${table} where org_id=$1`,
      [fixtures[0].orgId],
    );
    assert.equal(count.n, 0);
  }

  stage = "same-questionnaire photo-free baseline";
  const baselineSession = await request(
    "kiosk/sessions",
    "POST",
    {},
    "application/json",
    201,
  );
  await request(`kiosk/sessions/${baselineSession.id}/consent`, "POST", {
    accepted: true,
  });
  await request(
    `kiosk/sessions/${baselineSession.id}/answers`,
    "PUT",
    questionnaire,
  );
  const baseline = await request(
    `kiosk/sessions/${baselineSession.id}/analysis`,
    "POST",
    {},
  );
  assert.equal(baseline.analysis.mode, "experimental");
  assert.equal(baseline.analysis.visual, null);
  assert.deepEqual(baseline.analysis.observations, []);
  assert.deepEqual(baseline.answers, result.answers);
  assert.ok(
    baseline.analysis.ingredients.input_coverage.includes(
      "no_photo_questionnaire_only",
    ),
  );
  assert.ok(
    baseline.analysis.ingredients.input_coverage.includes(
      "initial_skin_condition_omitted",
    ),
  );
  assert.ok(
    baseline.analysis.ingredients.input_coverage.includes(
      "visual_codes_not_used_for_ingredients",
    ),
  );
  assert.ok(
    !baseline.analysis.ingredients.input_coverage.includes(usedPhotoFeature),
  );
  assert.ok(
    !baseline.analysis.ingredients.input_coverage.includes(
      "visual_condition_exact_training_category",
    ),
  );
  assert.deepEqual(
    baseline.recommendations.map(({ product }) => product.id),
    [ids.good],
  );
  if (photoWasUsed)
    assert.notDeepEqual(
      result.analysis.ingredients.candidates,
      baseline.analysis.ingredients.candidates,
      "A supported photo category must affect actual trained ingredient scores.",
    );
  else
    assert.deepEqual(
      result.analysis.ingredients.candidates,
      baseline.analysis.ingredients.candidates,
      "An unseen photo category must preserve questionnaire-only scores.",
    );
  const baselineReloaded = await request(
    `kiosk/sessions/${baselineSession.id}`,
  );
  assert.deepEqual(baselineReloaded.analysis, baseline.analysis);
  assert.deepEqual(baselineReloaded.recommendations, baseline.recommendations);
  await request(`kiosk/sessions/${baselineSession.id}/finish`, "POST", {});
  for (const table of outputTables) {
    const [count] = await sql.unsafe(
      `select count(*)::int as n from public.${table} where org_id=$1`,
      [fixtures[0].orgId],
    );
    assert.equal(count.n, 0);
  }
  assert.equal(
    (
      await sql`select count(*)::int as n from public.analyses where org_id=${fixtures[0].orgId}`
    )[0].n,
    0,
  );
  console.log(
    `PASS real BFF + anonymous paired device + trained FastAPI: 8 visual heads, 54 candidates, photo feature ${photoWasUsed ? "applied from exact training category with changed scores" : "explicitly omitted as unseen with unchanged scores"}, same-questionnaire photo-free baseline, normalized provenance reload, approved store match, stock/exclusion filters, idempotent retry and finish purge.${checkExplanationFallback ? " Optional explanation REST consent, durable claim, local fallback, exact reload and three-table purge passed without an external API call." : ""}`,
  );
  if (checkExplanationApi)
    console.log(
      "PASS one explicit synthetic OpenAI explanation: generated status, unchanged product rank, persisted notes, cached retry and complete finish purge. No customer photo, identity or source dataset sent to OpenAI.",
    );
} catch {
  failed = true;
  console.error(
    `Experimental local acceptance failed during ${stage}.${responseFailure} No credentials, inputs or model source paths are printed.`,
  );
} finally {
  try {
    const owned =
      await sql`select org_id,auth_user_id from public.devices where org_id in ${sql(fixtures.map((fixture) => fixture.orgId))}`;
    for (const row of owned) users.add(row.auth_user_id);
    if (provisioned) {
      await sql.begin(async (tx) => {
        const rows =
          await tx`select id,name from public.organizations where id in ${tx(fixtures.map((fixture) => fixture.orgId))} for update`;
        for (const row of rows)
          assert.ok(
            fixtures.some(
              (fixture) =>
                fixture.orgId === row.id && fixture.name === row.name,
            ),
          );
        for (const table of outputTables)
          await tx.unsafe(
            `delete from public.${table} where org_id=any($1::uuid[])`,
            [fixtures.map((fixture) => fixture.orgId)],
          );
      });
      await cleanupSmokeFixtures(sql, fixtures);
    }
    for (const userId of users) {
      const { data, error } = await admin.auth.admin.getUserById(userId);
      assert.equal(error, null);
      assert.equal(data.user?.is_anonymous, true);
      const removed = await admin.auth.admin.deleteUser(userId);
      assert.equal(removed.error, null);
    }
    console.log(
      "PASS generated tenant/catalog/device and anonymous Auth fixture cleanup; no email endpoints called.",
    );
  } catch {
    failed = true;
    console.error(
      "Experimental fixture cleanup failed. Inspect only generated Senmiva smoke experimental tenants; no customer store was selected.",
    );
  }
  await sql.end({ timeout: 3 });
  if (failed) process.exitCode = 1;
}
