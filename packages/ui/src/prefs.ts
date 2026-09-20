/**
 * Per-person interface preferences: view mode, theme, and the Home board
 * layout. Kept in the browser for now; a server-side copy arrives with
 * user accounts (authenticated mode).
 */

import { useCallback, useEffect, useState } from "react";

export type ViewMode = "simple" | "advanced";
export type Theme = "dark" | "light";
export type WidgetSize = "s" | "m" | "l";

export interface WidgetPlacement {
  id: string;
  size: WidgetSize;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: preferences last for the session
  }
}

export function usePref<T>(key: string, fallback: T): [T, (next: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => read(`opifer.${key}`, fallback));
  const set = useCallback(
    (next: T | ((current: T) => T)) => {
      setValue((current) => {
        const resolved = typeof next === "function" ? (next as (c: T) => T)(current) : next;
        write(`opifer.${key}`, resolved);
        return resolved;
      });
    },
    [key],
  );
  return [value, set];
}

/** Applies mode and theme to <html> so CSS can react. */
export function useDocumentAttributes(mode: ViewMode, theme: Theme): void {
  useEffect(() => {
    document.documentElement.dataset["mode"] = mode;
    document.documentElement.dataset["theme"] = theme;
  }, [mode, theme]);
}

export const DEFAULT_LAYOUT: WidgetPlacement[] = [
  { id: "needsYou", size: "l" },
  { id: "spend", size: "s" },
  { id: "team", size: "m" },
  { id: "done", size: "m" },
  { id: "activity", size: "l" },
  { id: "costByAgent", size: "s" },
];
