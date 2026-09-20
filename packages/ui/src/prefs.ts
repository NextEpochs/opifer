/**
 * Per-person interface preferences: view mode, theme, language, and the
 * Home board layout. The server keeps them (`/v1/preferences`) so they follow
 * the person across browsers; the browser keeps a copy so the first paint
 * never waits and the interface works offline.
 */

import { useCallback, useEffect, useState } from "react";

export type ViewMode = "simple" | "advanced";
export type Theme = "dark" | "light";
export type WidgetSize = "s" | "m" | "l";

export interface WidgetPlacement {
  id: string;
  size: WidgetSize;
}

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: preferences last for the session
  }
}

// --- server copy ---------------------------------------------------------------

type Listener = (value: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
/** The value every hook agrees on: the browser copy, then the server copy once loaded, then what was set. */
const cache = new Map<string, unknown>();
let loading: Promise<void> | null = null;
const timers = new Map<string, number>();

function current<T>(key: string, fallback: T): T {
  if (cache.has(key)) return cache.get(key) as T;
  const local = readLocal<T>(`opifer.${key}`, fallback);
  cache.set(key, local);
  return local;
}

const apiBase = (): string => new URL(".", location.href).pathname.replace(/\/$/, "");

async function loadFromServer(): Promise<void> {
  try {
    const response = await fetch(`${apiBase()}/v1/preferences`, { credentials: "same-origin" });
    if (!response.ok) return;
    const values = (await response.json()) as Record<string, unknown>;
    for (const [key, value] of Object.entries(values)) {
      cache.set(key, value);
      writeLocal(`opifer.${key}`, value);
      for (const listener of listeners.get(key) ?? []) listener(value);
    }
  } catch {
    // offline: the browser copy stands
  }
}

function saveToServer(key: string, value: unknown): void {
  const pending = timers.get(key);
  if (pending) window.clearTimeout(pending);
  timers.set(
    key,
    window.setTimeout(() => {
      timers.delete(key);
      void fetch(`${apiBase()}/v1/preferences/${encodeURIComponent(key)}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      }).catch(() => {});
    }, 400),
  );
}

/** Reads a preference (browser copy first, server copy when it arrives) and writes both. */
export function usePref<T>(key: string, fallback: T): [T, (next: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => current<T>(key, fallback));
  useEffect(() => {
    const listener: Listener = (next) => setValue(next as T);
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key)!.add(listener);
    if (!loading) loading = loadFromServer();
    else setValue(current<T>(key, fallback));
    return () => {
      listeners.get(key)?.delete(listener);
    };
    // fallback is a constant per call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback(
    (next: T | ((current: T) => T)) => {
      const resolved = typeof next === "function" ? (next as (c: T) => T)(current<T>(key, fallback)) : next;
      writeLocal(`opifer.${key}`, resolved);
      cache.set(key, resolved);
      saveToServer(key, resolved);
      for (const listener of listeners.get(key) ?? []) listener(resolved);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return [value, set];
}

/** Applies mode and theme to <html> so CSS can react. */
export function useDocumentAttributes(mode: ViewMode, theme: Theme): void {
  useEffect(() => {
    document.documentElement.dataset["mode"] = mode;
    document.documentElement.dataset["theme"] = theme;
    document.documentElement.style.colorScheme = theme;
  }, [mode, theme]);
}

export const DEFAULT_LAYOUT: WidgetPlacement[] = [
  { id: "needsYou", size: "l" },
  { id: "spend", size: "s" },
  { id: "team", size: "m" },
  { id: "done", size: "m" },
  { id: "learned", size: "m" },
  { id: "activity", size: "m" },
  { id: "costByAgent", size: "s" },
];
