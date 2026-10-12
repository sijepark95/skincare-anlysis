/** Explicit local acceptance with ONE generated non-person image, never customer/source photos.
 * No email/signup endpoints. No API request body, response body or credential is printed.
 */
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { loadSetupEnv, postgresOptions } from "./lib/supabase-setup-config.mjs";
import {
  liveSmokeConfig,
  SmokeCookieJar,
  cleanupSmokeFixtures,
} from "./supabase-smoke.mjs";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log(
    "Prepared only: use --send-synthetic to authorize one generated non-person photo request. No evaluation data, credentials, database or network were accessed.",
  );
  process.exit(0);
}
if (args.length !== 1 || args[0] !== "--send-synthetic") {
  console.error(
    "Usage: node scripts/openai-skin-db-smoke.mjs --send-synthetic",
  );
  process.exit(1);
}
const env = loadSetupEnv();
const config = liveSmokeConfig(env); // Refuses remote API/admin/writer targets.
const origin = "http://127.0.0.1:3000";
const sql = postgres(config.adminUrl, postgresOptions(config.adminUrl, env));
const options = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
};
const admin = createClient(config.apiUrl, config.serviceKey, options);
const anonymous = createClient(config.apiUrl, config.publishableKey, options);
const fixtures = ["A", "B"].map((suffix) => ({
  orgId: randomUUID(),
  storeId: randomUUID(),
  name: `Senmiva smoke OpenAI skin ${randomUUID()} ${suffix}`,
}));
const jar = new SmokeCookieJar();
const users = new Set();
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
const questionnaire = {
  skinType: "dry",
  concerns: ["dehydration"],
  excludedIngredients: [],
  sensitive: false,
};
let stage = "readiness";
let responseFailure = "";
let provisioned = false;
let failed = false;

function syntheticPng() {
  const crc = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++)
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, bytes) => {
    const type = Buffer.from(name),
      length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    checksum.writeUInt32BE(crc(Buffer.concat([type, bytes])));
    return Buffer.concat([length, type, bytes, checksum]);
  };
  const size = 256,
    header = Buffer.alloc(13),
    pixels = Buffer.alloc(size * (size * 3 + 1));
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const offset = y * (size * 3 + 1) + 1 + x * 3;
      pixels[offset] = 180 + (x % 20);
      pixels[offset + 1] = 180 + (y % 20);
      pixels[offset + 2] = 180;
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
  const code = /^[a-z_]{1,60}$/.test(data?.error?.code ?? "")
    ? data.error.code
    : "unexpected_response";
  if (response.status !== expected)
    responseFailure = ` HTTP ${response.status} (${code}).`;
  assert.equal(response.status, expected, `HTTP ${response.status} (${code})`);
  return data;
}
async function count(table) {
  assert.ok(
    [
      ...outputTables,
      "analyses",
      "observations",
      "products",
      "recommendation_runs",
    ].includes(table),
  );
  return (
    await sql.unsafe(
      `select count(*)::int as n from public.${table} where org_id=$1`,
      [fixtures[0].orgId],
    )
  )[0].n;
}
async function start(visionAccepted) {
  const session = await request(
    "kiosk/sessions",
    "POST",
    {},
    "application/json",
    201,
  );
  await request(`kiosk/sessions/${session.id}/consent`, "POST", {
    accepted: true,
    visionAccepted,
  });
  await request(`kiosk/sessions/${session.id}/answers`, "PUT", questionnaire);
  return session;
}
async function finished(id) {
  await request(`kiosk/sessions/${id}/finish`, "POST", {});
  await request(
    `kiosk/sessions/${id}`,
    "GET",
    undefined,
    "application/json",
    403,
  );
  for (const table of [
    ...outputTables,
    "analyses",
    "observations",
    "recommendation_runs",
  ])
    assert.equal(await count(table), 0);
}

try {
  const health = await request("healthz");
  assert.equal(health.mode, "supabase");
  assert.equal(health.analysis, "openai");
  const context = await request("context");
  assert.equal(context.analysisMode, "openai");
  assert.equal(context.explanationAvailable, false);
  stage = "anonymous fixture creation";
  const { data, error } = await anonymous.auth.signInAnonymously();
  assert.equal(error, null);
  assert.equal(data.user?.is_anonymous, true);
  users.add(data.user.id);
  const pairingCode = randomBytes(8).toString("hex").toUpperCase();
  const codeHash = createHash("sha256").update(pairingCode).digest();
  const policyId = randomUUID();
  await sql.begin(async (tx) => {
    for (const fixture of fixtures) {
      await tx`insert into public.organizations(id,name) values(${fixture.orgId},${fixture.name})`;
      await tx`insert into public.stores(id,org_id,name) values(${fixture.storeId},${fixture.orgId},'Synthetic empty catalog')`;
    }
    const a = fixtures[0];
    await tx`insert into public.device_pairing_codes(org_id,store_id,code_hash,label,created_by,expires_at) values(${a.orgId},${a.storeId},${codeHash},'Synthetic OpenAI smoke',${data.user.id},now()+interval '10 minutes')`;
    await tx`insert into public.recommendation_policy_versions(id,org_id,version) values(${policyId},${a.orgId},1)`;
    await tx`insert into public.concern_ingredient_rules(org_id,policy_version_id,concern_id,ingredient_id,relevance) select ${a.orgId},${policyId},c.id,i.id,1 from public.concerns c cross join public.ingredients i where c.slug='dehydration' and i.inci_name='Glycerin'`;
    await tx`update public.recommendation_policy_versions set status='published',published_at=now() where id=${policyId}`;
  });
  provisioned = true;
  stage = "paired device and empty catalog";
  const paired = await request("device/pair", "POST", { code: pairingCode });
  assert.equal(paired.organizationId, fixtures[0].orgId);
  const rows =
    await sql`select auth_user_id from public.devices where org_id=${fixtures[0].orgId} and id=${paired.deviceId}`;
  assert.equal(rows.length, 1);
  users.add(rows[0].auth_user_id);
  assert.equal(await count("products"), 0);
  const session = await start(false);
  stage = "separate external consent enforcement";
  const refused = syntheticPng();
  const denied = await request(
    `kiosk/sessions/${session.id}/analysis`,
    "POST",
    refused,
    "image/png",
    409,
  );
  refused.fill(0);
  assert.equal(denied.error.code, "vision_consent_required");
  assert.equal(await count("session_vision_attempts"), 0);
  await request(`kiosk/sessions/${session.id}/consent`, "POST", {
    accepted: true,
    visionAccepted: true,
  });
  stage = "one explicit non-person photo request";
  const png = syntheticPng();
  let result;
  try {
    result = await request(
      `kiosk/sessions/${session.id}/analysis`,
      "POST",
      png,
      "image/png",
    );
  } finally {
    png.fill(0);
  }
  const analysis = result.analysis;
  assert.equal(analysis.mode, "openai");
  assert.equal(analysis.model_version, "gpt-4.1-mini-2025-04-14");
  assert.equal(analysis.quality_status, "not_assessable");
  assert.equal(analysis.vision.prompt_version, "visible-appearance-eval-v1");
  assert.equal(analysis.vision.image_quality, "not_assessable");
  assert.ok(analysis.vision.quality_flags.includes("no_face"));
  assert.deepEqual(
    Object.keys(analysis.vision.observed_features).sort(),
    [
      "visible_redness",
      "visible_spots",
      "visible_pores",
      "visible_fine_lines",
      "visible_flaking",
    ].sort(),
  );
  assert.ok(
    Object.values(analysis.vision.observed_features).every(
      (value) => value === "not_assessable",
    ),
  );
  assert.deepEqual(analysis.observations, []);
  assert.equal(analysis.visual, undefined);
  assert.equal(analysis.ingredients, undefined);
  assert.deepEqual(result.recommendations, []);
  assert.equal(result.consentVersion, "2026-10-openai-v1");
  assert.deepEqual(result.visionConsent, {
    accepted: true,
    noticeVersion: "2026-10-openai-photo-v1",
  });
  assert.equal(await count("analysis_vision_outputs"), 1);
  assert.equal(await count("analysis_vision_features"), 5);
  assert.ok((await count("analysis_vision_quality_flags")) >= 1);
  assert.equal(await count("session_vision_attempts"), 1);
  stage = "exact cached reload with no second external attempt";
  assert.deepEqual(
    (await request(`kiosk/sessions/${session.id}`)).analysis,
    analysis,
  );
  assert.deepEqual(
    (await request(`kiosk/sessions/${session.id}/analysis`, "POST", {}))
      .analysis,
    analysis,
  );
  assert.equal(await count("session_vision_attempts"), 1);
  const explanation = await request(
    `kiosk/sessions/${session.id}/explanation`,
    "POST",
    {},
    "application/json",
    409,
  );
  assert.equal(explanation.error.code, "explanation_disabled");
  stage = "complete finish purge";
  await finished(session.id);
  stage = "photo-free flow without external consent or attempt";
  const photoFreeSession = await start(false);
  const photoFree = await request(
    `kiosk/sessions/${photoFreeSession.id}/analysis`,
    "POST",
    {},
  );
  assert.equal(photoFree.analysis.mode, "openai");
  assert.equal(photoFree.analysis.quality_status, "not_provided");
  assert.equal(photoFree.analysis.vision, null);
  assert.deepEqual(photoFree.recommendations, []);
  assert.equal(await count("session_vision_attempts"), 0);
  assert.equal(await count("analysis_vision_outputs"), 0);
  assert.deepEqual(
    (await request(`kiosk/sessions/${photoFreeSession.id}`)).analysis,
    photoFree.analysis,
  );
  await finished(photoFreeSession.id);
  console.log(
    "PASS one explicitly authorized generated non-person photo: separate consent, OpenAI no-face result, empty-catalog analysis, five normalized features, durable one-attempt claim, exact cached reload, finish purge and photo-free zero-attempt flow.",
  );
} catch {
  failed = true;
  console.error(
    `OpenAI skin acceptance failed during ${stage}.${responseFailure} No credentials, images or provider bodies are printed.`,
  );
} finally {
  try {
    const rows =
      await sql`select org_id,auth_user_id from public.devices where org_id in ${sql(fixtures.map((fixture) => fixture.orgId))}`;
    for (const row of rows) users.add(row.auth_user_id);
    if (provisioned) {
      await sql.begin(async (tx) => {
        const owned =
          await tx`select id,name from public.organizations where id in ${tx(fixtures.map((fixture) => fixture.orgId))} for update`;
        for (const row of owned)
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
    for (const id of users) {
      const check = await admin.auth.admin.getUserById(id);
      assert.equal(check.error, null);
      assert.equal(check.data.user?.is_anonymous, true);
      assert.equal((await admin.auth.admin.deleteUser(id)).error, null);
    }
    console.log(
      "PASS generated tenant/device/anonymous Auth cleanup; no email endpoints called.",
    );
  } catch {
    failed = true;
    console.error(
      "OpenAI skin fixture cleanup failed. Inspect only generated Senmiva smoke OpenAI skin tenants.",
    );
  }
  await sql.end({ timeout: 3 });
  if (failed) process.exitCode = 1;
}
