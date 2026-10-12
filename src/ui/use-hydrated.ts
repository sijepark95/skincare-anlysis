"use client";
import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** Auth inputs stay disabled until their submit handlers can protect credentials. */
export function useHydrated() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
