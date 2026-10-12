"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Brand } from "@/ui/brand";
import { api, json } from "@/ui/api";
import { useHydrated } from "@/ui/use-hydrated";
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
        action="/api/v1/auth/login"
        aria-busy={busy || !hydrated}
        onSubmit={async (e) => {
          e.preventDefault();
          if (submitting.current) return;
          submitting.current = true;
          setError("");
          setBusy(true);
          try {
            const result = await api<{ next?: "setup" | "management" }>(
              "auth/login",
              {
                method: "POST",
                body: json({ email: email.trim(), password }),
              },
            );
            router.replace(
              result.next === "setup" ? "/management/setup" : "/management",
            );
          } catch (e) {
            setError((e as Error).message);
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        <span className="eyebrow">YOUR STORE, THOUGHTFULLY CONNECTED</span>
        <h1>Welcome back.</h1>
        <p>Sign in to manage your store, products and connected tablets.</p>
        <label>
          Email address
          <input
            type="email"
            name="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={200}
            required
            disabled={busy || !hydrated}
            aria-describedby={error ? "login-error" : undefined}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            maxLength={256}
            required
            disabled={busy || !hydrated}
            aria-describedby={error ? "login-error" : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p id="login-error" className="notice error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary wide" disabled={busy || !hydrated}>
          {busy ? "Signing in…" : "Sign in to workspace"}
        </button>
        <noscript>Enable JavaScript to sign in securely.</noscript>
        <Link className="text-button centered" href="/management/signup">
          New to AELUNE? Sign up
        </Link>
        <p className="fine-print">
          Joining an existing team or need a password reset? Contact your
          organization owner.
        </p>
        <Link className="text-button centered" href="/">
          Back to AELUNE
        </Link>
      </form>
    </main>
  );
}
