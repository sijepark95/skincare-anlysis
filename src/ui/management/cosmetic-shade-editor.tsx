"use client";
import { useEffect, useState } from "react";
import type { Product } from "@/domain/types";
import {
  baseDepths,
  cosmeticHueFamilies,
  cosmeticFinishes,
  type CosmeticShade,
  type CosmeticShadeDraft,
  isCosmeticCategory,
} from "@/domain/cosmetic-shades";
import { Modal } from "../modal";
import { api, json } from "../api";

/** A review creates an immutable shade version; draft product/formula publication is separate. */
export function CosmeticShadeEditor({
  product,
  storeId,
  close,
  saved,
}: {
  product: Product;
  storeId: string;
  close: () => void;
  saved: () => void;
}) {
  const [fields, setFields] = useState({
    shadeName: "",
    undertone: "neutral",
    finish: "satin",
    swatchHex: "#BA8B7C",
    hueFamily: "rose",
    intensity: "soft",
    depth: "medium",
    coverage: "medium",
  });
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const isBase =
    product.category === "foundation" || product.category === "concealer";
  useEffect(() => {
    const controller = new AbortController();
    api<{ shades: CosmeticShade[] }>(
      `management/cosmetic-shades?storeId=${encodeURIComponent(storeId)}`,
      { signal: controller.signal },
    )
      .then(({ shades }) => {
        if (controller.signal.aborted) return;
        const shade = shades.find((s) => s.variantId === product.id);
        if (shade) {
          setFields((f) => ({
            ...f,
            shadeName: shade.shadeName,
            undertone: shade.undertone,
            finish: shade.finish,
            swatchHex: shade.swatchHex,
            ...("depth" in shade
              ? { depth: shade.depth, coverage: shade.coverage }
              : { hueFamily: shade.hueFamily, intensity: shade.intensity }),
          }));
          setVersion(shade.version);
        }
        setLoaded(true);
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [product.id, storeId]);
  function change(key: keyof typeof fields, value: string) {
    setFields((f) => ({ ...f, [key]: value }));
    setReviewed(false);
  }
  return (
    <Modal title="Review cosmetic shade" close={close}>
      <h3>{product.name}</h3>
      <p className="fine-print">
        Record the shade sold under this catalog item.{" "}
        {version ? `Current reviewed version: ${version}. ` : ""}Saving creates
        a new version. Stock, visibility and formula are reviewed separately.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            busy ||
            !reviewed ||
            !loaded ||
            !isCosmeticCategory(product.category)
          )
            return;
          setBusy(true);
          setError("");
          const common = {
            category: product.category,
            shadeName: fields.shadeName.trim(),
            undertone: fields.undertone,
            finish: fields.finish,
            swatchHex: fields.swatchHex,
            reviewed: true,
          };
          const draft = {
            ...common,
            ...(isBase
              ? { depth: fields.depth, coverage: fields.coverage }
              : { hueFamily: fields.hueFamily, intensity: fields.intensity }),
          } as CosmeticShadeDraft;
          try {
            await api(
              `management/products/${product.id}/cosmetic-shade?storeId=${encodeURIComponent(storeId)}`,
              { method: "POST", body: json(draft) },
            );
            saved();
          } catch (cause) {
            setError((cause as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset
          disabled={busy || !loaded}
          style={{ border: 0, padding: 0, minWidth: 0 }}
        >
          <div className="form-grid">
            <label className="full">
              Shade name
              <input
                required
                maxLength={80}
                value={fields.shadeName}
                onChange={(e) => change("shadeName", e.target.value)}
              />
            </label>
            <label>
              Undertone
              <select
                value={fields.undertone}
                onChange={(e) => change("undertone", e.target.value)}
              >
                {["warm", "cool", "neutral"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              Finish
              <select
                value={fields.finish}
                onChange={(e) => change("finish", e.target.value)}
              >
                {cosmeticFinishes
                  .filter((v) =>
                    isBase
                      ? ["matte", "satin", "natural", "radiant"].includes(v)
                      : product.category === "lip_color"
                        ? ["gloss", "satin", "matte"].includes(v)
                        : true,
                  )
                  .map((v) => (
                    <option key={v}>{v}</option>
                  ))}
              </select>
            </label>
            {isBase ? (
              <>
                <label>
                  Registered depth
                  <select
                    value={fields.depth}
                    onChange={(e) => change("depth", e.target.value)}
                  >
                    {baseDepths.map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Coverage
                  <select
                    value={fields.coverage}
                    onChange={(e) => change("coverage", e.target.value)}
                  >
                    {["sheer", "medium", "full"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <>
                <label>
                  Hue family
                  <select
                    value={fields.hueFamily}
                    onChange={(e) => change("hueFamily", e.target.value)}
                  >
                    {cosmeticHueFamilies
                      .filter(
                        (v) =>
                          product.category !== "lip_color" ||
                          [
                            "peach",
                            "coral",
                            "rose",
                            "berry",
                            "nude",
                            "red",
                            "mauve",
                          ].includes(v),
                      )
                      .map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                  </select>
                </label>
                <label>
                  Intensity
                  <select
                    value={fields.intensity}
                    onChange={(e) => change("intensity", e.target.value)}
                  >
                    <option value="soft">Soft / muted</option>
                    <option value="clear">Clear / vivid</option>
                  </select>
                </label>
              </>
            )}
            <label className="full">
              Screen swatch (hex)
              <input
                required
                pattern="#[0-9A-Fa-f]{6}"
                maxLength={7}
                value={fields.swatchHex}
                onChange={(e) => change("swatchHex", e.target.value)}
              />
            </label>
          </div>
          <p className="fine-print">
            Screen swatches are approximate. Compare the physical tester and
            manufacturer shade specification.
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            I checked this metadata against the actual product label and shade
            specification.
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="button-secondary" onClick={close}>
              Cancel
            </button>
            <button
              type="submit"
              className="button-primary"
              disabled={busy || !loaded || !reviewed}
            >
              {busy ? "Publishing…" : "Publish reviewed shade"}
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
