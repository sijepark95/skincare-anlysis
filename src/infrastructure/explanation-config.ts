import { AppError } from "@/application/contracts";
import { optionalEnv } from "./config";
import { OpenAiExplanationProvider } from "./openai-explanation";

/** No public key, arbitrary endpoint or silent model substitution. */
export function explanationConfiguration() {
  const provider = optionalEnv("EXPLANATION_PROVIDER") ?? "disabled";
  if (provider !== "disabled" && provider !== "openai")
    throw new AppError(
      503,
      "configuration_required",
      "Configure a supported explanation provider.",
    );
  const model =
    optionalEnv("OPENAI_EXPLANATION_MODEL") ?? "gpt-4.1-mini-2025-04-14";
  if (!["gpt-4.1-mini-2025-04-14", "gpt-4.1-mini"].includes(model))
    throw new AppError(
      503,
      "configuration_required",
      "Configure a supported explanation model.",
    );
  const apiKey = optionalEnv("OPENAI_API_KEY")?.trim();
  const keyReady = !!apiKey && /^sk-[A-Za-z0-9_-]{16,500}$/.test(apiKey);
  return {
    provider,
    model,
    available: provider === "openai" && keyReady,
  } as const;
}

export function configuredExplanationProvider() {
  try {
    const config = explanationConfiguration();
    if (!config.available) return null;
    return new OpenAiExplanationProvider({
      apiKey: optionalEnv("OPENAI_API_KEY")!.trim(),
      model: config.model,
    });
  } catch {
    // Invalid optional configuration disables only this feature, never core discovery.
    return null;
  }
}

export function explanationAvailable(): boolean {
  try {
    return explanationConfiguration().available;
  } catch {
    return false;
  }
}
