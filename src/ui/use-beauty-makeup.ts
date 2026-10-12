"use client";

import { useCallback, useRef, useState, type RefObject } from "react";
import { api, json } from "./api";
import type { MakeupPreview } from "./beauty-book";

interface PreviewResponse {
  images: {
    id: "soft" | "fresh" | "defined";
    image_base64: string;
    mime_type: "image/jpeg";
  }[];
}

/** Session-only image references. No browser storage, persistence or automatic retries. */
export function useBeautyMakeup(session: RefObject<string | null>) {
  const [accepted, setAccepted] = useState(false);
  const [images, setImages] = useState<MakeupPreview[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const consent = useRef(false);
  const source = useRef<File | null>(null);
  const attempted = useRef(false);
  const active = useRef(false);
  const urls = useRef<string[]>([]);
  const generationEpoch = useRef(0);
  const clear = useCallback(() => {
    generationEpoch.current++;
    source.current = null;
    active.current = false;
    urls.current.forEach((url) => URL.revokeObjectURL(url));
    urls.current = [];
    setImages([]);
    setBusy(false);
    if (attempted.current)
      setStatus(
        "Your private images were cleared. This session will not send another image request.",
      );
  }, []);
  const reset = useCallback(() => {
    clear();
    consent.current = false;
    attempted.current = false;
    setAccepted(false);
    setStatus("");
  }, [clear]);
  const releaseSource = useCallback(() => {
    source.current = null;
  }, []);
  const declineLocally = useCallback(() => {
    clear();
    consent.current = false;
    setAccepted(false);
  }, [clear]);
  function keepSource(image: File) {
    source.current = consent.current ? image : null;
  }
  function stageConsent(value: boolean) {
    // Staged optional intent is not authorization for an external request.
    consent.current = false;
    setAccepted(value);
    setStatus("");
    if (!value) clear();
  }
  async function changeConsent(value: boolean, signal: AbortSignal) {
    consent.current = false;
    setAccepted(value);
    setStatus("");
    if (!value) clear();
    try {
      await api(`kiosk/sessions/${session.current}/beauty-makeup-consent`, {
        method: "POST",
        signal,
        body: json({
          accepted: value,
          noticeVersion: "2026-10-beauty-makeup-v1",
        }),
      });
      if (!signal.aborted) consent.current = value;
    } catch (cause) {
      if (!signal.aborted) {
        consent.current = false;
        setAccepted(false);
        clear();
      }
      throw cause;
    }
  }
  async function generate(signal: AbortSignal, current: () => boolean) {
    const image = source.current;
    if (!image || !consent.current || attempted.current || document.hidden)
      return;
    attempted.current = true;
    active.current = true;
    setBusy(true);
    setStatus("Creating your three makeup looks. This can take a few minutes…");
    const ownEpoch = generationEpoch.current;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = window.setTimeout(abort, 210000);
    try {
      const response = await fetch(
        `/api/v1/kiosk/sessions/${session.current}/beauty-makeup`,
        {
          method: "POST",
          body: image,
          headers: { "Content-Type": image.type },
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        },
      );
      const value = await response.json();
      if (!response.ok)
        throw new Error(
          value.error?.message ??
            "Your makeup images could not be created. This session cannot send another image request.",
        );
      const result = value as PreviewResponse;
      if (
        !Array.isArray(result.images) ||
        result.images.length !== 3 ||
        result.images.some(
          (item, index) =>
            item.id !== ["soft", "fresh", "defined"][index] ||
            item.mime_type !== "image/jpeg" ||
            typeof item.image_base64 !== "string" ||
            item.image_base64.length > 8 * 1024 * 1024,
        )
      )
        throw new Error(
          "The image previews were incomplete. No substitute portraits will be shown.",
        );
      if (
        current() &&
        generationEpoch.current === ownEpoch &&
        !controller.signal.aborted
      ) {
        const next = result.images.map((item) => {
          const bytes = Uint8Array.from(atob(item.image_base64), (char) =>
            char.charCodeAt(0),
          );
          const url = URL.createObjectURL(
            new Blob([bytes], { type: item.mime_type }),
          );
          urls.current.push(url);
          return { mood: item.id, url };
        });
        setImages(next);
        setStatus("");
      }
    } catch (cause) {
      if (current() && generationEpoch.current === ownEpoch)
        setStatus(
          controller.signal.aborted
            ? "The image request timed out. Your styling guide is ready, and this session will not resend your photo."
            : (cause as Error).message,
        );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      source.current = null;
      active.current = false;
      if (current() && generationEpoch.current === ownEpoch) setBusy(false);
    }
  }
  return {
    accepted,
    images,
    busy,
    status,
    active,
    clear,
    reset,
    releaseSource,
    declineLocally,
    keepSource,
    changeConsent,
    stageConsent,
    generate,
  };
}
