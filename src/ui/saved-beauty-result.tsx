"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Printer, Trash2 } from "lucide-react";
import type { SavedBeautyResult } from "@/application/beauty-consultations";
import type {
  CompleteSavedGuide,
  BeautyLocale,
} from "@/application/beauty-complete-contracts";
import {
  CompleteSavedGuideView,
  downloadCompleteGuide,
} from "./complete-beauty-book";
import { bt, type BeautyTextKey } from "./beauty-i18n";
import { api, json } from "./api";
import { Brand } from "./brand";
import { BeautyBook, downloadBeautyGuide } from "./beauty-book";
import "./beauty-kiosk.css";

export function SavedBeautyResultView() {
  const [result, setResult] = useState<
    SavedBeautyResult | CompleteSavedGuide | null
  >(null);
  const [locale, setLocale] = useState<BeautyLocale>("en");
  const complete = result && "version" in result ? result : null;
  const legacy = result && !("version" in result) ? result : null;
  const [status, setStatus] = useState<BeautyTextKey | null>("savedOpening");
  const [error, setError] = useState<BeautyTextKey | null>(null);
  const [busy, setBusy] = useState(false);
  const token = useRef("");
  const parsed = useRef(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    function read() {
      // Strip each incoming bearer fragment before any API call, including same-page links.
      if (!parsed.current || window.location.hash) {
        const fragment = window.location.hash.slice(1);
        window.history.replaceState(null, "", window.location.pathname);
        token.current = fragment.startsWith("token=")
          ? fragment.slice(6)
          : fragment;
        parsed.current = true;
      }
      request.current?.abort();
      clearTimeout(timer);
      const value = token.current;
      const controller = new AbortController();
      request.current = controller;
      const valid = /^[A-Za-z0-9_-]{32,256}$/.test(value);
      timer = window.setTimeout(() => {
        if (controller.signal.aborted) return;
        setResult(null);
        setBusy(false);
        setError(valid ? null : "savedMissing");
        setStatus(valid ? "savedOpening" : null);
      }, 0);
      if (!valid) return;
      void api<SavedBeautyResult | CompleteSavedGuide>("shared-results/read", {
        method: "POST",
        body: json({ token: value }),
        signal: controller.signal,
      })
        .then((saved) => {
          if (controller.signal.aborted) return;
          clearTimeout(timer);
          setResult(saved);
          if ("version" in saved) setLocale(saved.locale);
          setError(null);
          setStatus(null);
          setBusy(false);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          clearTimeout(timer);
          setResult(null);
          setError("savedUnavailable");
          setStatus(null);
          setBusy(false);
        });
    }
    read();
    const changed = () => {
      if (window.location.hash) read();
    };
    window.addEventListener("hashchange", changed);
    // Replayed effects keep this mount's token in memory; a real unmount releases the ref.
    return () => {
      clearTimeout(timer);
      request.current?.abort();
      window.removeEventListener("hashchange", changed);
    };
  }, []);
  return (
    <main className="beauty-shell beauty-saved" lang={locale}>
      <header className="beauty-header">
        <Brand />
        <span>
          {complete ? bt(locale, "reportTitle") : "Your saved beauty guide"}
        </span>
        <label>
          <span className="sr-only">Language / 언어 / Idioma</span>
          <select
            aria-label="Language / 언어 / Idioma"
            value={locale}
            onChange={(event) => setLocale(event.target.value as BeautyLocale)}
          >
            <option value="en">English</option>
            <option value="ko">한국어</option>
            <option value="es">Español</option>
          </select>
        </label>
      </header>
      <section className="beauty-saved-intro">
        <span className="beauty-eyebrow">YOURS TO EXPLORE</span>
        {result ? (
          <>
            {complete ? (
              <p>
                {bt(locale, "saveNotice")}{" "}
                {bt(locale, "expires", {
                  date: new Date(complete.expiresAt).toLocaleString(locale),
                })}
              </p>
            ) : (
              <p>
                This private guide contains confirmed style choices and
                registered shade references, with no photo or AI observations.
                It expires {new Date(result.expiresAt).toLocaleString()}.
              </p>
            )}
            <div className="beauty-saved-actions">
              <button
                className="button secondary"
                onClick={() =>
                  complete
                    ? downloadCompleteGuide(complete, locale)
                    : legacy && downloadBeautyGuide(legacy)
                }
              >
                <Download size={17} />
                {complete ? bt(locale, "download") : "Download guide"}
              </button>
              <button
                className="button secondary"
                onClick={() => window.print()}
              >
                <Printer size={17} />
                {complete ? bt(locale, "print") : "Print / save PDF"}
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={async () => {
                  if (!token.current || busy) return;
                  setBusy(true);
                  setError(null);
                  const controller = new AbortController();
                  request.current = controller;
                  try {
                    await api(
                      complete
                        ? "shared-results/complete-revoke"
                        : "shared-results/revoke",
                      {
                        method: "POST",
                        body: json({ token: token.current }),
                        signal: controller.signal,
                      },
                    );
                    if (!controller.signal.aborted) {
                      token.current = "";
                      setResult(null);
                      setStatus("savedDeleted");
                    }
                  } catch {
                    if (!controller.signal.aborted)
                      setError("savedDeleteError");
                  } finally {
                    if (!controller.signal.aborted) setBusy(false);
                  }
                }}
              >
                <Trash2 size={17} />
                {complete ? bt(locale, "delete") : "Delete saved guide"}
              </button>
            </div>
          </>
        ) : (
          <h1>{bt(locale, "reportTitle")}</h1>
        )}
        {status && <p role="status">{bt(locale, status)}</p>}
        {error && (
          <p className="notice error" role="alert">
            {bt(locale, error)}
          </p>
        )}
      </section>
      {complete && <CompleteSavedGuideView saved={complete} locale={locale} />}
      {legacy && (
        <BeautyBook
          guide={legacy.guide}
          recommendations={[]}
          saved
          savedProducts={legacy.products}
        />
      )}
      <footer className="beauty-footer">{bt(locale, "savedFooter")}</footer>
    </main>
  );
}
