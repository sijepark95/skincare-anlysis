"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { StaffContext } from "@/application/contracts";
import { Brand } from "@/ui/brand";
import { api, json } from "@/ui/api";
import { useHydrated } from "@/ui/use-hydrated";

export default function SetupPage() {
  const [organizationName, setOrganizationName] = useState("");
  const [storeName, setStoreName] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const mounted = useRef(false);
  const router = useRouter();
  const hydrated = useHydrated();

  const loadAccount = useCallback(() => {
    return api<{
      authenticated: boolean;
      needsWorkspace: boolean;
      staff: StaffContext | null;
    }>("auth/account")
      .then((account) => {
        if (!mounted.current) return;
        setError("");
        if (!account.authenticated) {
          router.replace("/management/login");
        } else if (!account.needsWorkspace) {
          router.replace("/management");
        } else {
          setReady(true);
        }
      })
      .catch((e) => {
        if (mounted.current) setError((e as Error).message);
      });
  }, [router]);

  useEffect(() => {
    mounted.current = true;
    void loadAccount();
    return () => {
      mounted.current = false;
    };
  }, [loadAccount]);

  return (
    <main className="auth-page">
      <Brand />
      <form
        className="auth-card"
        method="post"
        action="/api/v1/auth/workspace"
        aria-busy={busy || !hydrated || (!ready && !error)}
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current || !ready) return;
          submitting.current = true;
          setBusy(true);
          setError("");
          try {
            await api("auth/workspace", {
              method: "POST",
              body: json({
                organizationName: organizationName.trim(),
                storeName: storeName.trim(),
              }),
            });
            router.replace("/management");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        <span className="eyebrow">A SPACE FOR YOUR STORE</span>
        <h1>Make it yours.</h1>
        <p>
          Set up your company and first store. You'll manage products and pair
          your tablets here.
        </p>
        {!ready && !error && (
          <p className="fine-print" role="status">
            Checking your account…
          </p>
        )}
        <label>
          Company name
          <input
            name="organization-name"
            autoComplete="organization"
            minLength={1}
            maxLength={120}
            required
            disabled={busy || !hydrated || !ready}
            aria-describedby={error ? "setup-error" : undefined}
            value={organizationName}
            onChange={(event) => setOrganizationName(event.target.value)}
          />
        </label>
        <label>
          First store name
          <input
            name="store-name"
            autoComplete="off"
            minLength={1}
            maxLength={120}
            required
            disabled={busy || !hydrated || !ready}
            aria-describedby="store-help"
            value={storeName}
            onChange={(event) => setStoreName(event.target.value)}
          />
        </label>
        <p id="store-help" className="fine-print">
          For example, Soho Studio. Store prices use USD in this release.
        </p>
        {error && (
          <p id="setup-error" className="notice error" role="alert">
            {error}
          </p>
        )}
        {!ready && error ? (
          <button
            type="button"
            className="button primary wide"
            disabled={!hydrated}
            onClick={() => {
              setError("");
              void loadAccount();
            }}
          >
            Try again
          </button>
        ) : (
          <button
            className="button primary wide"
            disabled={busy || !hydrated || !ready}
          >
            {busy ? "Creating workspace…" : "Create workspace"}
          </button>
        )}
        <noscript>
          Enable JavaScript to set up your workspace securely.
        </noscript>
        <Link className="text-button centered" href="/management/login">
          Back to sign in
        </Link>
      </form>
    </main>
  );
}
