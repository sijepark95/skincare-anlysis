"use client";
import { useState } from "react";
import { catalogLimits, type Product } from "@/domain";
import { Modal } from "../modal";
export function ListingEditor({
  product,
  close,
  save,
}: {
  product: Product;
  close: () => void;
  save: (value: {
    priceMinor: number;
    stock: number;
    visible: boolean;
  }) => Promise<void>;
}) {
  const [price, setPrice] = useState((product.priceMinor / 100).toString()),
    [stock, setStock] = useState(product.stock),
    [visible, setVisible] = useState(product.visible),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title="Store listing" close={close}>
      <h3>{product.name}</h3>
      <p className="fine-print">Changes apply only to this store.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await save({
              priceMinor: Math.round(Number(price) * 100),
              stock,
              visible,
            });
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <label>
            Store price (USD)
            <input
              type="number"
              required
              min={0}
              max={catalogLimits.priceMinorMax / 100}
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </label>
          <label>
            Stock units
            <input
              type="number"
              required
              min={0}
              max={catalogLimits.stockMax}
              step={1}
              value={stock}
              onChange={(e) => setStock(Number(e.target.value))}
            />
          </label>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={visible}
            onChange={(e) => setVisible(e.target.checked)}
          />
          Visible in this store
        </label>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            Save listing
          </button>
        </div>
      </form>
    </Modal>
  );
}
