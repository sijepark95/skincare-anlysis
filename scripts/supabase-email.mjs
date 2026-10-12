/** Local Auth SMTP configuration. Secrets stay in memory and an ignored file. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { updateLocalEnv } from "./supabase-local-prepare.mjs";
import {
  assertOwnedAuth,
  authEnvironment,
  emailDeliveryMetadata,
  localEmailFile,
  localEmailTemplate,
  smtpEnvironment,
  smtpReplacementConfig,
  validateEmailConfig,
} from "./lib/supabase-email-config.mjs";

export async function prepareLocalEmailConfig(root = process.cwd()) {
  try {
    await writeFile(path.join(root, localEmailFile), localEmailTemplate, {
      flag: "wx",
      mode: 0o600,
    });
    return { created: true };
  } catch (error) {
    if (error.code === "EEXIST") return { created: false };
    throw new Error("Local email could not create its private settings file.");
  }
}

export async function readLocalEmailConfig(root = process.cwd()) {
  const file = path.join(root, localEmailFile);
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return { enabled: false };
    throw new Error("Local email could not read its private settings file.");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384)
    throw new Error(
      "Local email settings must be a small regular file in this workspace.",
    );
  try {
    return validateEmailConfig(parseEnv(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Local email "))
      throw error;
    throw new Error("Local email settings could not be parsed safely.");
  }
}

async function projectSettings(root) {
  let configuration;
  try {
    configuration = await readFile(
      path.join(root, "supabase", "config.toml"),
      "utf8",
    );
  } catch {
    throw new Error(
      "Local email needs this workspace's Supabase configuration.",
    );
  }
  const project = configuration.match(
    /^project_id\s*=\s*"([a-zA-Z0-9_-]{1,64})"/m,
  )?.[1];
  const mailPort = configuration.match(
    /\[local_smtp\][\s\S]*?\nport\s*=\s*(\d+)/,
  )?.[1];
  if (!project || !mailPort || Number(mailPort) < 1 || Number(mailPort) > 65535)
    throw new Error("Local email project or captured-inbox port is invalid.");
  return { project, mailPort };
}

async function localEngine(root, inherited) {
  const { dockerEngine, engineSocket } =
    await import("./supabase-local-start.mjs");
  let endpoint = inherited.DOCKER_HOST;
  if (!endpoint) {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(
        "docker",
        ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
        {
          cwd: root,
          env: inherited,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      let captured = "";
      child.stdout.on("data", (chunk) => {
        captured += chunk;
        if (captured.length > 65536) child.kill();
      });
      child.on("error", () =>
        reject(new Error("Local email could not contact Docker Desktop.")),
      );
      child.on("exit", (code) =>
        code === 0
          ? resolve(captured)
          : reject(
              new Error(
                "Local email could not inspect the local Docker context.",
              ),
            ),
      );
    });
    try {
      endpoint = JSON.parse(output);
    } catch {
      throw new Error("Local email received an invalid Docker endpoint.");
    }
  }
  if (typeof endpoint !== "string")
    throw new Error("Local email requires a local Docker endpoint.");
  return dockerEngine(engineSocket(endpoint));
}

async function syncDeliveryMetadata(root, metadata) {
  const file = path.join(root, ".env.local");
  let original = "";
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1048576)
      throw new Error("unsafe environment file");
    original = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error(
        "Local email could not safely update the runtime delivery notice.",
      );
  }
  const updated = updateLocalEnv(original, {
    AUTH_EMAIL_DELIVERY: metadata.mode,
    AUTH_EMAIL_INBOX_URL: metadata.inboxUrl || "",
  });
  if (updated === original) return;
  const temporary = `${file}.email-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, updated, { flag: "wx", mode: 0o600 });
    const current = await readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (current !== original)
      throw new Error("runtime environment changed concurrently");
    await rename(temporary, file);
  } catch {
    throw new Error(
      "Local email runtime settings changed or could not be written; existing settings were preserved.",
    );
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function assertHealthy(container) {
  if (!container.State?.Running || container.State.Health?.Status !== "healthy")
    throw new Error(
      "Local email requires a running, healthy Auth container. Start local Supabase first.",
    );
}

async function waitHealthy(engine, id, verifyAuth) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const current = await engine("GET", `/containers/${id}/json`);
    if (!current.State?.Running || current.State.Health?.Status === "unhealthy")
      throw new Error("Local email replacement Auth did not start healthily.");
    if (
      current.State.Health?.Status === "healthy" &&
      (!verifyAuth || (await verifyAuth()))
    )
      return current;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Local email replacement Auth readiness timed out.");
}

/** Replace exactly Auth; retain the original until replacement and metadata pass. */
export async function replaceAuthEmail(engine, original, config, context) {
  const { root, project, mailPort, verifyAuth } = context;
  const name = assertOwnedAuth(original, project, root);
  assertHealthy(original);
  const changes = await engine("GET", `/containers/${original.Id}/changes`);
  // Docker represents an unchanged writable layer as either null or [].
  if (changes !== null && (!Array.isArray(changes) || changes.length))
    throw new Error(
      "Local email found writable Auth data; original container and data were preserved.",
    );
  const replacement = smtpReplacementConfig(original, config);
  const network = `${project}-local`;
  const backupName = `${name}_smtp_backup_${randomUUID().slice(0, 8)}`;
  let stopped = false;
  let renamed = false;
  let created;
  let metadata;
  try {
    await engine("POST", `/containers/${original.Id}/stop?t=20`);
    stopped = true;
    await engine(
      "POST",
      `/containers/${original.Id}/rename?name=${backupName}`,
    );
    renamed = true;
    await engine(
      "POST",
      `/networks/${encodeURIComponent(network)}/disconnect`,
      { Container: original.Id, Force: false },
    );
    created = await engine(
      "POST",
      `/containers/create?name=${encodeURIComponent(name)}`,
      replacement,
    );
    if (!/^[a-f0-9]{12,64}$/.test(created?.Id || ""))
      throw new Error(
        "Local email received an invalid replacement container identity.",
      );
    await engine("POST", `/containers/${created.Id}/start`);
    const current = await waitHealthy(engine, created.Id, verifyAuth);
    assertOwnedAuth(current, project, root);
    const actual = authEnvironment(current);
    if (
      Object.entries(smtpEnvironment(config)).some(
        ([key, value]) => actual[key] !== value,
      )
    )
      throw new Error(
        "Local email replacement settings did not match the requested configuration.",
      );
    metadata = emailDeliveryMetadata(current, project, mailPort);
    await syncDeliveryMetadata(root, metadata);
  } catch {
    let recovered = false;
    try {
      if (created?.Id && /^[a-f0-9]{12,64}$/.test(created.Id))
        await engine("DELETE", `/containers/${created.Id}?force=true&v=false`);
      if (renamed)
        await engine(
          "POST",
          `/containers/${original.Id}/rename?name=${encodeURIComponent(name)}`,
        );
      const retained = await engine("GET", `/containers/${original.Id}/json`);
      if (!retained.NetworkSettings.Networks[network])
        await engine(
          "POST",
          `/networks/${encodeURIComponent(network)}/connect`,
          {
            Container: original.Id,
            EndpointConfig:
              replacement.NetworkingConfig.EndpointsConfig[network],
          },
        );
      if (stopped || !retained.State?.Running)
        await engine("POST", `/containers/${original.Id}/start`);
      const restored = await waitHealthy(engine, original.Id, verifyAuth);
      assertOwnedAuth(restored, project, root);
      recovered = true;
    } catch {
      // Neither data volumes nor original container metadata are ever removed.
    }
    throw new Error(
      recovered
        ? "Local email change failed; the original Auth configuration was restored. No database or mailbox data was changed."
        : "Local email change failed and Auth needs recovery. The original container and all data volumes were preserved; no credentials were printed.",
    );
  }
  let backupPreserved = false;
  try {
    await engine("DELETE", `/containers/${original.Id}?v=false`);
  } catch {
    backupPreserved = true;
  }
  return { ...metadata, applied: true, backupPreserved };
}

/** Startup hook; false/missing SMTP_ENABLED preserves the existing delivery mode.
 * @param {string} [root]
 * @param {Record<string, string | undefined>} [inherited]
 * @param {{engine?: Function, project?: string, verifyAuth?: Function}} [options]
 */
export async function ensureConfiguredEmail(
  root = process.cwd(),
  inherited = process.env,
  options = {},
) {
  const settings = await projectSettings(root);
  if (options.project && options.project !== settings.project)
    throw new Error(
      "Local email startup project did not match its workspace configuration.",
    );
  const config = await readLocalEmailConfig(root);
  const engine = options.engine || (await localEngine(root, inherited));
  const container = await engine(
    "GET",
    `/containers/supabase_auth_${settings.project}/json`,
  );
  assertOwnedAuth(container, settings.project, root);
  assertHealthy(container);
  const active = authEnvironment(container);
  if (
    config.enabled &&
    Object.entries(smtpEnvironment(config)).some(
      ([key, value]) => active[key] !== value,
    )
  )
    return replaceAuthEmail(engine, container, config, {
      ...settings,
      root,
      verifyAuth: options.verifyAuth,
    });
  const metadata = emailDeliveryMetadata(
    container,
    settings.project,
    settings.mailPort,
  );
  await syncDeliveryMetadata(root, metadata);
  return { ...metadata, applied: false };
}

/** Safe operational status: no values from SMTP settings or Docker env escape.
 * @param {string} [root]
 * @param {Record<string, string | undefined>} [inherited]
 * @param {{engine?: Function}} [options]
 */
export async function checkLocalEmail(
  root = process.cwd(),
  inherited = process.env,
  options = {},
) {
  const settings = await projectSettings(root);
  const config = await readLocalEmailConfig(root);
  const engine = options.engine || (await localEngine(root, inherited));
  const container = await engine(
    "GET",
    `/containers/supabase_auth_${settings.project}/json`,
  );
  assertOwnedAuth(container, settings.project, root);
  assertHealthy(container);
  const actual = authEnvironment(container);
  return {
    configured: config.enabled,
    active: emailDeliveryMetadata(
      container,
      settings.project,
      settings.mailPort,
    ).mode,
    matchesConfiguration: config.enabled
      ? Object.entries(smtpEnvironment(config)).every(
          ([key, value]) => actual[key] === value,
        )
      : null,
  };
}

async function main() {
  const operation = process.argv[2];
  if (
    process.argv.length !== 3 ||
    !["--prepare", "--apply", "--check"].includes(operation)
  )
    throw new Error(
      "Local email usage: node scripts/supabase-email.mjs --prepare, --apply or --check.",
    );
  if (operation === "--prepare") {
    const result = await prepareLocalEmailConfig();
    console.log(
      result.created
        ? "Created private local SMTP settings. Complete them in your editor, then enable SMTP and apply."
        : "Private local SMTP settings already exist and were preserved.",
    );
    return;
  }
  if (operation === "--check") {
    const result = await checkLocalEmail();
    console.log(
      `Local email: settings ${result.configured ? "enabled" : "disabled"}; active delivery ${result.active}; settings match ${result.matchesConfiguration === null ? "not applicable" : result.matchesConfiguration ? "yes" : "no"}.`,
    );
    return;
  }
  const config = await readLocalEmailConfig();
  if (!config.enabled)
    throw new Error(
      "Local email is disabled. Complete the private SMTP settings and set SMTP_ENABLED=true first.",
    );
  const result = await ensureConfiguredEmail();
  console.log(
    `Local email SMTP is ${result.applied ? "applied and healthy" : "already active and healthy"}. No email was sent by this command. Restart the web preview to refresh its delivery notice.`,
  );
  if (result.backupPreserved)
    console.log(
      "Local email retained the old stopped Auth backup because cleanup was unavailable. Active Auth is healthy; no volumes were deleted.",
    );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      error instanceof Error && error.message.startsWith("Local email ")
        ? error.message
        : "Local email configuration failed. Existing data was preserved; no credentials were printed.",
    );
    process.exitCode = 1;
  });
}
