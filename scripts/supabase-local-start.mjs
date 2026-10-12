/** Start only this repository's minimal Supabase stack and enforce loopback ports.
 * Docker inspection, environment variables and configuration archives stay in memory.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  parseDatabaseUrl,
  postgresOptions,
} from "./lib/supabase-setup-config.mjs";

const excluded =
  "realtime,storage-api,imgproxy,postgres-meta,studio,edge-runtime,logflare,vector,supavisor";
const loopback = new Set(["127.0.0.1", "::1"]);

/** Refuse foreign containers, unexpected persistent volumes and extra ports. */
export function assertOwnedContainer(container, project, root, kind, port) {
  const name = `supabase_${kind}_${project}`;
  const labels = container.Config?.Labels ?? {};
  if (
    !["db", "kong", "inbucket"].includes(kind) ||
    container.Name !== `/${name}` ||
    labels["com.supabase.cli.project"] !== project ||
    labels["com.docker.compose.project"] !== project ||
    path.resolve(labels["com.supabase.cli.workdir"] || "") !==
      path.resolve(root)
  )
    throw new Error(
      "Local binding repair refused a container outside this project and workspace.",
    );
  const expectedPort =
    kind === "db" ? "5432/tcp" : kind === "kong" ? "8000/tcp" : "8025/tcp";
  const bindings = container.HostConfig?.PortBindings ?? {};
  if (
    Object.keys(bindings).length !== 1 ||
    !Array.isArray(bindings[expectedPort]) ||
    !bindings[expectedPort].length ||
    bindings[expectedPort].some((entry) => entry.HostPort !== String(port))
  )
    throw new Error("Local binding repair refused unexpected published ports.");
  if (
    container.HostConfig?.Privileged ||
    container.HostConfig?.AutoRemove ||
    Object.keys(container.NetworkSettings?.Networks ?? {}).length !== 1
  )
    throw new Error(
      "Local binding repair refused an unexpected runtime configuration.",
    );
  if (
    kind === "db" &&
    !(container.Mounts ?? []).some(
      (mount) =>
        mount.Type === "volume" &&
        mount.Name === `supabase_db_${project}` &&
        mount.Destination === "/var/lib/postgresql/data" &&
        mount.RW,
    )
  )
    throw new Error(
      "Local binding repair requires this project's existing named database volume.",
    );
  if (kind === "inbucket" && (container.Mounts ?? []).length)
    throw new Error(
      "Local mail binding repair refused unfamiliar persistent data mounts.",
    );
  for (const mount of container.Mounts ?? []) {
    if (
      mount.Type === "volume" &&
      !(
        mount.Name?.startsWith("supabase_") &&
        mount.Name.endsWith(`_${project}`)
      )
    )
      throw new Error(
        "Local binding repair refused an unrelated persistent volume.",
      );
  }
  return { name, expectedPort };
}

export function rewriteLoopbackPorts(bindings) {
  return Object.fromEntries(
    Object.entries(bindings).map(([port, values]) => [
      port,
      [...new Set(values.map((entry) => entry.HostPort))].map((HostPort) => ({
        HostIp: "127.0.0.1",
        HostPort,
      })),
    ]),
  );
}

export function hasLoopbackPorts(container) {
  const bindings = Object.values(
    container.NetworkSettings?.Ports ?? {},
  ).flatMap((value) => value ?? []);
  return (
    bindings.length > 0 &&
    bindings.every((binding) => loopback.has(binding.HostIp))
  );
}

/** Retain image ID, complete runtime config, all mounts and network aliases/IP. */
export function replacementConfig(container) {
  const HostConfig = structuredClone(container.HostConfig);
  HostConfig.PortBindings = rewriteLoopbackPorts(HostConfig.PortBindings);
  // Anonymous volumes must be reattached by their existing names, never replaced.
  const mounted = new Set(
    (HostConfig.Mounts ?? []).map((mount) => mount.Target),
  );
  const bound = new Set(
    (HostConfig.Binds ?? []).map((bind) => {
      const parts = bind.split(":");
      return parts.at(-1).startsWith("/") ? parts.at(-1) : parts.at(-2);
    }),
  );
  for (const mount of container.Mounts ?? []) {
    if (mounted.has(mount.Destination) || bound.has(mount.Destination))
      continue;
    HostConfig.Mounts ||= [];
    if (mount.Type === "volume")
      HostConfig.Mounts.push({
        Type: "volume",
        Source: mount.Name,
        Target: mount.Destination,
        ReadOnly: !mount.RW,
      });
    else if (mount.Type === "bind")
      HostConfig.Mounts.push({
        Type: "bind",
        Source: mount.Source,
        Target: mount.Destination,
        ReadOnly: !mount.RW,
        BindOptions: { Propagation: mount.Propagation || "rprivate" },
      });
    else if (mount.Type !== "tmpfs")
      throw new Error("Local binding repair refused an unsupported mount.");
  }
  const Config = structuredClone(container.Config);
  Config.Image = container.Image;
  for (const [name, value] of Object.entries(Config.Labels ?? {})) {
    if (
      name.startsWith("desktop.docker.io/ports/") &&
      typeof value === "string"
    )
      Config.Labels[name] = value.replace(/^(?:0\.0\.0\.0)?:/, "127.0.0.1:");
  }
  const EndpointsConfig = Object.fromEntries(
    Object.entries(container.NetworkSettings.Networks).map(
      ([name, endpoint]) => [
        name,
        {
          Aliases: endpoint.Aliases,
          Links: endpoint.Links,
          DriverOpts: endpoint.DriverOpts,
          IPAMConfig: {
            ...endpoint.IPAMConfig,
            ...(endpoint.IPAddress ? { IPv4Address: endpoint.IPAddress } : {}),
            ...(endpoint.GlobalIPv6Address
              ? { IPv6Address: endpoint.GlobalIPv6Address }
              : {}),
          },
        },
      ],
    ),
  );
  return { ...Config, HostConfig, NetworkingConfig: { EndpointsConfig } };
}

async function captured(command, args, root, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 1048576) child.kill();
    });
    child.stderr.resume();
    child.on("error", () =>
      reject(new Error("Local Docker/Supabase command could not start.")),
    );
    child.on("exit", (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              "Local Docker/Supabase command failed. Check Docker Desktop and local ports.",
            ),
          ),
    );
  });
}

export function engineSocket(endpoint) {
  if (endpoint.startsWith("npipe:////./pipe/"))
    return "\\\\.\\pipe\\" + endpoint.slice("npipe:////./pipe/".length);
  if (endpoint.startsWith("unix:///")) return endpoint.slice("unix://".length);
  throw new Error(
    "Local binding repair requires a local Docker named pipe or Unix socket; remote engines are refused.",
  );
}

export function dockerEngine(socketPath) {
  return async (method, route, body, binary = false) =>
    new Promise((resolve, reject) => {
      const payload =
        body === undefined
          ? undefined
          : Buffer.isBuffer(body)
            ? body
            : Buffer.from(JSON.stringify(body));
      const request = http.request(
        {
          socketPath,
          path: route,
          method,
          timeout: 45000,
          headers: payload
            ? {
                "Content-Type": Buffer.isBuffer(body)
                  ? "application/x-tar"
                  : "application/json",
                "Content-Length": payload.length,
              }
            : {},
        },
        (response) => {
          const chunks = [];
          let length = 0;
          response.on("data", (chunk) => {
            length += chunk.length;
            if (length > 16777216) response.destroy();
            else chunks.push(chunk);
          });
          response.on("error", () =>
            reject(
              new Error("Local Docker response could not be read safely."),
            ),
          );
          response.on("end", () => {
            if ((response.statusCode ?? 500) >= 300)
              return reject(
                new Error(
                  `Local Docker operation failed (${response.statusCode}). Configuration details were not printed.`,
                ),
              );
            const data = Buffer.concat(chunks);
            if (binary) return resolve(data);
            try {
              resolve(data.length ? JSON.parse(data.toString()) : undefined);
            } catch {
              reject(
                new Error("Local Docker returned an unexpected response."),
              );
            }
          });
        },
      );
      request.on("timeout", () => request.destroy());
      request.on("error", () =>
        reject(new Error("Local Docker engine is unavailable.")),
      );
      if (payload) request.write(payload);
      request.end();
    });
}

export function runtimeArchivePaths(kind) {
  if (kind === "inbucket") return [];
  if (kind === "kong")
    return [
      "/home/kong/kong.yml",
      "/home/kong/custom_nginx.template",
      "/home/kong/localhost.crt",
      "/home/kong/localhost.key",
    ];
  if (kind === "db")
    return [
      "/etc/postgresql",
      "/etc/postgresql-custom",
      "/etc/postgresql.schema.sql",
    ];
  throw new Error("Local runtime archive refused an unknown service.");
}

async function archiveRuntime(engine, container, kind) {
  if (kind === "inbucket") {
    // Mailpit uses an in-memory mailbox. Refuse replacement if it holds mail;
    // never discard somebody's existing confirmation messages during repair.
    const port = container.HostConfig.PortBindings["8025/tcp"][0].HostPort;
    let mailbox;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/messages`, {
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error("not ready");
      mailbox = await response.json();
    } catch {
      throw new Error("Local mail capture could not be checked safely.");
    }
    if (mailbox.total !== 0 || mailbox.messages?.length !== 0)
      throw new Error(
        "Local mail binding repair found an existing mailbox. Its messages and original container were preserved.",
      );
    return [];
  }
  // Copy CLI-written files individually. Custom email templates are retained
  // bind mounts: archiving the whole directory would overwrite read-only mounts.
  const paths = runtimeArchivePaths(kind);
  const changes = await engine("GET", `/containers/${container.Id}/changes`);
  const allowed =
    kind === "kong"
      ? ["/home", "/home/kong", "/usr", "/usr/local", "/usr/local/kong"]
      : ["/etc", ...paths, "/run", "/run/postgresql"];
  if (
    changes.some(
      (change) =>
        !allowed.some(
          (prefix) =>
            change.Path === prefix ||
            (prefix !== "/etc" &&
              prefix !== "/usr" &&
              prefix !== "/usr/local" &&
              prefix !== "/home" &&
              change.Path.startsWith(prefix + "/")),
        ),
    )
  )
    throw new Error(
      "Local binding repair found unfamiliar writable configuration. Original containers were preserved.",
    );
  const archives = [];
  for (const file of paths)
    archives.push({
      destination: path.posix.dirname(file),
      tar: await engine(
        "GET",
        `/containers/${container.Id}/archive?path=${encodeURIComponent(file)}`,
        undefined,
        true,
      ),
    });
  return archives;
}

async function ready(engine, id, verify) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = await engine("GET", `/containers/${id}/json`);
    if (!state.State.Running)
      throw new Error(
        "Local replacement container stopped during startup. Original configuration will be restored.",
      );
    if (state.State.Health?.Status !== "unhealthy" && (await verify())) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    "Local replacement did not become ready. Original configuration will be restored.",
  );
}

async function replaceContainer(engine, container, kind, verify) {
  const name = container.Name.slice(1);
  const backup = `${name}_loopback_backup_${randomUUID().slice(0, 8)}`;
  const config = replacementConfig(container);
  const archives = await archiveRuntime(engine, container, kind);
  const networks = Object.keys(container.NetworkSettings.Networks);
  let renamed = false;
  let replacement;
  try {
    if (container.State?.Running)
      await engine("POST", `/containers/${container.Id}/stop?t=20`);
    await engine("POST", `/containers/${container.Id}/rename?name=${backup}`);
    renamed = true;
    for (const network of networks)
      await engine(
        "POST",
        `/networks/${encodeURIComponent(network)}/disconnect`,
        { Container: container.Id, Force: false },
      );
    replacement = await engine(
      "POST",
      `/containers/create?name=${encodeURIComponent(name)}`,
      config,
    );
    for (const archive of archives)
      await engine(
        "PUT",
        `/containers/${replacement.Id}/archive?path=${encodeURIComponent(archive.destination)}`,
        archive.tar,
      );
    await engine("POST", `/containers/${replacement.Id}/start`);
    await ready(engine, replacement.Id, verify);
    const inspected = await engine("GET", `/containers/${replacement.Id}/json`);
    if (!hasLoopbackPorts(inspected))
      throw new Error(
        "Local Docker did not honor explicit loopback ports. Original configuration will be restored.",
      );
    // Never remove volumes. The original stopped container remains available until
    // the replacement has verified ports and passes live DB/Auth readiness checks.
    await engine("DELETE", `/containers/${container.Id}?v=false`);
    console.log(`Verified local-only binding for ${name}.`);
  } catch (error) {
    let recovered = false;
    try {
      if (replacement?.Id)
        await engine(
          "DELETE",
          `/containers/${replacement.Id}?force=true&v=false`,
        );
      if (renamed)
        await engine(
          "POST",
          `/containers/${container.Id}/rename?name=${encodeURIComponent(name)}`,
        );
      for (const network of networks) {
        const current = await engine("GET", `/containers/${container.Id}/json`);
        if (!current.NetworkSettings.Networks[network])
          await engine(
            "POST",
            `/networks/${encodeURIComponent(network)}/connect`,
            {
              Container: container.Id,
              EndpointConfig: config.NetworkingConfig.EndpointsConfig[network],
            },
          );
      }
      recovered = true;
      // Original public bindings remain stopped after rollback, keeping a failed
      // repair from exposing the database. All original data/config stay intact.
    } catch {
      /* Preserve both original metadata and volume for manual recovery. */
    }
    throw new Error(
      recovered
        ? "Local binding repair failed; original container and data were restored in a stopped state. No volumes were deleted."
        : "Local binding repair failed and needs manual recovery. Original database volumes were preserved; no credentials were printed.",
      { cause: error },
    );
  }
}

export async function startLocalSupabase(
  root = process.cwd(),
  inherited = process.env,
) {
  const configuration = await readFile(
    path.join(root, "supabase", "config.toml"),
    "utf8",
  );
  const project = configuration.match(
    /^project_id\s*=\s*"([a-zA-Z0-9_-]+)"/m,
  )?.[1];
  const apiPort = configuration.match(/\[api\][\s\S]*?\nport\s*=\s*(\d+)/)?.[1];
  const dbPort = configuration.match(/\[db\][\s\S]*?\nport\s*=\s*(\d+)/)?.[1];
  const mailPort = configuration.match(
    /\[local_smtp\][\s\S]*?\nport\s*=\s*(\d+)/,
  )?.[1];
  if (!project || !apiPort || !dbPort || !mailPort)
    throw new Error("Local Supabase project/port configuration is invalid.");
  const endpoint =
    inherited.DOCKER_HOST ||
    JSON.parse(
      await captured(
        "docker",
        ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
        root,
        inherited,
      ),
    );
  const engine = dockerEngine(engineSocket(endpoint));
  const networkName = `${project}-local`;
  const allNetworks = await engine(
    "GET",
    `/networks?filters=${encodeURIComponent(JSON.stringify({ name: [networkName] }))}`,
  );
  let network = allNetworks.find((item) => item.Name === networkName);
  if (
    network &&
    (network.Driver !== "bridge" ||
      network.Options?.["com.docker.network.bridge.host_binding_ipv4"] !==
        "127.0.0.1")
  )
    throw new Error(
      "Local Supabase network exists with different settings. No unrelated network was changed.",
    );
  if (!network)
    network = await engine("POST", "/networks/create", {
      Name: networkName,
      Driver: "bridge",
      EnableIPv6: false,
      Options: { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" },
      Labels: { "com.senmiva.project": project, "com.senmiva.workdir": root },
    });
  const cli = path.join(
    root,
    "node_modules",
    "supabase",
    "dist",
    "supabase.js",
  );
  console.log(
    "Starting the local database, Auth, API and captured development mail. Credentials stay private.",
  );
  await captured(
    process.execPath,
    [cli, "start", "--network-id", network.Id, "--exclude", excluded],
    root,
    inherited,
  );
  const status = JSON.parse(
    await captured(
      process.execPath,
      [cli, "status", "-o", "json"],
      root,
      inherited,
    ),
  );
  const database = parseDatabaseUrl(status.DB_URL);
  // A preserved Kong container can be stopped after a failed binding repair.
  // CLI status then omits API_URL; use only the already-validated local port.
  const api = new URL(status.API_URL || `http://127.0.0.1:${apiPort}`);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(api.hostname)
  )
    throw new Error(
      "Local Supabase status unexpectedly points outside this computer.",
    );
  const verifyDatabase = async () => {
    const sql = postgres(database.toString(), {
      ...postgresOptions(database),
      connect_timeout: 2,
    });
    try {
      await sql`select 1`;
      return true;
    } catch {
      return false;
    } finally {
      await sql.end({ timeout: 1 });
    }
  };
  const verifyAuth = async () => {
    try {
      return (
        await fetch(`${api.origin}/auth/v1/health`, {
          headers: { apikey: status.PUBLISHABLE_KEY || status.ANON_KEY },
          signal: AbortSignal.timeout(1500),
        })
      ).ok;
    } catch {
      return false;
    }
  };
  const verifyMail = async () => {
    try {
      return (
        await fetch(`http://127.0.0.1:${mailPort}/readyz`, {
          redirect: "error",
          signal: AbortSignal.timeout(1500),
        })
      ).ok;
    } catch {
      return false;
    }
  };
  for (const [kind, port, verify] of [
    ["db", dbPort, verifyDatabase],
    ["kong", apiPort, verifyAuth],
    ["inbucket", mailPort, verifyMail],
  ]) {
    const container = await engine(
      "GET",
      `/containers/supabase_${kind}_${project}/json`,
    );
    assertOwnedContainer(container, project, root, kind, port);
    if (!hasLoopbackPorts(container))
      await replaceContainer(engine, container, kind, verify);
  }
  if (
    !(await verifyDatabase()) ||
    !(await verifyAuth()) ||
    !(await verifyMail())
  )
    throw new Error(
      "Local Supabase database/Auth/mail readiness check failed.",
    );
  // Apply an explicitly enabled private SMTP profile after the CLI starts Auth.
  // The email module reads credentials only for the owned Auth container.
  const { ensureConfiguredEmail } = await import("./supabase-email.mjs");
  const email = await ensureConfiguredEmail(root, inherited, {
    engine,
    project,
    verifyAuth,
  });
  console.log(
    email.mode === "smtp"
      ? "Local Supabase is ready. Verification emails use the configured SMTP provider; database and API ports remain local."
      : "Local Supabase is ready. Verification emails stay in the local development inbox; database, API and inbox ports remain local.",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  startLocalSupabase().catch((error) => {
    console.error(
      error instanceof Error && /^(Local |Starting )/.test(error.message)
        ? error.message
        : "Local Supabase startup failed. Original data was preserved; inspect Docker Desktop and local service configuration.",
    );
    process.exitCode = 1;
  });
}
