import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Local-only selection; never discover weights or fall back to another provider.
 * @param {string} root
 * @param {Record<string, string | undefined>} env
 */
export function connectedAnalysisConfig(root, env = process.env) {
  const provider = env.ANALYSIS_PROVIDER || "mock";
  if (!["mock", "experimental", "openai"].includes(provider))
    throw new Error(
      "ANALYSIS_PROVIDER must be mock, experimental or openai; fallback is disabled.",
    );
  let workspace;
  if (["experimental", "openai"].includes(provider)) {
    workspace = env.SENMIVA_ML_WORKSPACE?.trim();
    const pointer = path.join(root, ".local", "ml-workspace.json");
    if (!workspace && existsSync(pointer)) {
      try {
        workspace = JSON.parse(readFileSync(pointer, "utf8")).workspace_path;
      } catch {
        throw new Error(
          "The private ML workspace pointer is invalid. Run ML setup or set SENMIVA_ML_WORKSPACE.",
        );
      }
    }
    if (
      (provider === "experimental" || workspace !== undefined) &&
      (typeof workspace !== "string" ||
        !path.isAbsolute(workspace) ||
        !existsSync(workspace))
    )
      throw new Error(
        "The selected mode requires an existing absolute SENMIVA_ML_WORKSPACE or private ML workspace pointer.",
      );
  }
  const python =
    env.SENMIVA_PYTHON ||
    path.join(
      ["experimental", "openai"].includes(provider) && workspace
        ? workspace
        : path.join(root, "services", "analysis"),
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
  if (!existsSync(python))
    throw new Error(
      ["experimental", "openai"].includes(provider) && workspace
        ? "Prepare the private Python environment and install services/analysis/requirements.lock there; see services/analysis/README.md."
        : "Create services/analysis/.venv and install requirements.lock first; see services/analysis/README.md.",
    );
  const inference = { ANALYSIS_PROVIDER: provider };
  const previewFlag = env.ANALYSIS_BEAUTY_PREVIEW_ENABLED;
  if (previewFlag !== undefined) {
    if (!["true", "false"].includes(previewFlag))
      throw new Error("ANALYSIS_BEAUTY_PREVIEW_ENABLED must be true or false.");
    if (previewFlag === "true" && provider !== "openai")
      throw new Error("Beauty previews require explicit openai mode.");
    inference.ANALYSIS_BEAUTY_PREVIEW_ENABLED = previewFlag;
  }
  if (provider === "openai") {
    if (!/^sk-[A-Za-z0-9_-]{16,500}$/.test(env.OPENAI_API_KEY || ""))
      throw new Error(
        "Configure OPENAI_API_KEY privately before selecting openai photo analysis.",
      );
    const timeout = Number(env.ANALYSIS_OPENAI_TIMEOUT_SECONDS || "30");
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 30)
      throw new Error(
        "ANALYSIS_OPENAI_TIMEOUT_SECONDS must be greater than zero and at most 30.",
      );
    inference.ANALYSIS_OPENAI_TIMEOUT_SECONDS = String(timeout);
  }
  if (provider === "experimental") {
    Object.assign(inference, {
      SENMIVA_ML_WORKSPACE: workspace,
      ANALYSIS_PHOTO_MANIFEST: env.ANALYSIS_PHOTO_MANIFEST || "skin-all-001",
      ANALYSIS_PHOTO_RUN: env.ANALYSIS_PHOTO_RUN || "skin-all-head-001",
      ANALYSIS_INGREDIENT_MANIFEST:
        env.ANALYSIS_INGREDIENT_MANIFEST || "ingredients-001",
      ANALYSIS_INGREDIENT_RUN:
        env.ANALYSIS_INGREDIENT_RUN || "ingredients-linear-001",
      ANALYSIS_DEVICE: env.ANALYSIS_DEVICE || "auto",
    });
    for (const name of [
      "ANALYSIS_PHOTO_MANIFEST",
      "ANALYSIS_PHOTO_RUN",
      "ANALYSIS_INGREDIENT_MANIFEST",
      "ANALYSIS_INGREDIENT_RUN",
    ])
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(inference[name]))
        throw new Error(
          "Model manifest and run names must be bounded local identifiers.",
        );
    if (!["auto", "cpu", "cuda"].includes(inference.ANALYSIS_DEVICE))
      throw new Error("ANALYSIS_DEVICE must be auto, cpu or cuda.");
  }
  return {
    provider,
    python,
    inference,
    pythonPath: [
      path.join(root, "services", "analysis", "src"),
      path.join(root, "ml", "src"),
    ].join(path.delimiter),
    endpoint:
      provider === "experimental"
        ? "/v1/analyze/experimental"
        : provider === "openai"
          ? "/v1/analyze/openai"
          : "/v1/analyze",
  };
}
