/** Prepare server-only settings without overwriting existing secrets or contacting OpenAI. */
import { lstat, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateLocalEnv } from "./supabase-local-prepare.mjs";

export async function prepareLlmSettings(root = process.cwd()) {
  const file = path.join(root, ".env.local");
  let original = "";
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
      throw new Error("Settings must be a small regular .env.local file.");
    original = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error("Could not safely read .env.local.");
  }
  const values = parseEnv(original);
  const defaults = {
    EXPLANATION_PROVIDER: "openai",
    OPENAI_API_KEY: "",
    OPENAI_EXPLANATION_MODEL: "gpt-4.1-mini-2025-04-14",
  };
  const missing = Object.fromEntries(
    Object.entries(defaults).filter(([name]) => !(name in values)),
  );
  if (!Object.keys(missing).length) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, updateLocalEnv(original, missing), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 2)
      throw new Error("Usage: npm run llm:prepare");
    await prepareLlmSettings();
    process.stdout.write(
      "Server-only placeholders are ready in ignored .env.local. Enter OPENAI_API_KEY privately, then restart the web server. No API request was sent.\n",
    );
  } catch {
    process.stderr.write(
      "Could not prepare private LLM settings. Check .env.local permissions and file type.\n",
    );
    process.exitCode = 1;
  }
}
