import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BeautyCompleteAnalysis } from "@/domain/beauty-complete";
import type { FaceRatios } from "@/domain/face-ratios";
import { ReferenceFaceStudy } from "@/ui/reference-face-study";
import { ReferenceColorStudy } from "@/ui/reference-color-study";
import { personalColorPalettes } from "@/domain/personal-color";
import { beautyLocales, bt, beautyLabel } from "@/ui/beauty-i18n";

const analysis: BeautyCompleteAnalysis = {
  request_id: "77777777-7777-4777-8777-777777777777",
  mode: "openai_beauty_complete",
  model_version: "gpt-4.1-mini-2025-04-14",
  prompt_version: "beauty-complete-v1",
  beauty: {
    request_id: "77777777-7777-4777-8777-777777777777",
    mode: "openai_beauty",
    model_version: "gpt-4.1-mini-2025-04-14",
    prompt_version: "beauty-style-suggestion-v2",
    image_quality: "usable",
    undertone: "warm",
    chroma: "soft",
    face_shape: "oval",
    eye_shape: "almond",
    nose_shape: "medium",
    lip_fullness: "full",
    quality_flags: [],
  },
  skin: {
    prompt_version: "visible-appearance-eval-v1",
    image_quality: "limited",
    quality_flags: ["resolution_limited"],
    observed_features: {
      visible_pores: "uncertain",
      visible_spots: "uncertain",
      visible_fine_lines: "uncertain",
      visible_redness: "uncertain",
      visible_flaking: "uncertain",
    },
  },
  animalVibe: "cat",
  baseDepth: "medium",
};
const measured: FaceRatios = {
  status: "measured",
  eyeHeightWidth: 23.4,
  noseFaceWidth: 34.5,
  lipMouthWidth: 18.6,
};

function render(
  ratios: FaceRatios | null,
  locale: (typeof beautyLocales)[number] = "en",
  facts: BeautyCompleteAnalysis | null = analysis,
) {
  return renderToStaticMarkup(
    createElement(ReferenceFaceStudy, {
      analysis: facts,
      ratios,
      locale,
      portrait: "",
      faceShape: "round",
    }),
  );
}

describe("reference-inspired face study", () => {
  it.each(beautyLocales)(
    "shows actual raw geometry and formula labels in %s, independently of limited skin quality",
    (locale) => {
      const html = render(measured, locale);
      for (const value of [23.4, 34.5, 18.6]) {
        expect(html).toContain(`${value.toFixed(1)}%`);
        expect(html).toContain(`aria-valuenow="${value}"`);
      }
      expect(html.match(/role="meter"/g)).toHaveLength(3);
      for (const key of ["eyeRatio", "noseRatio", "lipRatio"] as const)
        expect(html).toContain(bt(locale, key));
    },
  );

  it.each([null, { status: "unavailable", reason: "pose" }] as const)(
    "never fills missing measurements with animal probabilities or substitute numbers: %j",
    (ratios) => {
      const html = render(ratios);
      expect(html).not.toContain('role="meter"');
      expect(html).not.toContain("aria-valuenow");
      expect(html).not.toMatch(/\d+(?:\.\d+)?%/);
      expect(html).toContain(bt("en", "ratiosUnavailable"));
    },
  );

  it.each([NaN, Infinity, -2, 0, 100, 120])(
    "hides an invalid worker measurement (%s) while preserving the other actual ratios",
    (value) => {
      const html = render({ ...measured, eyeHeightWidth: value });
      expect(html.match(/role="meter"/g)).toHaveLength(2);
      expect(html).toContain('aria-valuenow="34.5"');
      expect(html).toContain('aria-valuenow="18.6"');
      expect(html).not.toContain('aria-valuenow="NaN"');
      expect(html).not.toContain('aria-valuenow="Infinity"');
    },
  );

  it("omits an uncertain animal rather than inventing a likeness", () => {
    const html = render(measured, "en", {
      ...analysis,
      animalVibe: "uncertain",
    });
    expect(html).not.toContain("🐱");
    expect(html).not.toContain("🐶");
    expect(html).toContain('aria-valuenow="23.4"');
  });
});

describe("confirmed color study", () => {
  it.each(beautyLocales)(
    "keeps confirmed palette and base undertones independent in %s",
    (locale) => {
      const palette = personalColorPalettes.find((p) => p.id === "warm_soft")!;
      const html = renderToStaticMarkup(
        createElement(ReferenceColorStudy, {
          palette,
          base: {
            undertone: "cool",
            depth: "medium",
            concealerPurpose: "match",
          },
          locale,
        }),
      );
      const card = (key: string) =>
        html.match(
          new RegExp(`data-color-card="${key}"[^>]*>([\\s\\S]*?)</article>`),
        )?.[1];
      expect(card("palette")).toContain(beautyLabel(locale, palette.id));
      for (const color of palette.swatches)
        expect(card("palette")).toContain(color);
      expect(card("undertone")).toContain(beautyLabel(locale, "cool"));
      expect(card("depth")).toContain(bt(locale, "mediumDepth"));
      expect(card("chroma")).toContain(bt(locale, "paletteSoft"));
      expect(html).not.toContain("aria-valuenow");
      expect(html).not.toMatch(/\d+(?:\.\d+)?%/);
    },
  );

  it("does not turn a known palette into an unconfirmed base depth or undertone", () => {
    const html = renderToStaticMarkup(
      createElement(ReferenceColorStudy, {
        palette: personalColorPalettes[0],
        base: {
          undertone: "unknown",
          depth: "unknown",
          concealerPurpose: "match",
        },
        locale: "en",
      }),
    );
    for (const key of ["undertone", "depth"]) {
      const card = html.match(
        new RegExp(`data-color-card="${key}"[^>]*>([\\s\\S]*?)</article>`),
      )?.[1];
      expect(card).toContain(bt("en", "unknown"));
    }
  });
});
