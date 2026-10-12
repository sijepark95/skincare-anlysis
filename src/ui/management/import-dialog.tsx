"use client";
import { useState } from "react";
import { Check, Upload } from "lucide-react";
import type { CsvPreview } from "@/domain";
import { Modal } from "../modal";
import { api, json } from "../api";
export function ImportDialog({
  store,
  close,
  saved,
}: {
  store: string;
  close: () => void;
  saved: (count: number) => Promise<void>;
}) {
  const [csv, setCsv] = useState(""),
    [preview, setPreview] = useState<CsvPreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title="Import your product shelf" close={close}>
      <p className="fine-print">
        Upload a CSV, review every row, then import as drafts. Maximum 500
        products and 1 MiB. Any error blocks the whole import.
      </p>
      <a className="text-button" href="/templates/products.csv" download>
        <Upload size={15} />
        Download CSV template
      </a>
      <div className="import-area">
        <label>
          Choose product CSV
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              setPreview(null);
              setError("");
              setCsv("");
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 1048576) {
                setError("CSV must be no larger than 1 MiB.");
                return;
              }
              setCsv(await file.text());
            }}
          />
        </label>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {preview &&
        (preview.valid ? (
          <div className="preview-summary">
            <Check size={16} /> {preview.rows.length} products ready to import
            as drafts.
            <ul>
              {preview.rows.slice(0, 8).map((p) => (
                <li key={p.sku}>
                  {p.sku} · {p.name}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            <p className="notice error">Fix these rows before importing.</p>
            <ul className="import-errors">
              {preview.errors.map((e, i) => (
                <li key={i}>
                  Row {e.row} · {e.column}: {e.message}
                </li>
              ))}
            </ul>
          </>
        ))}
      <div className="form-actions">
        <button className="button secondary" onClick={close}>
          Cancel
        </button>
        {preview?.valid ? (
          <button
            className="button primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const result = await api<{ imported: number }>(
                  `management/import?storeId=${store}`,
                  { method: "POST", body: json({ csv }) },
                );
                await saved(result.imported);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Import {preview.rows.length} drafts
          </button>
        ) : (
          <button
            className="button primary"
            disabled={busy || !csv}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                setPreview(
                  await api<CsvPreview>(
                    `management/import/preview?storeId=${store}`,
                    { method: "POST", body: json({ csv }) },
                  ),
                );
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Checking…" : "Preview import"}
          </button>
        )}
      </div>
    </Modal>
  );
}
