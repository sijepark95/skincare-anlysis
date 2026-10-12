"use client";
import { useCallback, useRef, useState } from "react";
import type { FaceRatios } from "@/domain/face-ratios";

export function useFaceRatios() {
  const [result, setResult] = useState<FaceRatios | null>(null);
  const worker = useRef<Worker | null>(null);
  const epoch = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useCallback(() => {
    epoch.current++;
    worker.current?.terminate();
    worker.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setResult(null);
  }, []);
  async function measure(photo: Blob) {
    clear();
    const current = epoch.current;
    let original: ImageBitmap | null = null;
    let pending: ImageBitmap | null = null;
    try {
      const source = await createImageBitmap(photo);
      original = source;
      const scale = Math.min(1, 1024 / Math.max(source.width, source.height));
      const bitmap = await createImageBitmap(source, {
        resizeWidth: Math.round(source.width * scale),
        resizeHeight: Math.round(source.height * scale),
      });
      pending = bitmap;
      source.close();
      original = null;
      if (current !== epoch.current) {
        bitmap.close();
        pending = null;
        return;
      }
      const task = new Worker(
        new URL("../infrastructure/face-ratios.worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.current = task;
      const done = (value: FaceRatios) => {
        if (current !== epoch.current) return;
        if (timer.current) clearTimeout(timer.current);
        task.terminate();
        worker.current = null;
        setResult(value);
      };
      task.onmessage = (event: MessageEvent<FaceRatios>) => done(event.data);
      task.onerror = () =>
        done({ status: "unavailable", reason: "unavailable" });
      timer.current = setTimeout(
        () => done({ status: "unavailable", reason: "unavailable" }),
        15000,
      );
      task.postMessage({ bitmap, origin: window.location.origin }, [bitmap]);
      pending = null;
    } catch {
      if (current === epoch.current)
        setResult({ status: "unavailable", reason: "unavailable" });
    } finally {
      original?.close();
      pending?.close();
    }
  }
  return { result, clear, measure };
}
