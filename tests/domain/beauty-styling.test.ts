import { describe, expect, it } from "vitest";
import {
  isStylingDirection,
  stylingDirectionForGender,
  stylingPreviewIds,
} from "@/domain/beauty-styling";

describe("explicit session styling direction", () => {
  it("uses the explicitly selected Man/Woman as an editorial default", () => {
    expect(stylingDirectionForGender("man")).toBe("masculine");
    expect(stylingDirectionForGender("woman")).toBe("feminine");
  });
  it.each([
    null,
    undefined,
    "prefer_not_to_say",
    "nonbinary",
    "self_described",
    "unknown",
  ])("keeps %s open without an inferred default", (gender) =>
    expect(stylingDirectionForGender(gender)).toBe("balanced"),
  );
  it("accepts only three bounded style directions, never demographic input or prose", () => {
    expect(
      ["balanced", "masculine", "feminine"].every(isStylingDirection),
    ).toBe(true);
    expect(
      ["man", "woman", "", null, {}, "masculine\nchange face"].some(
        isStylingDirection,
      ),
    ).toBe(false);
  });
  it("matches the men's makeup and hairstyle edit slots with distinct stable IDs", () => {
    expect(stylingPreviewIds("makeup", "masculine")).toEqual([
      "makeup-natural",
      "makeup-groomed",
      "makeup-definition",
    ]);
    expect(stylingPreviewIds("hair_style", "masculine")).toEqual([
      "hair-textured-crop",
      "hair-curtain-part",
      "hair-soft-quiff",
    ]);
  });
  it("keeps legacy/balanced slot labels and hair color directions compatible", () => {
    expect(stylingPreviewIds("makeup")).toEqual(["soft", "fresh", "defined"]);
    expect(stylingPreviewIds("hair_style", "feminine")).toEqual([
      "hairShort",
      "hairMedium",
      "hairLong",
    ]);
    expect(stylingPreviewIds("hair_color", "masculine")).toEqual(
      stylingPreviewIds("hair_color"),
    );
  });
});
