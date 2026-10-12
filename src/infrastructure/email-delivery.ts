export type EmailDeliveryStatus =
  { mode: "local"; inboxUrl: string } | { mode: "smtp" } | { mode: "unknown" };

type Environment = Readonly<Record<string, string | undefined>>;

function loopbackOrigin(value: string | undefined): string | null {
  if (
    !value ||
    /\s/.test(value) ||
    !/^[a-z][a-z\d+.-]*:\/\/[^/?#\\]+\/?$/i.test(value)
  )
    return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Public delivery metadata only; never infer SMTP from the browser's location. */
export function authEmailDelivery(
  mode: "demo" | "supabase",
  env: Environment = process.env,
): EmailDeliveryStatus {
  if (mode !== "supabase") return { mode: "unknown" };
  if (env.AUTH_EMAIL_DELIVERY === "smtp") return { mode: "smtp" };
  if (env.AUTH_EMAIL_DELIVERY !== "local") return { mode: "unknown" };
  const inboxUrl = loopbackOrigin(env.AUTH_EMAIL_INBOX_URL);
  if (
    !inboxUrl ||
    !loopbackOrigin(env.NEXT_PUBLIC_SUPABASE_URL) ||
    !loopbackOrigin(env.NEXT_PUBLIC_APP_URL)
  )
    return { mode: "unknown" };
  return { mode: "local", inboxUrl };
}
