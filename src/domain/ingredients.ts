/**
 * A deliberately bounded, manually reviewed demo vocabulary.
 * Matching an INCI name is not proof of efficacy, concentration or safety.
 */
const ingredientDefinitions: ReadonlyArray<{
  inci: string;
  aliases?: string[];
}> = [
  { inci: "Aqua", aliases: ["Water", "Water (Aqua)", "Aqua (Water)", "Eau"] },
  { inci: "Glycerin", aliases: ["Glycerol"] },
  { inci: "Niacinamide", aliases: ["Vitamin B3"] },
  { inci: "Sodium Hyaluronate", aliases: ["Hyaluronic Acid Sodium Salt"] },
  { inci: "Hyaluronic Acid" },
  { inci: "Panthenol", aliases: ["Provitamin B5"] },
  { inci: "Ceramide NP", aliases: ["Ceramide 3"] },
  { inci: "Ceramide AP" },
  { inci: "Ceramide EOP" },
  { inci: "Squalane" },
  { inci: "Allantoin" },
  { inci: "Betaine" },
  { inci: "Lactic Acid" },
  { inci: "Gluconolactone" },
  { inci: "Salicylic Acid" },
  { inci: "Ascorbyl Glucoside" },
  { inci: "Ascorbic Acid", aliases: ["L-Ascorbic Acid"] },
  { inci: "Tocopherol", aliases: ["Vitamin E"] },
  { inci: "Palmitoyl Tripeptide-1" },
  { inci: "Zinc Oxide" },
  { inci: "Titanium Dioxide", aliases: ["CI 77891"] },
  { inci: "Caprylic/Capric Triglyceride" },
  { inci: "Cetearyl Alcohol" },
  { inci: "Cetyl Alcohol" },
  { inci: "Decyl Glucoside" },
  { inci: "Cocamidopropyl Betaine" },
  { inci: "Sodium Cocoyl Glycinate" },
  { inci: "Butylene Glycol" },
  { inci: "Propanediol" },
  { inci: "Dimethicone" },
  { inci: "Carbomer" },
  { inci: "Xanthan Gum" },
  { inci: "Phenoxyethanol" },
  { inci: "Ethylhexylglycerin" },
  { inci: "Sodium Chloride" },
  { inci: "Sodium Citrate" },
  { inci: "Citric Acid" },
  { inci: "Disodium EDTA" },
  { inci: "Parfum", aliases: ["Fragrance", "Perfume"] },
  { inci: "Alcohol Denat.", aliases: ["Alcohol Denat", "Denatured Alcohol"] },
  // Lip-formula identities only; no efficacy rules. Provenance: docs/PERSONAL-COLOR.md.
  { inci: "Polyglyceryl-2 Triisostearate" },
  { inci: "Helianthus Annuus (Sunflower) Seed Oil" },
  { inci: "Hydrogenated Castor Oil Dimer Dilinoleate" },
  { inci: "Phytosteryl/Octyldodecyl Lauroyl Glutamate" },
  { inci: "Jojoba Esters" },
  { inci: "Polyglyceryl-2 Isostearate/Dimer Dilinoleate Copolymer" },
  {
    inci: "Candelilla Cera",
    aliases: ["Candelilla Cera (Euphorbia Cerifera (Candelilla) Wax)"],
  },
  { inci: "Behenyl Behenate" },
  { inci: "Helianthus Annuus (Sunflower) Seed Wax" },
  { inci: "Butyrospermum Parkii (Shea) Butter" },
  { inci: "Oryza Sativa (Rice) Bran Wax" },
  { inci: "Butyrospermum Parkii (Shea) Butter Unsaponifiables" },
  { inci: "Diisostearyl Malate" },
  { inci: "Prunus Avium (Sweet Cherry) Seed Oil" },
  { inci: "Menthol" },
  { inci: "Ethyl Vanillin" },
  { inci: "Mentha Piperita (Peppermint) Oil" },
  { inci: "Trimethylolpropane Triisostearate" },
  { inci: "Vanillin" },
  { inci: "Ascorbyl Palmitate" },
  { inci: "Undaria Pinnatifida Extract" },
  { inci: "Anethole" },
  { inci: "Aluminum Hydroxide" },
  { inci: "Beta-Caryophyllene" },
  { inci: "Pinene" },
  { inci: "Propyl Gallate" },
  { inci: "CI 45380" },
  { inci: "CI 15850" },
  { inci: "CI 73360" },
  { inci: "CI 77491" },
  { inci: "CI 77492" },
  { inci: "CI 77499" },
  { inci: "CI 45410" },
  { inci: "CI 42090" },
  { inci: "CI 15985" },
  { inci: "CI 19140" },
  { inci: "CI 45370" },
];

export function normalizeIngredientKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

const vocabulary = new Map<string, string>();
for (const definition of ingredientDefinitions) {
  vocabulary.set(normalizeIngredientKey(definition.inci), definition.inci);
  for (const alias of definition.aliases ?? [])
    vocabulary.set(normalizeIngredientKey(alias), definition.inci);
}

export const canonicalIngredientNames = ingredientDefinitions.map(
  ({ inci }) => inci,
);

export function canonicalizeIngredient(value: string): string | null {
  return vocabulary.get(normalizeIngredientKey(value)) ?? null;
}

export function canonicalizeIngredients(values: readonly string[]): {
  canonical: string[];
  unknown: string[];
} {
  const canonical = new Set<string>();
  const unknown = new Set<string>();
  for (const value of values) {
    const ingredient = canonicalizeIngredient(value);
    if (ingredient) canonical.add(ingredient);
    else unknown.add(value.trim());
  }
  return { canonical: [...canonical], unknown: [...unknown] };
}
