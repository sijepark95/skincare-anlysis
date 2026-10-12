import { AppError } from "@/application/contracts";
export function appMode(): "demo" | "supabase" {
  const mode =
    process.env.APP_MODE ??
    (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test"
      ? "demo"
      : undefined);
  if (mode !== "demo" && mode !== "supabase")
    throw new AppError(
      503,
      "configuration_required",
      "Set APP_MODE explicitly before starting the production server.",
    );
  return mode;
}
export function analysisMode(): "mock" | "experimental" | "openai" {
  const mode = optionalEnv("ANALYSIS_PROVIDER") ?? "mock";
  if (mode !== "mock" && mode !== "experimental" && mode !== "openai")
    throw new AppError(
      503,
      "configuration_required",
      "Configure a supported analysis provider.",
    );
  return mode;
}
export function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value)
    throw new AppError(
      503,
      "configuration_required",
      `Server configuration is incomplete (${name}).`,
    );
  return value;
}

/** Keep server settings runtime-readable; Next inlines direct NEXT_PUBLIC_* lookups. */
export function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}
