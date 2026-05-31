// Branding — fetches the per-deployment branding profile from the Rust backend
// (`get_branding` IPC) and applies it to the document: CSS custom properties for
// the theme colors, the product name as the document title, and the favicon/logo
// when supplied.
//
// The Console's "Agent generator" build worker writes `resources/branding.json`
// into the bundle before compilation; the Rust side resolves it and exposes the
// parsed struct here. Missing branding falls back to built-in BetterDesk values
// so an unbranded developer build still renders correctly.

import { invoke } from "@tauri-apps/api/core";
import { frontendLog } from "./logger";

export interface Branding {
  product_name: string;
  company_name: string;
  tagline: string;
  support_email: string;
  support_phone: string;
  contact_url: string;
  primary_color: string;
  accent_color: string;
  logo_data_url: string;
  default_language: string;
  server_address: string;
  server_key: string;
  bundle_id: string;
}

const DEFAULT_BRANDING: Branding = {
  product_name: "BetterDesk Agent",
  company_name: "BetterDesk",
  tagline: "",
  support_email: "",
  support_phone: "",
  contact_url: "",
  primary_color: "#2563eb",
  accent_color: "#0ea5e9",
  logo_data_url: "",
  default_language: "en",
  server_address: "",
  server_key: "",
  bundle_id: "",
};

let cached: Branding = DEFAULT_BRANDING;

/** Returns the most recently loaded branding (defaults before `loadBranding`). */
export function getBranding(): Branding {
  return cached;
}

/**
 * Loads branding from the backend and applies it to the document. Safe to call
 * once during boot; failures fall back to the built-in defaults.
 */
export async function loadBranding(): Promise<Branding> {
  try {
    const branding = await invoke<Branding>("get_branding");
    cached = { ...DEFAULT_BRANDING, ...branding };
    applyBranding(cached);
    frontendLog("info", "app.branding", "Branding applied", {
      bundle_id: cached.bundle_id,
      product_name: cached.product_name,
    });
  } catch (error) {
    frontendLog("warn", "app.branding", "Failed to load branding, using defaults", error);
    cached = DEFAULT_BRANDING;
    applyBranding(cached);
  }
  return cached;
}

/** Converts a `#rrggbb` hex string to `rgba(r, g, b, alpha)`. */
function hexToRgba(hex: string, alpha: number): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) {
    return null;
  }
  const int = parseInt(match[1], 16);
  const r = (int >> 16) & 0xff;
  const g = (int >> 8) & 0xff;
  const b = int & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Applies branding to CSS custom properties, document title and favicon. */
export function applyBranding(branding: Branding): void {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;

  // The agent UI is accent-driven: `--accent` is the primary action color.
  // Map the deployment's primary color onto it and derive the hover/bg shades.
  if (branding.primary_color) {
    root.style.setProperty("--bd-primary", branding.primary_color);
    root.style.setProperty("--accent", branding.primary_color);
    const bg = hexToRgba(branding.primary_color, 0.12);
    if (bg) {
      root.style.setProperty("--accent-bg", bg);
    }
  }
  if (branding.accent_color) {
    root.style.setProperty("--bd-accent", branding.accent_color);
    // Use the secondary color as the hover shade so both brand colors show.
    root.style.setProperty("--accent-hover", branding.accent_color);
  }

  if (branding.product_name) {
    document.title = branding.product_name;
  }

  if (branding.logo_data_url) {
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = branding.logo_data_url;
  }
}
