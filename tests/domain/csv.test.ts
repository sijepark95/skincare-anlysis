import { describe, expect, it } from "vitest";
import { CSV_LIMITS, parseCatalogCsv } from "../../src/domain/csv";

const header = "sku,brand,name,category,price,stock,ingredients,skin_types";
const row =
  "TEST-01,SENMIVA LAB,Dewdrop Serum,serum,24.50,12,Water;Glycerin;Panthenol,dry;normal";
const csv = (records: string[] = [row]) => [header, ...records].join("\r\n");

describe("all-or-nothing product CSV preview", () => {
  it("canonicalizes ingredients and converts USD precisely to minor units", () => {
    const result = parseCatalogCsv(csv());
    expect(result.valid).toBe(true);
    expect(result.rows[0]).toMatchObject({
      priceMinor: 2450,
      stock: 12,
      ingredients: ["Aqua", "Glycerin", "Panthenol"],
      suitableSkinTypes: ["dry", "normal"],
      formulaComplete: true,
    });
  });

  it("supports UTF-8 BOM, quoted commas, escaped quotes and multiline names", () => {
    const value =
      "\uFEFF" +
      csv([
        'TEST-01,SENMIVA LAB,"Dewdrop, ""Cloud""\nSerum",serum,24.50,12,Water;Glycerin,dry',
      ]);
    const result = parseCatalogCsv(value);
    expect(result.valid).toBe(true);
    expect(result.rows[0].name).toBe('Dewdrop, "Cloud"\nSerum');
  });

  it("allows the optional skin-type column to be omitted", () => {
    const result = parseCatalogCsv(
      "sku,brand,name,category,price,stock,ingredients\nTEST-01,Lab,Serum,serum,12,0,Water;Glycerin",
    );
    expect(result.valid).toBe(true);
    expect(result.rows[0].suitableSkinTypes).toEqual([]);
  });

  it("reports a row-specific error and imports nothing when one formula is unknown", () => {
    const result = parseCatalogCsv(
      csv([
        row,
        row.replace("TEST-01", "TEST-02").replace("Panthenol", "Magic Extract"),
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.rows).toEqual([]);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ row: 3, column: "ingredients" }),
    );
  });

  it("rejects duplicate SKUs without case ambiguity", () => {
    const result = parseCatalogCsv(
      csv([row, row.replace("TEST-01", "test-01")]),
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        row: 3,
        column: "sku",
        message: expect.stringContaining("Duplicate"),
      }),
    );
    expect(result.rows).toEqual([]);
  });

  it.each(["24.555", "$24.50", "1e3", "-1", "NaN", ""])(
    'rejects unsupported price "%s"',
    (price) => {
      const result = parseCatalogCsv(csv([row.replace("24.50", price)]));
      expect(result.valid).toBe(false);
      expect(result.errors.some((error) => error.column === "price")).toBe(
        true,
      );
    },
  );

  it.each(["1.5", "-1", "lots", "1000001"])(
    'rejects invalid stock "%s"',
    (stock) => {
      const result = parseCatalogCsv(csv([row.replace(",12,", `,${stock},`)]));
      expect(result.valid).toBe(false);
      expect(result.errors.some((error) => error.column === "stock")).toBe(
        true,
      );
    },
  );

  it("rejects spreadsheet formulas and markup", () => {
    for (const name of [
      "=HYPERLINK(1)",
      "+SUM(1)",
      "@SUM(1)",
      "<script>alert(1)</script>",
    ]) {
      expect(
        parseCatalogCsv(csv([row.replace("Dewdrop Serum", name)])).valid,
      ).toBe(false);
    }
  });

  it("rejects missing, duplicate and tenant-routing columns", () => {
    expect(parseCatalogCsv(csv().replace("ingredients,", "other,")).valid).toBe(
      false,
    );
    expect(parseCatalogCsv(csv().replace("skin_types", "sku")).valid).toBe(
      false,
    );
    expect(
      parseCatalogCsv(`${header},organization_id\n${row},another-org`).valid,
    ).toBe(false);
  });

  it("rejects malformed quoting and mismatched row lengths", () => {
    expect(
      parseCatalogCsv(csv([row.replace("Dewdrop Serum", '"Unclosed')])).valid,
    ).toBe(false);
    expect(parseCatalogCsv(csv([row + ",extra"])).errors[0].row).toBe(2);
  });

  it("enforces row and UTF-8 byte limits before import", () => {
    const tooMany = Array.from({ length: CSV_LIMITS.maxRows + 1 }, (_, index) =>
      row.replace("TEST-01", `TEST-${index}`),
    );
    expect(parseCatalogCsv(csv(tooMany)).errors[0].message).toContain("500");
    expect(
      parseCatalogCsv("한".repeat(Math.floor(CSV_LIMITS.maxBytes / 3) + 1))
        .errors[0].message,
    ).toContain("1 MiB");
  });

  it("does not accept an empty file or a header without products", () => {
    expect(parseCatalogCsv("").valid).toBe(false);
    expect(parseCatalogCsv(header).valid).toBe(false);
  });
});
