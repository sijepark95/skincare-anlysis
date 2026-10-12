/** Mailpit access is exclusively for generated local smoke identities. */
const fixtureEmail = /^senmiva-smoke-[0-9a-f-]{36}@example\.test$/i;
const messageId = /^[A-Za-z0-9_-]{1,80}$/;

export function localMailOrigin(configuration) {
  const value = configuration.match(
    /\[local_smtp\][\s\S]*?\nport\s*=\s*(\d+)/,
  )?.[1];
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error("Local captured-mail port is missing or invalid.");
  return `http://127.0.0.1:${port}`;
}

export function smokeMailMatches(message, email) {
  return (
    fixtureEmail.test(email) &&
    messageId.test(message?.ID ?? "") &&
    Array.isArray(message?.To) &&
    message.To.length === 1 &&
    message.To[0]?.Address?.toLowerCase() === email.toLowerCase()
  );
}

export function smokeMailCode(message, email) {
  if (!smokeMailMatches(message, email))
    throw new Error("Local smoke mail did not match its generated recipient.");
  const code = message.HTML?.match(
    /<p\b[^>]*\bdata-senmiva-verification-code(?=\s|>|=)[^>]*>\s*(\d{6})\s*<\/p>/i,
  )?.[1];
  if (!code)
    throw new Error(
      "Local signup mail must contain the configured OTP template.",
    );
  return code;
}

async function mailRequest(origin, route, options) {
  const url = new URL(origin);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Local smoke mail requires an explicit loopback origin.");
  const response = await fetch(`${url.origin}${route}`, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error("Local captured-mail request failed.");
  return response;
}

async function messagesFor(origin, email) {
  if (!fixtureEmail.test(email))
    throw new Error("Local smoke mail refuses non-fixture recipients.");
  const response = await mailRequest(
    origin,
    `/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=50`,
  );
  const data = await response.json();
  if (!Array.isArray(data.messages))
    throw new Error("Local captured-mail returned an unexpected response.");
  return data.messages.filter((message) => smokeMailMatches(message, email));
}

export async function capturedSignupCode(origin, email) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const messages = await messagesFor(origin, email);
    if (messages.length) {
      const response = await mailRequest(
        origin,
        `/api/v1/message/${messages[0].ID}`,
      );
      return smokeMailCode(await response.json(), email);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Local signup confirmation mail did not arrive.");
}

export async function cleanupSmokeMail(origin, emails) {
  const ids = new Set();
  for (const email of emails)
    for (const message of await messagesFor(origin, email)) ids.add(message.ID);
  // Mailpit deletes the entire mailbox when IDs is empty. Never send that request.
  if (!ids.size) return;
  await mailRequest(origin, "/api/v1/messages", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ IDs: [...ids] }),
  });
}
