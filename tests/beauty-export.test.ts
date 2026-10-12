import { describe, expect, it } from "vitest";
import { buildBeautyGuide, type BeautyPreferences } from "@/domain/beauty";
import {
  renderBeautyGuideHtml,
  type BeautyGuideExport,
} from "@/ui/beauty-guide-export";

const preferences: BeautyPreferences = {
  paletteId: "cool_soft",
  faceShape: "round",
  hairLength: "medium",
  mood: "fresh",
  finish: "satin",
};
function sample(): BeautyGuideExport {
  return {
    preferences,
    guide: buildBeautyGuide(preferences)!,
    products: [
      {
        name: "Registered Rose",
        brand: "Merchant",
        shadeName: "Soft Rose",
        finish: "satin",
        swatchHex: "#B98788",
        priceMinor: 2400,
        currency: "USD",
        available: true,
      },
    ],
  };
}
describe("offline guest beauty guide", () => {
  it("renders confirmed choices and all styling sections with actual shade references", () => {
    const html = renderBeautyGuideHtml(sample());
    for (const text of [
      "Soft cool",
      "round",
      "Fresh color",
      "medium",
      "satin",
      "Makeup moods",
      "Haircut ideas",
      "Hair color ideas",
      "Jewelry ideas",
      "Registered Rose",
      "Soft Rose",
      "$24.00",
      "#B98788",
      "opens offline",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/(?:src|href)=/);
    expect(html).toContain("default-src 'none'");
  });
  it("escapes merchant strings and rejects CSS/HTML injections in swatches", () => {
    const value = sample();
    value.products[0] = {
      ...value.products[0],
      name: '<img src="https://attacker.test/photo" onerror="steal()">',
      brand: "</style><script>steal()</script>",
      shadeName: "Rose & 'cream'",
      finish: '<a href="https://attacker.test">gloss</a>',
      swatchHex: "#fff;background:url(https://attacker.test)",
    };
    const html = renderBeautyGuideHtml(value);
    expect(html).toContain("&lt;img src=&quot;");
    expect(html).toContain("&lt;/style&gt;&lt;script&gt;");
    expect(html).toContain("Rose &amp; &#39;cream&#39;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("background:url");
    expect(html).toContain('style="background:#B98788"');
  });
  it("omits all incidental private fields rather than serializing the input object", () => {
    const value = {
      ...sample(),
      photo: "private-photo-bytes",
      analysis: {
        request_id: "private-request",
        face_shape: "private-model-output",
      },
      sessionId: "private-session",
      token: "private-bearer",
      consent: "private-permission",
      excludedIngredients: ["private-exclusion"],
      products: [
        {
          ...sample().products[0],
          variantId: "private-variant",
          organizationId: "private-tenant",
          shadeVersionId: "private-version",
        },
      ],
    };
    const html = renderBeautyGuideHtml(value);
    for (const secret of [
      "private-photo-bytes",
      "private-request",
      "private-model-output",
      "private-session",
      "private-bearer",
      "private-permission",
      "private-exclusion",
      "private-variant",
      "private-tenant",
      "private-version",
    ])
      expect(html).not.toContain(secret);
  });
  it("shows honest unavailability and unknown price without manufacturing a price", () => {
    const value = sample();
    Object.assign(value.products[0], {
      available: false,
      priceMinor: null,
      currency: null,
    });
    const html = renderBeautyGuideHtml(value);
    expect(html).toContain("Currently unavailable");
    expect(html).toContain("Ask the store about current price");
    expect(html).not.toContain("$24.00");
    value.products = [];
    expect(renderBeautyGuideHtml(value)).toContain(
      "No eligible registered lip shades matched",
    );
  });
});
