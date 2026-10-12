import path from "node:path";

export const localEmailFile = ".env.supabase-mail.local";

export const localEmailTemplate = `# Private local Supabase SMTP settings. Never commit or paste this file into chat.
# This changes only this repository's local Auth container, not a hosted project.
# Keep disabled until all settings are complete.
SMTP_ENABLED=false
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
# Your full Gmail or Google Workspace account email.
SMTP_USER=
# Use a 16-character Google App Password, never your normal Google password.
# Spaces shown between the four-character groups are removed automatically.
SMTP_PASS=REPLACE_WITH_GOOGLE_APP_PASSWORD
# Leave empty to send from SMTP_USER. Sender aliases are not supported here.
SMTP_FROM=
SMTP_SENDER_NAME=Senmiva
# Optional for Gmail. Resend's test sender requires your Resend account email.
SMTP_TEST_RECIPIENT=
`;

const keys = new Set([
  "SMTP_ENABLED",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "SMTP_SENDER_NAME",
  "SMTP_TEST_RECIPIENT",
]);
const emailPattern =
  /^[^\s@<>\x00-\x1f\x7f]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const controls = /[\x00-\x1f\x7f]/;

/** Validate locally, without a network request or secret-bearing error text. */
export function validateEmailConfig(values) {
  if (Object.keys(values).some((key) => !keys.has(key)))
    throw new Error("Local email settings contain an unsupported field.");
  if (!["true", "false"].includes(values.SMTP_ENABLED))
    throw new Error("Local email SMTP_ENABLED must be true or false.");
  if (values.SMTP_ENABLED !== "true") return { enabled: false };
  const host = values.SMTP_HOST?.trim().toLowerCase();
  if (
    !host ||
    host.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    throw new Error("Local email SMTP_HOST must be an external SMTP hostname.");
  if (!["465", "587"].includes(values.SMTP_PORT))
    throw new Error(
      "Local email SMTP_PORT must be 465 (TLS) or 587 (STARTTLS).",
    );
  const username = values.SMTP_USER;
  let password = values.SMTP_PASS;
  const gmail = host === "smtp.gmail.com";
  if (gmail && (!username || !emailPattern.test(username)))
    throw new Error(
      "Local email Gmail SMTP_USER must be your full Gmail or Google Workspace account email.",
    );
  if (
    !username ||
    username.length > 320 ||
    username !== username.trim() ||
    controls.test(username) ||
    !password ||
    password.length < 12 ||
    password.length > 1024 ||
    controls.test(password) ||
    /^(?:replace|placeholder|changeme|your[_ -]|<)/i.test(password)
  )
    throw new Error(
      gmail
        ? "Local email Gmail needs a 16-character Google App Password, never your normal Google password."
        : "Local email needs a completed SMTP username and password/API key.",
    );
  if (gmail) {
    password = password.replace(/ /g, "");
    if (!/^[a-z0-9]{16}$/i.test(password))
      throw new Error(
        "Local email Gmail needs a 16-character Google App Password, never your normal Google password.",
      );
  }
  const from = values.SMTP_FROM?.trim() || (gmail ? username : "");
  const senderName = values.SMTP_SENDER_NAME?.trim();
  const testRecipient = values.SMTP_TEST_RECIPIENT?.trim() || "";
  if (!from || from.length > 320 || !emailPattern.test(from))
    throw new Error("Local email SMTP_FROM must be a valid sender email.");
  if (gmail && from.toLowerCase() !== username.toLowerCase())
    throw new Error(
      "Local email Gmail SMTP_FROM must match SMTP_USER; sender aliases are not supported.",
    );
  if (!senderName || senderName.length > 100 || controls.test(senderName))
    throw new Error(
      "Local email SMTP_SENDER_NAME needs a short, single-line name.",
    );
  if (
    testRecipient &&
    (testRecipient.length > 320 || !emailPattern.test(testRecipient))
  )
    throw new Error("Local email SMTP_TEST_RECIPIENT must be a valid email.");
  const resendTestSender =
    host === "smtp.resend.com" &&
    from.toLowerCase() === "onboarding@resend.dev";
  if (resendTestSender && !testRecipient)
    throw new Error(
      "Local email Resend test delivery needs SMTP_TEST_RECIPIENT set to your Resend account email.",
    );
  return {
    enabled: true,
    host,
    port: values.SMTP_PORT,
    username,
    password,
    from,
    senderName,
    testRecipient,
    resendTestSender,
  };
}

/** This administrative operation can only replace our private, stateless Auth. */
export function assertOwnedAuth(container, project, root) {
  const labels = container.Config?.Labels ?? {};
  if (
    !/^[a-zA-Z0-9_-]{1,64}$/.test(project) ||
    container.Name !== `/supabase_auth_${project}` ||
    !/^[a-f0-9]{12,64}$/.test(container.Id || "") ||
    labels["com.supabase.cli.project"] !== project ||
    labels["com.docker.compose.project"] !== project ||
    !labels["com.supabase.cli.workdir"] ||
    path.resolve(labels["com.supabase.cli.workdir"]) !== path.resolve(root)
  )
    throw new Error(
      "Local email refused an Auth container outside this project and workspace.",
    );
  const networks = Object.keys(container.NetworkSettings?.Networks ?? {});
  const networkId =
    container.NetworkSettings?.Networks?.[networks[0]]?.NetworkID;
  const sameNetwork =
    container.HostConfig?.NetworkMode === networks[0] ||
    (/^[a-f0-9]{64}$/.test(networkId || "") &&
      container.HostConfig?.NetworkMode === networkId);
  if (
    networks.length !== 1 ||
    networks[0] !== `${project}-local` ||
    !sameNetwork ||
    container.HostConfig?.PublishAllPorts ||
    Object.keys(container.HostConfig?.PortBindings ?? {}).length ||
    Object.values(container.NetworkSettings?.Ports ?? {}).some(
      (bindings) => Array.isArray(bindings) && bindings.length,
    ) ||
    container.HostConfig?.Privileged ||
    container.HostConfig?.AutoRemove
  )
    throw new Error(
      "Local email refused unexpected Auth network, ports or runtime settings.",
    );
  if (!container.Config?.Healthcheck?.Test?.length)
    throw new Error("Local email requires the existing Auth health check.");
  for (const mount of container.Mounts ?? []) {
    if (mount.Type === "tmpfs") continue;
    if (
      mount.Type === "volume" &&
      mount.Name?.startsWith("supabase_") &&
      mount.Name.endsWith(`_${project}`)
    )
      continue;
    if (mount.Type === "bind") {
      const relative = path.relative(
        path.resolve(root),
        path.resolve(mount.Source || ""),
      );
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative))
        continue;
    }
    throw new Error(
      "Local email refused an unfamiliar Auth mount; no data was changed.",
    );
  }
  return `supabase_auth_${project}`;
}

export function smtpEnvironment(config) {
  if (!config.enabled)
    throw new Error(
      "Local email is disabled; existing delivery was preserved.",
    );
  return {
    GOTRUE_SMTP_HOST: config.host,
    GOTRUE_SMTP_PORT: config.port,
    GOTRUE_SMTP_USER: config.username,
    GOTRUE_SMTP_PASS: config.password,
    GOTRUE_SMTP_ADMIN_EMAIL: config.from,
    GOTRUE_SMTP_SENDER_NAME: config.senderName,
    GOTRUE_SMTP_LOGGING_ENABLED: "false",
    GOTRUE_SMTP_MAX_FREQUENCY: "60s",
    GOTRUE_RATE_LIMIT_EMAIL_SENT: "30",
  };
}

export function authEnvironment(container) {
  return Object.fromEntries(
    (container.Config?.Env ?? []).map((entry) => {
      const split = entry.indexOf("=");
      return [entry.slice(0, split), entry.slice(split + 1)];
    }),
  );
}

/** Clone all runtime settings; reattach anonymous volumes by their existing names. */
export function smtpReplacementConfig(container, config) {
  const Config = structuredClone(container.Config);
  const overrides = smtpEnvironment(config);
  Config.Env = (Config.Env ?? []).filter(
    (entry) => !Object.hasOwn(overrides, entry.slice(0, entry.indexOf("="))),
  );
  Config.Env.push(
    ...Object.entries(overrides).map(([key, value]) => `${key}=${value}`),
  );
  Config.Image = container.Image;
  const HostConfig = structuredClone(container.HostConfig);
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
    if (
      mounted.has(mount.Destination) ||
      bound.has(mount.Destination) ||
      mount.Type === "tmpfs"
    )
      continue;
    HostConfig.Mounts ||= [];
    HostConfig.Mounts.push(
      mount.Type === "volume"
        ? {
            Type: "volume",
            Source: mount.Name,
            Target: mount.Destination,
            ReadOnly: !mount.RW,
          }
        : {
            Type: "bind",
            Source: mount.Source,
            Target: mount.Destination,
            ReadOnly: !mount.RW,
            BindOptions: { Propagation: mount.Propagation || "rprivate" },
          },
    );
  }
  const EndpointsConfig = Object.fromEntries(
    Object.entries(container.NetworkSettings.Networks).map(
      ([network, endpoint]) => [
        network,
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

export function emailDeliveryMetadata(container, project, mailPort) {
  if (
    authEnvironment(container).GOTRUE_SMTP_HOST ===
    `supabase_inbucket_${project}`
  )
    return { mode: "local", inboxUrl: `http://127.0.0.1:${mailPort}` };
  return { mode: "smtp" };
}
