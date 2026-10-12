"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { api, json } from "@/ui/api";
import { Modal } from "@/ui/modal";

type PairingCode = { code: string; expiresAt: string };

export function PairingDialog({
  storeId,
  storeName,
  close,
}: {
  storeId: string;
  storeName: string;
  close: () => void;
}) {
  const [pairCode, setPairCode] = useState<PairingCode | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const mounted = useRef(true);
  const submitting = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!pairCode) return;
    const timeout = window.setTimeout(
      () => setExpired(true),
      Math.max(0, new Date(pairCode.expiresAt).getTime() - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [pairCode]);

  return (
    <Modal title="Pair a new device" close={close}>
      <p>
        Connect a tablet to <strong>{storeName}</strong>.
      </p>
      {pairCode && !expired ? (
        <>
          <p>Enter this one-time code in the browser on your store tablet.</p>
          <div className="pair-code" aria-label="Pairing code">
            {pairCode.code.match(/.{1,4}/g)?.join(" ")}
          </div>
          <p className="fine-print" role="status">
            Expires {new Date(pairCode.expiresAt).toLocaleTimeString()}. Use
            only on a device you trust.
          </p>
          <Link className="button secondary wide" href="/kiosk/pair">
            Open pairing page <ArrowUpRight size={16} />
          </Link>
          <p className="fine-print">
            This link opens on this computer. On your tablet, open the same
            address and choose Pair this tablet.
          </p>
        </>
      ) : (
        <form
          aria-busy={busy}
          onSubmit={async (event) => {
            event.preventDefault();
            if (submitting.current) return;
            submitting.current = true;
            const form = new FormData(event.currentTarget);
            setBusy(true);
            setError("");
            try {
              const code = await api<PairingCode>(
                `management/pairing-codes?storeId=${storeId}`,
                { method: "POST", body: json({ label: form.get("label") }) },
              );
              if (!mounted.current) return;
              setExpired(false);
              setPairCode(code);
            } catch (cause) {
              if (mounted.current) setError((cause as Error).message);
            } finally {
              submitting.current = false;
              if (mounted.current) setBusy(false);
            }
          }}
        >
          {expired && (
            <p className="notice" role="status">
              This code has expired. Create a new code to continue.
            </p>
          )}
          <label className="field-label">
            Device name
            <input
              name="label"
              required
              maxLength={80}
              placeholder="Front counter tablet"
              disabled={busy}
            />
          </label>
          <p className="fine-print">
            Each code can be used once and expires after 10 minutes.
          </p>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <button className="button primary wide" disabled={busy}>
            {busy ? "Creating code…" : "Create pairing code"}
          </button>
        </form>
      )}
    </Modal>
  );
}
