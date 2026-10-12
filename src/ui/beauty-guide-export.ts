import type {
  BeautyGuide,
  BeautyPreferences,
  BeautyStyleIdea,
} from "@/domain/beauty";

export interface BeautyGuideExportProduct {
  name: string;
  brand: string;
  shadeName: string;
  finish: string;
  swatchHex: string;
  priceMinor: number | null;
  currency: string | null;
  available?: boolean;
}
export interface BeautyGuideExport {
  guide: BeautyGuide;
  preferences: BeautyPreferences;
  products: BeautyGuideExportProduct[];
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
const swatch = (value: string) =>
  /^#[0-9a-f]{6}$/i.test(value) ? value : "#B98788";
function price(product: BeautyGuideExportProduct) {
  if (
    product.priceMinor === null ||
    !Number.isSafeInteger(product.priceMinor) ||
    product.priceMinor < 0 ||
    !product.currency ||
    !/^[A-Z]{3}$/.test(product.currency)
  )
    return "Ask the store about current price.";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: product.currency,
    }).format(product.priceMinor / 100);
  } catch {
    return "Ask the store about current price.";
  }
}
function ideas(title: string, values: BeautyStyleIdea[]) {
  return `<section><h2>${escape(title)}</h2><div class="cards">${values.map((idea) => `<article class="card"><h3>${escape(idea.title)}</h3><p>${escape(idea.description)}</p></article>`).join("")}</div></section>`;
}

/** Explicit allow-list: never serialize the session, observations, consent or private share token. */
export function renderBeautyGuideHtml(value: BeautyGuideExport): string {
  const { guide, preferences, products } = value;
  const mood = {
    soft: "Softly blended",
    fresh: "Fresh color",
    defined: "Quiet definition",
  }[preferences.mood];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Your AELUNE beauty guide</title><style>
*{box-sizing:border-box}body{margin:0;background:#f8f6f3;color:#332c2c;font:16px/1.65 Arial,Helvetica,sans-serif}main{max-width:1040px;margin:auto;padding:48px 32px}h1,h2{font-family:Georgia,serif;font-weight:400;line-height:1.15}h1{font-size:48px;margin:20px 0}h2{font-size:32px;margin:0 0 20px}h3{font-size:18px;margin:0 0 12px}p{margin:12px 0;color:#655e5c}header{border-bottom:1px solid #ded6d1;padding-bottom:32px}.brand{letter-spacing:.2em;font-family:Georgia,serif;font-size:22px}.eyebrow{font-size:12px;letter-spacing:.12em;color:#865965}section{margin:40px 0}.summary{display:flex;flex-wrap:wrap;gap:24px;padding:20px;background:#f0e4e1;border-radius:16px}.summary div{flex:1;min-width:160px}.summary dt{font-size:12px;color:#655e5c}.summary dd{margin:6px 0 0;text-transform:capitalize}.swatches{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;max-width:600px}.swatches span{text-align:center}.swatch{display:block;width:100%;aspect-ratio:1;border-radius:50%;border:6px solid #fff;margin-bottom:12px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}.card{background:#fff;border:1px solid #ded6d1;border-radius:16px;padding:24px;break-inside:avoid;overflow-wrap:anywhere}.product-swatch{height:80px;border-radius:10px;margin-bottom:20px}.small,small{font-size:13px}footer{border-top:1px solid #ded6d1;padding-top:24px;margin-top:40px}@media(max-width:600px){main{padding:32px 20px}h1{font-size:38px}.cards{grid-template-columns:1fr}.swatches{gap:12px}.swatch{border-width:3px}}@media print{body{background:#fff}main{max-width:none;padding:0}h1{font-size:36px}section{margin:28px 0}.card{box-shadow:none}.offline-note{display:none}@page{margin:15mm}}
</style></head><body><main><header><div class="brand">AELUNE</div><p class="eyebrow">YOUR CONFIRMED BEAUTY EDIT</p><h1>A little more your kind of beautiful.</h1><p>A personal style starting point, made with the choices you confirmed.</p><p class="small offline-note">This guide opens offline. Use your browser’s Print menu to print or save a PDF.</p></header>
<section><dl class="summary"><div><dt>Confirmed palette</dt><dd>${escape(guide.palette.name)}</dd></div><div><dt>Your chosen outline</dt><dd>${escape(preferences.faceShape === "unsure" ? "Open to exploring" : preferences.faceShape)}</dd></div><div><dt>Your makeup mood</dt><dd>${escape(mood)}</dd></div><div><dt>Hair length to explore</dt><dd>${escape(preferences.hairLength === "any" ? "Open to any length" : preferences.hairLength)}</dd></div><div><dt>Preferred lip finish</dt><dd>${escape(preferences.finish === "any" ? "Open to any finish" : preferences.finish)}</dd></div></dl></section>
<section><h2>Your color story: ${escape(guide.palette.name)}</h2><p>${escape(guide.palette.description)}</p><div class="swatches">${guide.palette.swatches.map((color) => `<span><i class="swatch" style="background:${swatch(color)}"></i><small>${escape(swatch(color))}</small></span>`).join("")}</div><p class="small">Screen and printed colors are approximate. Compare real swatches in even light.</p></section>
${ideas("Makeup moods to explore", guide.makeupMoods)}${ideas("Haircut ideas", guide.hairCuts)}${ideas("Hair color ideas", guide.hairColors)}${ideas("Jewelry ideas", guide.jewelry)}
<section><h2>Your registered lip color edit</h2>${products.length ? `<div class="cards">${products.map((product) => `<article class="card"><div class="product-swatch" style="background:${swatch(product.swatchHex)}"></div><p class="eyebrow">${escape(product.brand)}</p><h3>${escape(product.name)}</h3><p>${escape(product.shadeName)} · ${escape(product.finish)}</p><p>${escape(price(product))}</p><p class="small">${product.available === false ? "Currently unavailable when this guide was read. Keep this as a shade reference." : "Listed at your consultation. Confirm current price and availability with the store."}</p></article>`).join("")}</div>` : `<p>No eligible registered lip shades matched this store’s catalog and your confirmed choices.</p>`}<p class="small">Check the full ingredient label and compare a tester. A color match does not establish suitability or allergy safety.</p></section>
<footer><p>Style inspiration based on your confirmed choices. This is not a calibrated color assessment, a measured face analysis or virtual try-on.</p><p class="small">The guide contains no photo, AI observations or private access link. This downloaded copy stays available until you delete it from your own device.</p></footer></main></body></html>`;
}
