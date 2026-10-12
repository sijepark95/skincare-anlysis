import { describe, expect, it } from "vitest";
import type { CompleteSavedGuide } from "@/application/beauty-complete-contracts";
import { renderCompleteGuideHtml } from "@/ui/complete-beauty-book";
import { localizedBeautyIdeas } from "@/ui/beauty-style-copy";
const saved: CompleteSavedGuide = {
  version: "beauty-complete-guide-v1",
  expiresAt: "2026-10-20T00:00:00Z",
  locale: "en",
  preferences: {
    paletteId: "cool_soft",
    faceShape: "oval",
    hairLength: "any",
    mood: "soft",
    finish: "any",
  },
  products: [
    {
      variantId: "product-id",
      category: "lip_color",
      formulationVersionId: "formula-id",
      shadeVersionId: "shade-id",
      name: 'Merchant <script>alert("oops")</script>',
      brand: "Registered & reviewed",
      shadeName: "Rose",
      swatchHex: "#B77D93",
      priceMinor: 2000,
      currency: "USD",
      available: false,
    },
  ],
};
describe("complete localized guide export", () => {
  it("includes the fixed confirmed makeup3, hairstyle3 and haircolor3 directions", () => {
    const ideas = localizedBeautyIdeas(saved.preferences, "ko")!;
    expect(ideas.makeup).toHaveLength(3);
    expect(ideas.hair).toHaveLength(3);
    expect(ideas.color).toHaveLength(3);
    expect(ideas.hair[0]).toMatchObject({
      id: "oval-short",
      title: "부드러운 크롭",
    });
    expect(renderCompleteGuideHtml(saved, "ko")).toContain(
      "확인한 팔레트를 입술과 볼에 부드럽게",
    );
    expect(renderCompleteGuideHtml(saved, "es")).toContain(
      "Tu guía de belleza completa.",
    );
  });
  it("keeps hair length choices while translating without changing stable idea IDs", () => {
    const preferences = { ...saved.preferences, hairLength: "long" as const };
    const en = localizedBeautyIdeas(preferences, "en")!,
      ko = localizedBeautyIdeas(preferences, "ko")!;
    expect(ko.hair).toHaveLength(1);
    expect(ko.hair[0].id).toBe("oval-long");
    expect(ko.color.map((v) => v.id)).toEqual(en.color.map((v) => v.id));
  });
  it("presents men's session styling in the local download without changing the saved QR guide", () => {
    const ideas = localizedBeautyIdeas(saved.preferences, "en", "masculine")!;
    expect(ideas.makeup.map((item) => item.title)).toEqual([
      "Natural skin finish",
      "Fresh & groomed",
      "Soft definition",
    ]);
    expect(ideas.hair.map((item) => item.title)).toEqual([
      "Textured crop",
      "Curtain part",
      "Soft quiff",
    ]);
    const masculine = renderCompleteGuideHtml(saved, "ko", "masculine");
    expect(masculine).toContain("내추럴 스킨 피니시");
    expect(masculine).toContain("커튼 파트");
    expect(masculine).not.toMatch(
      /gender|stylingDirection|masculine|hair-curtain-part/,
    );
    const general = renderCompleteGuideHtml(saved, "ko");
    expect(general).toContain("부드러운 크롭");
    expect(general).not.toContain("커튼 파트");
    expect(saved.preferences).not.toHaveProperty("stylingDirection");
  });
  it("escapes merchant text, shows unavailable references and makes no resource requests", () => {
    const html = renderCompleteGuideHtml(saved, "en");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Registered &amp; reviewed");
    expect(html).toContain("Currently unavailable");
    expect(html).not.toMatch(/<script|<img|https?:\/\/|src=|fetch\(/);
  });
  it("does not serialize observations, ratios, demographics, portraits or capabilities even if extra data is supplied", () => {
    const html = renderCompleteGuideHtml(
      {
        ...saved,
        analysis: { animalVibe: "private-animal-vibe" },
        sourcePhoto: "data:image/jpeg;base64,private-photo",
        portrait: "blob:private-image",
        gender: "private-gender",
        ageBand: "private-age",
        ratios: { eyeHeightWidth: "private-ratio" },
        token: "private-capability",
        sessionId: "private-session",
      } as CompleteSavedGuide,
      "en",
    );
    for (const secret of [
      "private-animal-vibe",
      "private-photo",
      "blob:private-image",
      "private-gender",
      "private-age",
      "private-ratio",
      "private-capability",
      "private-session",
      "product-id",
      "formula-id",
      "shade-id",
    ])
      expect(html).not.toContain(secret);
  });
});
