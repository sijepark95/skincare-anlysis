"use client";
import { useMemo, useRef, useState } from "react";
import type { CatalogWrite } from "@/application/contracts";
import {
  catalogLimits,
  parseIngredientInput,
  productCategories,
  skinTypes,
  validateCatalogDraftStructure,
  type CatalogField,
  type CatalogFieldErrors,
} from "@/domain";
import { ApiError } from "../api";
import { Modal } from "../modal";

const fieldOrder: CatalogField[] = [
  "name",
  "brand",
  "sku",
  "category",
  "priceMinor",
  "stock",
  "ingredients",
  "formulaComplete",
  "suitableSkinTypes",
];
const domainFields: Record<string, CatalogField> = {
  name: "name",
  brand: "brand",
  sku: "sku",
  category: "category",
  price: "priceMinor",
  currency: "currency",
  stock: "stock",
  ingredients: "ingredients",
  skin_types: "suitableSkinTypes",
};
const correctionMessage =
  "Correct the highlighted product fields and try again.";

export function ProductEditor({
  initial,
  close,
  save,
}: {
  initial: CatalogWrite;
  close: () => void;
  save: (value: CatalogWrite) => Promise<void>;
}) {
  const [value, setValue] = useState<CatalogWrite>({
    id: initial.id,
    sku: initial.sku,
    brand: initial.brand,
    name: initial.name,
    category: initial.category,
    priceMinor: initial.priceMinor,
    currency: initial.currency,
    stock: initial.stock,
    visible: initial.visible,
    ingredients: initial.ingredients,
    formulaComplete: initial.formulaComplete,
    suitableSkinTypes: initial.suitableSkinTypes,
  });
  const [ingredients, setIngredients] = useState(
    initial.ingredients.join(", "),
  );
  const parsed = useMemo(
    () => parseIngredientInput(ingredients),
    [ingredients],
  );
  const [priceText, setPriceText] = useState(
    (initial.priceMinor / 100).toString(),
  );
  const [stockText, setStockText] = useState(initial.stock.toString());
  const [error, setError] = useState("");
  const [fields, setFields] = useState<CatalogFieldErrors>({});
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const errorSummary = useRef<HTMLParagraphElement>(null);

  function clearField(field: CatalogField) {
    setFields((current) => ({ ...current, [field]: undefined }));
    setError("");
  }
  function fieldError(field: CatalogField) {
    return fields[field] ? (
      <p
        id={"product-" + field + "-error"}
        className="fine-print"
        style={{ color: "var(--danger)", marginTop: 8 }}
      >
        {fields[field]}
      </p>
    ) : null;
  }
  function fieldProps(field: CatalogField, help?: string) {
    return {
      "data-catalog-field": field,
      "aria-invalid": !!fields[field],
      "aria-describedby":
        [help, fields[field] ? "product-" + field + "-error" : undefined]
          .filter(Boolean)
          .join(" ") || undefined,
    };
  }
  function report(next: CatalogFieldErrors, message = correctionMessage) {
    setFields(next);
    setError(message);
    requestAnimationFrame(() => {
      for (const field of fieldOrder) {
        if (!next[field]) continue;
        const control = form.current?.querySelector<HTMLElement>(
          '[data-catalog-field="' + field + '"]:not(:disabled)',
        );
        if (control) {
          control.focus();
          return;
        }
      }
      errorSummary.current?.focus();
    });
  }

  return (
    <Modal
      title={initial.id ? "Edit product details" : "Add a product"}
      close={close}
    >
      <p className="fine-print">
        Shared across your organization's stores. Saving creates a formulation
        draft for review. Existing product identity is fixed; use Store listing
        to change price, stock and visibility. New products start hidden.
      </p>
      <form
        ref={form}
        noValidate
        aria-busy={busy}
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current) return;
          const draft: CatalogWrite = {
            ...value,
            name: value.name.trim(),
            brand: value.brand.trim(),
            sku: value.sku.trim(),
            priceMinor: Math.round(Number(priceText) * 100),
            stock: Number(stockText),
            ingredients: parsed.ingredients,
          };
          const issues: CatalogFieldErrors = {};
          for (const issue of validateCatalogDraftStructure(draft).errors) {
            const field = domainFields[issue.column];
            if (field === "sku" && !initial.id && !draft.sku) continue;
            if (field && !issues[field]) issues[field] = issue.message;
          }
          if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(priceText.trim()))
            issues.priceMinor =
              "Enter a USD price with at most two decimal places.";
          if (!/^\d+$/.test(stockText.trim()))
            issues.stock =
              "Enter a whole number from 0 to " +
              catalogLimits.stockMax.toLocaleString("en-US") +
              ".";
          if (parsed.requiresReview)
            issues.ingredients =
              "Review the extracted ingredient names and choose Use extracted ingredients before saving.";
          else if (!draft.ingredients.length)
            issues.ingredients =
              "Enter at least one ingredient for this draft.";
          if (Object.keys(issues).length) {
            report(issues);
            return;
          }
          submitting.current = true;
          setBusy(true);
          setError("");
          setFields({});
          try {
            await save(draft);
          } catch (failure) {
            if (
              failure instanceof ApiError &&
              Object.keys(failure.fields).length
            )
              report(failure.fields, failure.message);
            else
              setError(
                failure instanceof Error
                  ? failure.message
                  : "The product could not be saved. Please try again.",
              );
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <div>
            <label>
              Product name
              <input
                required
                maxLength={catalogLimits.nameMax}
                disabled={busy || !!initial.id}
                {...fieldProps("name")}
                value={value.name}
                onChange={(event) => {
                  setValue({ ...value, name: event.target.value });
                  clearField("name");
                }}
              />
            </label>
            {fieldError("name")}
          </div>
          <div>
            <label>
              Brand
              <input
                required
                maxLength={catalogLimits.brandMax}
                disabled={busy || !!initial.id}
                {...fieldProps("brand")}
                value={value.brand}
                onChange={(event) => {
                  setValue({ ...value, brand: event.target.value });
                  clearField("brand");
                }}
              />
            </label>
            {fieldError("brand")}
          </div>
          <div>
            <label>
              SKU
              <input
                minLength={catalogLimits.skuMin}
                maxLength={catalogLimits.skuMax}
                disabled={busy || !!initial.id}
                {...fieldProps("sku", "product-sku-help")}
                value={value.sku}
                onChange={(event) => {
                  setValue({ ...value, sku: event.target.value });
                  clearField("sku");
                }}
              />
            </label>
            <p
              id="product-sku-help"
              className="fine-print"
              style={{ marginTop: 8 }}
            >
              {initial.id
                ? "The existing product code cannot be changed."
                : "Optional. We assign an internal code when left blank."}
            </p>
            {fieldError("sku")}
          </div>
          <div>
            <label>
              Category
              <select
                disabled={busy || !!initial.id}
                {...fieldProps("category")}
                value={value.category}
                onChange={(event) => {
                  setValue({
                    ...value,
                    category: event.target.value as CatalogWrite["category"],
                  });
                  clearField("category");
                }}
              >
                {productCategories.map((category) => (
                  <option value={category} key={category}>
                    {category.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            {fieldError("category")}
          </div>
          <div>
            <label>
              Store price (USD)
              <input
                type="number"
                required
                min={0}
                max={catalogLimits.priceMinorMax / 100}
                step="0.01"
                disabled={busy || !!initial.id}
                {...fieldProps("priceMinor")}
                value={priceText}
                onChange={(event) => {
                  setPriceText(event.target.value);
                  clearField("priceMinor");
                }}
              />
            </label>
            {fieldError("priceMinor")}
          </div>
          <div>
            <label>
              Stock units
              <input
                type="number"
                required
                min={0}
                max={catalogLimits.stockMax}
                step={1}
                disabled={busy || !!initial.id}
                {...fieldProps("stock")}
                value={stockText}
                onChange={(event) => {
                  setStockText(event.target.value);
                  clearField("stock");
                }}
              />
            </label>
            {fieldError("stock")}
          </div>
          <div className="full">
            <label>
              Full INCI ingredient list
              <textarea
                required
                placeholder="Aqua, Glycerin, Niacinamide…"
                style={{ marginTop: 8 }}
                disabled={busy}
                {...fieldProps("ingredients", "product-ingredients-help")}
                value={ingredients}
                onChange={(event) => {
                  setIngredients(event.target.value);
                  clearField("ingredients");
                }}
              />
            </label>
            <p
              id="product-ingredients-help"
              className="fine-print"
              style={{ marginTop: 8 }}
            >
              Separate names with commas, semicolons or new lines. You can also
              paste an ingredient report for review.
            </p>
            {fieldError("ingredients")}
            {parsed.requiresReview && (
              <div className="notice" aria-label="Ingredient extraction review">
                <h3>Review extracted ingredients</h3>
                <p>
                  Found {parsed.ingredients.length} ingredient names. Only names
                  will be used; ratings and benefits are not imported.
                </p>
                <ol
                  aria-label="Extracted ingredient names"
                  tabIndex={0}
                  style={{ maxHeight: 180, overflowY: "auto" }}
                >
                  {parsed.ingredients.map((name, index) => (
                    <li key={index}>{name}</li>
                  ))}
                </ol>
                {parsed.warnings.map((warning, index) => (
                  <p key={index} className="fine-print">
                    {warning}
                  </p>
                ))}
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy || !parsed.ingredients.length}
                  onClick={() => {
                    setIngredients(parsed.ingredients.join("; "));
                    clearField("ingredients");
                  }}
                >
                  Use extracted ingredients
                </button>
                <p className="fine-print">
                  Check the original complete formula before marking it
                  verified.
                </p>
              </div>
            )}
          </div>
        </div>
        <div className="form-checks">
          <label>
            <input
              type="checkbox"
              disabled={busy}
              {...fieldProps("formulaComplete")}
              checked={value.formulaComplete}
              onChange={(event) => {
                setValue({ ...value, formulaComplete: event.target.checked });
                clearField("formulaComplete");
              }}
            />
            Full formula verified
          </label>
          {fieldError("formulaComplete")}
        </div>
        <fieldset
          {...fieldProps("suitableSkinTypes")}
          tabIndex={-1}
          style={{
            border: "1px solid var(--line)",
            borderRadius: 12,
            padding: "12px 16px",
          }}
        >
          <legend className="fine-print">Suitable skin types (optional)</legend>
          <div className="form-checks" style={{ margin: 0 }}>
            {skinTypes.map((type) => (
              <label key={type}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={value.suitableSkinTypes.includes(type)}
                  onChange={(event) => {
                    setValue({
                      ...value,
                      suitableSkinTypes: event.target.checked
                        ? [...value.suitableSkinTypes, type]
                        : value.suitableSkinTypes.filter(
                            (current) => current !== type,
                          ),
                    });
                    clearField("suitableSkinTypes");
                  }}
                />
                {type}
              </label>
            ))}
          </div>
          {fieldError("suitableSkinTypes")}
        </fieldset>
        {error && (
          <p
            ref={errorSummary}
            tabIndex={-1}
            className="notice error"
            role="alert"
          >
            {error}
          </p>
        )}
        <p className="fine-print">
          Unknown ingredients can be held in a draft but must be resolved before
          publication. Ingredient concentrations are not inferred.
        </p>
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Saving…" : "Save draft"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
