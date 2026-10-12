"use client";

import { useCallback, useRef, useState, type RefObject } from "react";
import {
  validateBeautyPreviewResult,
  BEAUTY_PREVIEW_NOTICE_VERSION,
} from "@/domain/beauty-complete";
import type {
  PreviewStatus,
  PreviewKind,
} from "@/application/beauty-complete-contracts";
import { api, json } from "./api";
import type { StylingDirection } from "@/domain/beauty-styling";

export interface OwnBeautyPreview {
  slot: number;
  kind: PreviewKind;
  index: number;
  status: PreviewStatus;
  url?: string;
}
const emptySlots = (): OwnBeautyPreview[] =>
  Array.from({ length: 9 }, (_, slot) => ({
    slot,
    kind: slot < 3 ? "makeup" : slot < 6 ? "hair_style" : "hair_color",
    index: slot % 3,
    status: "pending",
  }));

/** Nine one-attempt edits, sequential and bounded. Pixels and results live only in this hook. */
export function useBeautyPreviews(session: RefObject<string | null>) {
  const [accepted, setAccepted] = useState(false);
  const [slots, setSlots] = useState<OwnBeautyPreview[]>(emptySlots);
  const [busy, setBusy] = useState(false);
  const consent = useRef(false);
  const source = useRef<File | null>(null);
  const attempted = useRef(false);
  const active = useRef(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const urls = useRef<string[]>([]);
  const clear = useCallback(() => {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
    source.current = null;
    active.current = false;
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    urls.current = [];
    setBusy(false);
    setSlots((items) =>
      items.map((item) => ({
        ...item,
        url: undefined,
        status: attempted.current ? "cancelled" : "pending",
      })),
    );
  }, []);
  const cancel = useCallback(() => {
    const id = session.current;
    const wasAttempted = attempted.current;
    clear();
    if (id && wasAttempted)
      void api(`kiosk/sessions/${id}/beauty-preview-cancel`, {
        method: "POST",
        body: "{}",
      }).catch(() => {});
  }, [clear, session]);
  const reset = useCallback(() => {
    clear();
    consent.current = false;
    attempted.current = false;
    setAccepted(false);
    setSlots(emptySlots());
  }, [clear]);
  const releaseSource = useCallback(() => {
    source.current = null;
  }, []);
  const stageConsent = useCallback(
    (value: boolean) => {
      consent.current = false;
      setAccepted(value);
      if (!value) clear();
    },
    [clear],
  );
  const changeConsent = useCallback(
    async (value: boolean, signal: AbortSignal) => {
      consent.current = false;
      setAccepted(value);
      if (!value) cancel();
      try {
        await api(`kiosk/sessions/${session.current}/beauty-preview-consent`, {
          method: "POST",
          signal,
          body: json({
            accepted: value,
            noticeVersion: BEAUTY_PREVIEW_NOTICE_VERSION,
          }),
        });
        if (!signal.aborted) consent.current = value;
      } catch (cause) {
        if (!signal.aborted) {
          setAccepted(false);
          clear();
        }
        throw cause;
      }
    },
    [cancel, clear, session],
  );
  const keepSource = useCallback((image: File) => {
    source.current = consent.current ? image : null;
  }, []);
  const generate = useCallback(
    async (
      signal: AbortSignal,
      current: () => boolean,
      stylingDirection: StylingDirection = "balanced",
    ) => {
      const image = source.current,
        id = session.current;
      if (
        !image ||
        !id ||
        !consent.current ||
        attempted.current ||
        signal.aborted ||
        document.hidden
      )
        return;
      attempted.current = true;
      active.current = true;
      setBusy(true);
      const ownGeneration = generation.current;
      const plan = new AbortController();
      controller.current = plan;
      const abort = () => plan.abort();
      signal.addEventListener("abort", abort, { once: true });
      const deadline = window.setTimeout(abort, 12 * 60 * 1000);
      const valid = () =>
        current() &&
        generation.current === ownGeneration &&
        !plan.signal.aborted &&
        !document.hidden;
      try {
        for (let slot = 0; slot < 9; slot++) {
          if (!valid()) break;
          setSlots((items) =>
            items.map((item) =>
              item.slot === slot ? { ...item, status: "running" } : item,
            ),
          );
          const one = new AbortController();
          const stop = () => one.abort();
          plan.signal.addEventListener("abort", stop, { once: true });
          const timeout = window.setTimeout(stop, 80000);
          try {
            const response = await fetch(
              `/api/v1/kiosk/sessions/${id}/beauty-preview/${slot}`,
              {
                method: "POST",
                body: image,
                headers: {
                  "Content-Type": image.type,
                  "X-Beauty-Styling-Direction": stylingDirection,
                },
                credentials: "same-origin",
                cache: "no-store",
                signal: one.signal,
              },
            );
            const raw: unknown = await response.json();
            const kind =
              slot < 3 ? "makeup" : slot < 6 ? "hair_style" : "hair_color";
            const result = response.ok
              ? validateBeautyPreviewResult(
                  raw,
                  undefined,
                  kind,
                  (slot % 3) as 0 | 1 | 2,
                )
              : null;
            if (!result) throw new Error("invalid_preview");
            if (valid() && !one.signal.aborted) {
              const bytes = Uint8Array.from(atob(result.image_base64), (char) =>
                char.charCodeAt(0),
              );
              const url = URL.createObjectURL(
                new Blob([bytes], { type: "image/jpeg" }),
              );
              bytes.fill(0);
              urls.current.push(url);
              setSlots((items) =>
                items.map((item) =>
                  item.slot === slot
                    ? { ...item, status: "complete", url }
                    : item,
                ),
              );
            }
          } catch {
            if (valid())
              setSlots((items) =>
                items.map((item) =>
                  item.slot === slot ? { ...item, status: "failed" } : item,
                ),
              );
          } finally {
            clearTimeout(timeout);
            plan.signal.removeEventListener("abort", stop);
          }
        }
      } finally {
        clearTimeout(deadline);
        signal.removeEventListener("abort", abort);
        source.current = null;
        if (ownGeneration === generation.current) {
          active.current = false;
          setBusy(false);
          controller.current = null;
          setSlots((items) =>
            items.map((item) =>
              item.status === "running" || item.status === "pending"
                ? { ...item, status: "cancelled" }
                : item,
            ),
          );
          if (plan.signal.aborted)
            void api(`kiosk/sessions/${id}/beauty-preview-cancel`, {
              method: "POST",
              body: "{}",
            }).catch(() => {});
        }
      }
    },
    [session],
  );
  return {
    accepted,
    slots,
    busy,
    active,
    clear,
    cancel,
    reset,
    releaseSource,
    stageConsent,
    changeConsent,
    keepSource,
    generate,
  };
}
