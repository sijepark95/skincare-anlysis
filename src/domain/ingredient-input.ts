export const ingredientInputMaxLength = 16_384;

export interface IngredientInput {
  format: "list" | "report";
  ingredients: string[];
  warnings: string[];
  requiresReview: boolean;
}

const reportHeading = /^all ingredients\s*:?$/i;
const purposeHeading = /^purpose of formulation\s*:/i;
const sourceGrade = /^\d{1,2}(?:\s*-\s*\d{1,2})?$/;
const sourceOrderNotice = /^it is displayed in order of high content\.?$/i;
const knownBenefits = new Set([
  "moisturizing",
  "skin barrier protection",
  "brightening",
  "lock in hydration",
]);

function unwrap(text: string): string {
  const trimmed = text.trim();
  const pairs: Record<string, string> = { '"': '"', "'": "'", "“": "”" };
  return trimmed.length > 1 && pairs[trimmed[0]] === trimmed.at(-1)
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

function isBenefitLine(line: string): boolean {
  return line
    .split(/[,;]/)
    .every((part) => knownBenefits.has(part.trim().toLowerCase()));
}

function parseReport(lines: string[]): IngredientInput {
  const ingredients: string[] = [];
  const warnings: string[] = [];
  const headingIndex = lines.findIndex((line) => reportHeading.test(line));
  const countLine = lines[headingIndex + 1];
  const declaredCount = /^\d+$/.test(countLine ?? "")
    ? Number(countLine)
    : undefined;
  let block: string[] = [];
  let blockNumber = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (purposeHeading.test(line)) {
      blockNumber += 1;
      if (block.length === 1) ingredients.push(block[0]);
      else
        warnings.push(
          `Report block ${blockNumber} has ${block.length === 0 ? "no clear ingredient name" : "more than one possible ingredient name"}. Compare the original ingredient list and enter the correct name manually.`,
        );
      block = [];
      continue;
    }
    if (
      reportHeading.test(line) ||
      (declaredCount !== undefined && index === headingIndex + 1) ||
      sourceOrderNotice.test(line) ||
      sourceGrade.test(line) ||
      isBenefitLine(line)
    )
      continue;
    block.push(line);
  }

  if (block.length)
    warnings.push(
      "The report has text without a following formulation-purpose line. Review the original list and enter any missing ingredient names manually.",
    );
  if (declaredCount === undefined)
    warnings.push(
      "The report does not provide a readable ingredient count. Check that the reviewed list is complete.",
    );
  else if (declaredCount !== ingredients.length)
    warnings.push(
      `The report lists ${declaredCount} ingredients, but ${ingredients.length} ${ingredients.length === 1 ? "name" : "names"} could be extracted. Review the original list for missing or ambiguous entries.`,
    );

  return { format: "report", ingredients, warnings, requiresReview: true };
}

function parseList(text: string): IngredientInput {
  const ingredients: string[] = [];
  const groups: string[] = [];
  let ingredient = "";
  let unbalanced = false;
  const flush = () => {
    if (ingredient.trim()) ingredients.push(ingredient.trim());
    ingredient = "";
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(" || character === "[") groups.push(character);
    else if (character === ")" || character === "]") {
      const expected = character === ")" ? "(" : "[";
      if (groups.at(-1) === expected) groups.pop();
      else unbalanced = true;
    }

    const digitComma =
      character === "," &&
      /\d/.test(text[index - 1] ?? "") &&
      /\d/.test(text[index + 1] ?? "");
    if (
      groups.length === 0 &&
      ((character === "," && !digitComma) ||
        character === ";" ||
        character === "\n" ||
        character === "\r")
    )
      flush();
    else ingredient += character;
  }
  flush();
  if (groups.length) unbalanced = true;

  return {
    format: "list",
    ingredients,
    warnings: unbalanced
      ? [
          "The ingredient list has unmatched parentheses or brackets. Review the ingredient boundaries before saving.",
        ]
      : [],
    requiresReview: unbalanced,
  };
}

/** Parse names only. Reports always need human review; benefits are never evidence. */
export function parseIngredientInput(raw: string): IngredientInput {
  if (raw.length > ingredientInputMaxLength)
    return {
      format:
        /(?:^|\r|\n)\s*(?:["“']?all ingredients\s*:?\s*(?:\r|\n)|purpose of formulation\s*:)/i.test(
          raw.slice(0, ingredientInputMaxLength),
        )
          ? "report"
          : "list",
      ingredients: [],
      warnings: [
        `Ingredient input exceeds ${ingredientInputMaxLength.toLocaleString("en-US")} characters. Enter the complete ingredient names without report descriptions. No text was truncated or imported.`,
      ],
      requiresReview: true,
    };
  const text = unwrap(raw);
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hasReportHeading = lines.some((line) => reportHeading.test(line));
  const hasPurposeHeading = lines.some((line) => purposeHeading.test(line));
  const format = hasReportHeading || hasPurposeHeading ? "report" : "list";

  if (format === "report") {
    if (!hasReportHeading || !hasPurposeHeading)
      return {
        format,
        ingredients: [],
        warnings: [
          "This report is incomplete or has an unsupported format. Enter only the complete ingredient names, separated by commas or new lines.",
        ],
        requiresReview: true,
      };
    return parseReport(lines);
  }
  return parseList(text);
}
