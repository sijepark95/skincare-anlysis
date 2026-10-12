"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Brand } from "@/ui/brand";
import { api, json } from "@/ui/api";
import { useHydrated } from "@/ui/use-hydrated";

type Destination = "verify_email" | "setup" | "management";
type EmailDelivery =
  { mode: "local"; inboxUrl: string } | { mode: "smtp" } | { mode: "unknown" };

function confirmationMessage(
  delivery: EmailDelivery,
  kind: "signup" | "resend",
) {
  const eligibility =
    kind === "signup"
      ? "If this address is eligible"
      : "If this address is awaiting confirmation";
  if (delivery.mode === "local")
    return `${eligibility}, find the latest code in the development inbox below. No email is sent to your personal inbox.`;
  if (delivery.mode === "smtp")
    return `${eligibility}, a confirmation email has been requested. Check your inbox and spam folder for the latest code.`;
  return `${eligibility}, a confirmation code has been requested. Email delivery has not been configured or confirmed; contact the person managing this installation if no code arrives.`;
}

export default function SignupPage() {
  const [stage, setStage] = useState<"create" | "verify">("create");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [message, setMessage] = useState<"signup" | "resend" | null>(null);
  const [delivery, setDelivery] = useState<EmailDelivery>({ mode: "unknown" });
  const [busy, setBusy] = useState<"submit" | "resend" | null>(null);
  const submitting = useRef(false);
  const confirmationInput = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const hydrated = useHydrated();
  const disabled = busy !== null || !hydrated;

  useEffect(() => {
    const controller = new AbortController();
    void api<EmailDelivery>("auth/email-delivery", {
      signal: controller.signal,
    })
      .then((status) => {
        if (!controller.signal.aborted) setDelivery(status);
      })
      .catch(() => {
        // Unknown delivery keeps the form usable without promising delivery.
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (stage === "verify") {
      if (emailInput.current?.value.trim()) codeInput.current?.focus();
      else emailInput.current?.focus();
    }
  }, [stage]);

  function proceed(next: Destination) {
    if (next === "verify_email") {
      setStage("verify");
      setMessage("signup");
      return;
    }
    router.replace(next === "setup" ? "/management/setup" : "/management");
  }

  async function resend() {
    if (submitting.current || !email.trim()) return;
    if (!emailInput.current?.reportValidity()) return;
    submitting.current = true;
    setBusy("resend");
    setError("");
    setMessage(null);
    try {
      await api("auth/resend-confirmation", {
        method: "POST",
        body: json({ email: email.trim() }),
      });
      setMessage("resend");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      submitting.current = false;
      setBusy(null);
    }
  }

  return (
    <main className="auth-page">
      <Brand />
      <form
        className="auth-card"
        method="post"
        action={
          stage === "create"
            ? "/api/v1/auth/signup"
            : "/api/v1/auth/verify-email"
        }
        aria-busy={disabled}
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current) return;
          setError("");
          setPasswordError("");
          setMessage(null);
          if (stage === "create" && password !== confirmation) {
            setPasswordError(
              "Passwords do not match. Enter the same password again.",
            );
            confirmationInput.current?.focus();
            return;
          }
          submitting.current = true;
          setBusy("submit");
          try {
            const result = await api<{ next: Destination }>(
              stage === "create" ? "auth/signup" : "auth/verify-email",
              {
                method: "POST",
                body: json(
                  stage === "create"
                    ? { email: email.trim(), password }
                    : { email: email.trim(), token },
                ),
              },
            );
            setPassword("");
            setConfirmation("");
            setToken("");
            proceed(result.next);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            submitting.current = false;
            setBusy(null);
          }
        }}
      >
        <span className="eyebrow">YOUR STORE, THOUGHTFULLY CONNECTED</span>
        <h1>
          {stage === "create"
            ? "A fresh start."
            : delivery.mode === "local"
              ? "Find your verification code."
              : delivery.mode === "smtp"
                ? "Check your inbox."
                : "Verify your email."}
        </h1>
        <p>
          {stage === "create"
            ? "Create your owner account, then set up your company and first store."
            : "Enter the email code to confirm your owner account and continue to your workspace."}
        </p>
        {delivery.mode === "local" && (
          <div className="notice" id="email-delivery-notice">
            <strong>Local development email</strong>
            <p>
              Verification emails are captured on this computer. They are not
              sent to your personal inbox.
            </p>
            <a
              className="text-button"
              href={delivery.inboxUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open development inbox
            </a>
          </div>
        )}
        {message && (
          <p className="notice" role="status">
            {confirmationMessage(delivery, message)}
          </p>
        )}
        <label>
          Email address
          <input
            ref={emailInput}
            type="email"
            name="email"
            autoComplete={stage === "create" ? "username" : "email"}
            autoCapitalize="none"
            spellCheck={false}
            maxLength={200}
            required
            disabled={disabled}
            aria-describedby={error ? "signup-error" : undefined}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        {stage === "create" ? (
          <>
            <label>
              Password
              <input
                type="password"
                name="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
                disabled={disabled}
                aria-describedby="password-help"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setPasswordError("");
                }}
              />
            </label>
            <p id="password-help" className="fine-print">
              Use 12–128 characters. A long, unique passphrase works well.
            </p>
            <label>
              Confirm password
              <input
                ref={confirmationInput}
                type="password"
                name="confirm-password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
                disabled={disabled}
                aria-invalid={!!passwordError}
                aria-describedby={passwordError ? "password-error" : undefined}
                value={confirmation}
                onChange={(event) => {
                  setConfirmation(event.target.value);
                  setPasswordError("");
                }}
              />
            </label>
            {passwordError && (
              <p id="password-error" className="notice error" role="alert">
                {passwordError}
              </p>
            )}
          </>
        ) : (
          <label>
            Verification code
            <input
              ref={codeInput}
              type="text"
              name="token"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6,10}"
              minLength={6}
              maxLength={10}
              required
              disabled={disabled}
              aria-describedby={error ? "signup-error code-help" : "code-help"}
              value={token}
              onChange={(event) =>
                setToken(event.target.value.replace(/\D/g, "").slice(0, 10))
              }
            />
          </label>
        )}
        {stage === "verify" && (
          <p id="code-help" className="fine-print">
            Use the most recent code from your confirmation email. This account
            is for store management.
          </p>
        )}
        {error && (
          <p id="signup-error" className="notice error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary wide" disabled={disabled}>
          {busy === "submit"
            ? stage === "create"
              ? "Creating account…"
              : "Verifying…"
            : stage === "create"
              ? "Create owner account"
              : "Verify email"}
        </button>
        {stage === "verify" ? (
          <button
            type="button"
            className="text-button centered"
            disabled={disabled || !email.trim()}
            onClick={() => void resend()}
          >
            {busy === "resend" ? "Sending code…" : "Send a new code"}
          </button>
        ) : (
          <button
            type="button"
            className="text-button centered"
            disabled={disabled}
            onClick={() => {
              setStage("verify");
              setPassword("");
              setConfirmation("");
              setError("");
              setPasswordError("");
            }}
          >
            Already have a verification code?
          </button>
        )}
        <noscript>Enable JavaScript to create your account securely.</noscript>
        <Link className="text-button centered" href="/management/login">
          Already have an account? Sign in
        </Link>
        <p className="fine-print">
          Joining an existing team? Ask your organization owner for access.
        </p>
      </form>
    </main>
  );
}
