import { describe, expect, it } from "vitest";
import {
  beautyLocales,
  beautyTextIds,
  bt,
  beautyLabel,
} from "@/ui/beauty-i18n";
import { stylingPreviewIds, stylingDirections } from "@/domain/beauty-styling";
describe("complete beauty presentation catalogs", () => {
  it("has nonempty English, Korean and Spanish copy for every stable ID", () => {
    for (const locale of beautyLocales)
      for (const id of beautyTextIds)
        expect(bt(locale, id).trim().length, `${locale}:${id}`).toBeGreaterThan(
          0,
        );
  });
  it("keeps interpolation names identical across languages", () => {
    for (const id of beautyTextIds) {
      const names = (locale: (typeof beautyLocales)[number]) =>
        [...bt(locale, id).matchAll(/\{(\w+)\}/g)]
          .map((match) => match[1])
          .sort();
      expect(names("ko"), id).toEqual(names("en"));
      expect(names("es"), id).toEqual(names("en"));
    }
    expect(bt("ko", "captureIn", { count: 3 })).toBe("3초 후 촬영해요…");
  });
  it("localizes stable matching IDs and preserves merchant proper names", () => {
    expect(beautyLabel("ko", "warm_soft")).toBe("소프트 웜");
    expect(beautyLabel("es", "visible_pores")).toBe("Poros");
    expect(beautyLabel("ko", "Registered Merchant")).toBe(
      "Registered Merchant",
    );
  });
  it("translates every styling preview ID rather than leaking internal IDs on result cards", () => {
    for (const locale of beautyLocales)
      for (const direction of stylingDirections)
        for (const kind of ["makeup", "hair_style", "hair_color"] as const)
          for (const id of stylingPreviewIds(kind, direction))
            expect(beautyLabel(locale, id), `${locale}:${id}`).not.toBe(id);
  });
});
