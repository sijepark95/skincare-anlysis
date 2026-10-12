import Papa from "papaparse";
import { validateCatalogDraft } from "./catalog";
import { canonicalizeIngredients } from "./ingredients";
import {
  type CatalogDraft,
  type CsvIssue,
  type CsvPreview,
  type ProductCategory,
  type SkinType,
} from "./types";

export const CSV_LIMITS = { maxBytes: 1_048_576, maxRows: 500 } as const;
export const CSV_REQUIRED_COLUMNS = [
  "sku",
  "brand",
  "name",
  "category",
  "price",
  "stock",
  "ingredients",
] as const;
export const CSV_OPTIONAL_COLUMNS = ["skin_types"] as const;

/** Quoted commas, escaped quotes and embedded newlines are parsed as CSV, never split manually. */
export function parseCatalogCsv(text: string): CsvPreview {
  const fail = (message: string, row = 1, column = "file"): CsvPreview => ({
    valid: false,
    rows: [],
    errors: [{ row, column, message }],
  });
  if (new TextEncoder().encode(text).byteLength > CSV_LIMITS.maxBytes)
    return fail("CSV must be no larger than 1 MiB.");
  if (!text.trim())
    return fail("Choose a CSV with a header and at least one product.");
  const source = text.replace(/^\uFEFF/, "");
  const parsed = Papa.parse<string[]>(source, {
    delimiter: ",",
    skipEmptyLines: "greedy",
    dynamicTyping: false,
  });
  if (parsed.errors.length) {
    return {
      valid: false,
      rows: [],
      errors: parsed.errors.map((error) => ({
        row: (error.row ?? 0) + 1,
        column: "file",
        message: `Invalid CSV: ${error.message}`,
      })),
    };
  }
  const [rawHeaders, ...records] = parsed.data;
  if (!rawHeaders) return fail("The header is missing.");
  const headers = rawHeaders.map((header) => header.trim().toLowerCase());
  if (new Set(headers).size !== headers.length)
    return fail("CSV contains duplicate column names.");
  const missing = CSV_REQUIRED_COLUMNS.filter(
    (column) => !headers.includes(column),
  );
  if (missing.length)
    return fail(`Missing required columns: ${missing.join(", ")}.`);
  const known = new Set<string>([
    ...CSV_REQUIRED_COLUMNS,
    ...CSV_OPTIONAL_COLUMNS,
  ]);
  const unexpected = headers.filter((header) => !known.has(header));
  if (unexpected.length)
    return fail(
      `Unsupported columns: ${unexpected.join(", ")}. Store and tenant are selected securely outside the CSV.`,
    );
  if (records.length === 0)
    return fail("CSV must contain at least one product.");
  if (records.length > CSV_LIMITS.maxRows)
    return fail(
      `CSV supports at most ${CSV_LIMITS.maxRows} products per import.`,
    );

  const errors: CsvIssue[] = [];
  const rows: CatalogDraft[] = [];
  const seenSkus = new Map<string, number>();
  for (const [index, cells] of records.entries()) {
    const row = index + 2;
    const initialErrorCount = errors.length;
    if (cells.length !== headers.length) {
      errors.push({
        row,
        column: "file",
        message: `Expected ${headers.length} columns but found ${cells.length}. Quote values containing commas.`,
      });
      continue;
    }
    const values = Object.fromEntries(
      headers.map((header, cellIndex) => [
        header,
        (cells[cellIndex] ?? "").trim(),
      ]),
    );
    for (const [column, value] of Object.entries(values)) {
      if (
        value.length > 4_000 ||
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)
      )
        errors.push({
          row,
          column,
          message:
            "Cell contains unsupported control characters or exceeds 4,000 characters.",
        });
      // Reject spreadsheet formulas before data is displayed, persisted or later exported.
      if (/^[=+@-]/.test(value) || /[<>]/.test(value))
        errors.push({
          row,
          column,
          message: "Use plain values; formulas and markup are not accepted.",
        });
    }
    const sku = values.sku ?? "";
    const skuKey = sku.toUpperCase();
    const priorRow = seenSkus.get(skuKey);
    if (priorRow !== undefined)
      errors.push({
        row,
        column: "sku",
        message: `Duplicate SKU; first appears on row ${priorRow}.`,
      });
    else seenSkus.set(skuKey, row);
    const priceText = values.price ?? "";
    const stockText = values.stock ?? "";
    const validPrice = /^\d+(?:\.\d{1,2})?$/.test(priceText);
    const validStock = /^\d+$/.test(stockText);
    if (!validPrice)
      errors.push({
        row,
        column: "price",
        message:
          "Use a non-negative USD amount with at most two decimal places, for example 24.50.",
      });
    if (!validStock)
      errors.push({
        row,
        column: "stock",
        message: "Stock must be a non-negative whole number.",
      });
    const rawIngredients = (values.ingredients ?? "")
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean);
    const ingredientResult = canonicalizeIngredients(rawIngredients);
    if (ingredientResult.unknown.length)
      errors.push({
        row,
        column: "ingredients",
        message: `Unknown INCI name(s): ${ingredientResult.unknown.join(", ")}.`,
      });
    const draft: CatalogDraft = {
      sku,
      brand: values.brand ?? "",
      name: values.name ?? "",
      category: (values.category ?? "").toLowerCase() as ProductCategory,
      priceMinor: validPrice ? Math.round(Number(priceText) * 100) : -1,
      currency: "USD",
      stock: validStock ? Number(stockText) : -1,
      visible: true,
      ingredients: ingredientResult.canonical,
      formulaComplete:
        rawIngredients.length > 0 && ingredientResult.unknown.length === 0,
      suitableSkinTypes: (values.skin_types ?? "")
        .split(";")
        .map((type) => type.trim().toLowerCase())
        .filter(Boolean) as SkinType[],
    };
    const validation = validateCatalogDraft(draft);
    for (const error of validation.errors) {
      if (
        !errors.some(
          (existing) =>
            existing.row === row && existing.column === error.column,
        )
      )
        errors.push({ row, ...error });
    }
    if (errors.length === initialErrorCount) rows.push(draft);
  }
  return {
    valid: errors.length === 0,
    rows: errors.length === 0 ? rows : [],
    errors,
  };
}
