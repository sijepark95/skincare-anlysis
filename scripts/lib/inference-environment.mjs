/** Only explicitly selected hosted photo mode receives the one necessary API key. */
export function inferenceEnvironment(environment) {
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    if (
      (/^(OPENAI_|EXPLANATION_|SMTP_|SUPABASE_|NEXT_PUBLIC_|AUTH_EMAIL_)/.test(
        name,
      ) &&
        !(
          environment.ANALYSIS_PROVIDER === "openai" &&
          name === "OPENAI_API_KEY"
        )) ||
      ["ANALYSIS_DATABASE_URL", "ANALYSIS_DATABASE_CA_FILE"].includes(name)
    )
      delete result[name];
  }
  if (environment.ANALYSIS_PROVIDER === "openai") {
    for (const name of [
      "SENMIVA_ML_WORKSPACE",
      "ANALYSIS_DEVICE",
      "ANALYSIS_PHOTO_MANIFEST",
      "ANALYSIS_PHOTO_RUN",
      "ANALYSIS_INGREDIENT_MANIFEST",
      "ANALYSIS_INGREDIENT_RUN",
    ])
      delete result[name];
  }
  return result;
}
