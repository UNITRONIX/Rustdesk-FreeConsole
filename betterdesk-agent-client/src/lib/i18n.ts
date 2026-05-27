// Frontend i18n module for BetterDesk Agent Client.
//
// Loads JSON locale files eagerly at build time (Vite glob import) and
// exposes a small synchronous translation helper that components can call
// during render without awaiting promises.

import en from "../locales/en.json";
import pl from "../locales/pl.json";
import zhTW from "../locales/zh-TW.json";

type Bundle = Record<string, unknown>;

const BUNDLES: Record<string, Bundle> = {
  en: en as Bundle,
  pl: pl as Bundle,
  "zh-TW": zhTW as Bundle,
};

const DISPLAY_NAMES: Record<string, string> = {
  en: "English",
  pl: "Polski",
  "zh-TW": "繁體中文",
};

const STORAGE_KEY = "betterdesk-agent-locale";
const DEFAULT_LOCALE = "en";

let currentLocale: string = DEFAULT_LOCALE;
const listeners = new Set<(locale: string) => void>();

function detectInitialLocale(): string {
  if (typeof window === "undefined") {
    return DEFAULT_LOCALE;
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && BUNDLES[stored]) {
      return stored;
    }
  } catch {
    // localStorage may be unavailable (private mode, etc.) — fall through.
  }
  const nav = (window.navigator?.language || "").toLowerCase();
  if (nav.startsWith("pl")) return "pl";
  if (nav.startsWith("zh")) return "zh-TW";
  return DEFAULT_LOCALE;
}

function resolveKey(bundle: Bundle, key: string): string | undefined {
  const parts = key.split(".");
  let node: unknown = bundle;
  for (const part of parts) {
    if (node && typeof node === "object" && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof node === "string" ? node : undefined;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/** Initialize the i18n system. Safe to call multiple times. */
export function initI18n(): void {
  currentLocale = detectInitialLocale();
}

/** Translate a dot-separated key. Falls back to English, then to the key itself. */
export function t(key: string, params?: Record<string, string | number>): string {
  const bundle = BUNDLES[currentLocale] ?? BUNDLES[DEFAULT_LOCALE];
  const direct = resolveKey(bundle, key);
  if (direct !== undefined) return interpolate(direct, params);
  const fallback = resolveKey(BUNDLES[DEFAULT_LOCALE], key);
  if (fallback !== undefined) return interpolate(fallback, params);
  return key;
}

/** Change the active locale. Persists to localStorage and notifies listeners. */
export function setLocale(code: string): void {
  if (!BUNDLES[code]) return;
  if (code === currentLocale) return;
  currentLocale = code;
  try {
    window.localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // ignore
  }
  for (const cb of listeners) cb(code);
}

export function getLocale(): string {
  return currentLocale;
}

export function getAvailableLocales(): string[] {
  return Object.keys(BUNDLES);
}

export function getLocaleDisplayName(code: string): string {
  return DISPLAY_NAMES[code] ?? code;
}

/** Subscribe to locale changes. Returns an unsubscribe handle. */
export function onLocaleChange(cb: (locale: string) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
