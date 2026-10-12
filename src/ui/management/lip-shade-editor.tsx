"use client";

import { useEffect, useRef, useState } from "react";
import type { Product } from "@/domain";
import {
  lipFinishes,
  lipHueFamilies,
  type LipShade,
  type LipShadeDraft,
} from "@/domain/personal-color";
import { api, json } from "../api";
import { Modal } from "../modal";
import "../personal-color.css";

type Fields = Omit<LipShadeDraft, "reviewed">;
const initial: Fields = {
  shadeName: "",
  hueFamily: "rose",
  undertone: "neutral",
  intensity: "soft",
  finish: "satin",
  swatchHex: "#BA8B7C",
};

/** Owner publication of registered metadata; inventory/formulation stay in their own editors. */
export function LipShadeEditor({
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
  const [fields, setFields] = useState<Fields>(initial);
  const [version, setVersion] = useState(0);
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  const saveRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    api<{ shades: LipShade[] }>(
      `management/lip-shades?storeId=${encodeURIComponent(storeId)}`,
      { signal: controller.signal },
    )
      .then(({ shades }) => {
        if (!active.current || controller.signal.aborted) return;
        const shade = shades.find((item) => item.variantId === product.id);
        if (shade) {
          setFields({
            shadeName: shade.shadeName,
            hueFamily: shade.hueFamily,
            undertone: shade.undertone,
            intensity: shade.intensity,
            finish: shade.finish,
            swatchHex: shade.swatchHex,
          });
          setVersion(shade.version);
        }
        setLoaded(true);
      })
      .catch((cause: Error) => {
        if (active.current && !controller.signal.aborted)
          setError(cause.message);
      })
      .finally(() => {
        if (active.current && !controller.signal.aborted) setBusy(false);
      });
    return () => {
      active.current = false;
      controller.abort();
      saveRequest.current?.abort();
    };
  }, [product.id, storeId]);

  function change<K extends keyof Fields>(key: K, value: Fields[K]) {
    setFields((current) => ({ ...current, [key]: value }));
    setReviewed(false);
  }

  return (
    <Modal title="Review lip shade" close={close}>
      <h3>{product.name}</h3>
      <p className="fine-print">
        Register the actual shade sold under this catalog item. Publication
        creates a new reviewed shade version
        {version ? ` after version ${version}` : ""}; it does not publish the
        product or change its stock, formula or store visibility.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !reviewed || !loaded) return;
          setBusy(true);
          setError("");
          const controller = new AbortController();
          saveRequest.current = controller;
          try {
            await api(
              `management/lip-shades/${product.id}?storeId=${encodeURIComponent(storeId)}`,
              {
                method: "PUT",
                signal: controller.signal,
                body: json({
                  ...fields,
                  shadeName: fields.shadeName.trim(),
                  reviewed: true,
                }),
              },
            );
            if (active.current && !controller.signal.aborted) saved();
          } catch (cause) {
            if (active.current && !controller.signal.aborted)
              setError((cause as Error).message);
          } finally {
            if (active.current && !controller.signal.aborted) setBusy(false);
          }
        }}
      >
        <fieldset
          disabled={busy || !loaded}
          style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
        >
          <div className="form-grid">
            <label className="full">
              Shade name
              <input
                required
                maxLength={80}
                value={fields.shadeName}
                onChange={(event) => change("shadeName", event.target.value)}
                placeholder="Actual product shade name"
              />
            </label>
            <label>
              Hue family
              <select
                value={fields.hueFamily}
                onChange={(event) =>
                  change("hueFamily", event.target.value as Fields["hueFamily"])
                }
              >
                {lipHueFamilies.map((value) => (
                  <option key={value} value={value}>
                    {value[0].toUpperCase() + value.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Undertone
              <select
                value={fields.undertone}
                onChange={(event) =>
                  change("undertone", event.target.value as Fields["undertone"])
                }
              >
                <option value="warm">Warm</option>
                <option value="cool">Cool</option>
                <option value="neutral">Neutral</option>
              </select>
            </label>
            <label>
              Intensity
              <select
                value={fields.intensity}
                onChange={(event) =>
                  change("intensity", event.target.value as Fields["intensity"])
                }
              >
                <option value="soft">Soft / muted</option>
                <option value="clear">Clear / vivid</option>
              </select>
            </label>
            <label>
              Finish
              <select
                value={fields.finish}
                onChange={(event) =>
                  change("finish", event.target.value as Fields["finish"])
                }
              >
                {lipFinishes.map((value) => (
                  <option key={value} value={value}>
                    {value[0].toUpperCase() + value.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="full">
              Screen swatch (hex)
              <input
                required
                pattern="#[0-9A-Fa-f]{6}"
                maxLength={7}
                spellCheck={false}
                value={fields.swatchHex}
                onChange={(event) => change("swatchHex", event.target.value)}
                aria-describedby="lip-swatch-help"
              />
            </label>
          </div>
          <div className="lip-shade-preview">
            <i
              aria-hidden="true"
              style={{
                backgroundColor: /^#[0-9a-f]{6}$/i.test(fields.swatchHex)
                  ? fields.swatchHex
                  : "transparent",
              }}
            />
            <span id="lip-swatch-help" className="fine-print">
              A screen approximation only. Compare the physical tester and
              merchant shade specification.
            </span>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            I reviewed this actual product&apos;s shade name, color direction,
            finish and screen swatch for publication.
          </label>
        </fieldset>
        {busy && (
          <p role="status">
            {loaded
              ? "Publishing reviewed shade…"
              : "Loading registered shade…"}
          </p>
        )}
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || !loaded || !reviewed}
          >
            Publish reviewed shade
          </button>
        </div>
      </form>
    </Modal>
  );
}
