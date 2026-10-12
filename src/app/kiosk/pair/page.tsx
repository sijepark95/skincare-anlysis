"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Brand } from "@/ui/brand";
import { api, json } from "@/ui/api";
import { useHydrated } from "@/ui/use-hydrated";
export default function PairPage() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const router = useRouter();
  const hydrated = useHydrated();
  return (
    <main className="auth-page">
      <Brand />
      <form
        className="auth-card"
        method="post"
        action="/api/v1/device/pair"
        aria-busy={busy || !hydrated}
        onSubmit={async (e) => {
          e.preventDefault();
          if (submitting.current) return;
          submitting.current = true;
          setBusy(true);
          setError("");
          try {
            await api("device/pair", {
              method: "POST",
              body: json({ code: code.replace(/\s/g, "") }),
            });
            router.replace("/kiosk");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        <span className="eyebrow">A NEW SKIN MOMENT</span>
        <h1>Pair your tablet.</h1>
        <p>
          Create a code in your store workspace's Devices page, then enter it
          here. Each code can be used once and expires after 10 minutes.
        </p>
        <label>
          Pairing code
          <input
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            name="pairing-code"
            className="pairing-input"
            placeholder="ABCD 1234 ABCD 1234"
            required
            pattern="[A-Fa-f0-9]{4}( [A-Fa-f0-9]{4}){3}"
            maxLength={19}
            disabled={busy || !hydrated}
            aria-describedby={
              error ? "pairing-error pairing-help" : "pairing-help"
            }
            value={code}
            onChange={(e) => {
              const characters = e.target.value
                .replace(/\s/g, "")
                .toUpperCase();
              setCode(
                characters
                  .slice(0, 16)
                  .match(/.{1,4}/g)
                  ?.join(" ") ?? "",
              );
            }}
          />
        </label>
        <p id="pairing-help" className="fine-print">
          Pair this browser on the tablet used by customers. Keep its browser
          data to stay connected.
        </p>
        {error && (
          <p id="pairing-error" className="notice error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary wide" disabled={busy || !hydrated}>
          {busy ? "Pairing…" : "Pair this tablet"}
        </button>
        <noscript>Enable JavaScript to pair this tablet securely.</noscript>
        <Link className="text-button centered" href="/kiosk">
          Open kiosk
        </Link>
        <Link className="text-button centered" href="/management">
          Open store workspace
        </Link>
      </form>
    </main>
  );
}
