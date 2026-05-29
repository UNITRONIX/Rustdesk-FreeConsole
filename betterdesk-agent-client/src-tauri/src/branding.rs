//! Branding — loads the per-deployment branding profile bundled by the
//! Console's "Generator agenta" build worker.
//!
//! The build worker writes `src-tauri/resources/branding.json` into the
//! workspace before invoking `cargo tauri build`.  Tauri bundles the file
//! as a resource; at runtime we resolve it via the AppHandle.
//!
//! Missing / unreadable branding falls back to the built-in defaults so
//! an unbranded developer build still works.

use serde::{Deserialize, Serialize};
use std::fs;
use std::sync::OnceLock;
use tauri::Manager;

/// Subset of the Console-side branding schema that the agent UI consumes.
/// Fields kept loose (`Option` / `Default`) so a partial JSON still loads.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Branding {
    #[serde(default)]
    pub product_name:  String,
    #[serde(default)]
    pub company_name:  String,
    #[serde(default)]
    pub tagline:       String,
    #[serde(default)]
    pub support_email: String,
    #[serde(default)]
    pub support_phone: String,
    #[serde(default)]
    pub contact_url:   String,
    #[serde(default)]
    pub primary_color: String,
    #[serde(default)]
    pub accent_color:  String,
    #[serde(default)]
    pub logo_data_url: String,
    #[serde(default)]
    pub default_language: String,
    #[serde(default)]
    pub server_address: String,
    #[serde(default)]
    pub server_key:     String,
    #[serde(default)]
    pub bundle_id:      String,
}

impl Branding {
    fn defaults() -> Self {
        Branding {
            product_name: "BetterDesk Agent".to_string(),
            company_name: "BetterDesk".to_string(),
            primary_color: "#2563eb".to_string(),
            accent_color:  "#0ea5e9".to_string(),
            default_language: "en".to_string(),
            ..Default::default()
        }
    }
}

static CACHED: OnceLock<Branding> = OnceLock::new();

/// Resolve + cache the branding for this process.  Safe to call any number
/// of times — only the first call hits the filesystem.
pub fn load(app: &tauri::AppHandle) -> Branding {
    if let Some(b) = CACHED.get() {
        return b.clone();
    }
    let resolved = resolve(app).unwrap_or_else(Branding::defaults);
    let _ = CACHED.set(resolved.clone());
    resolved
}

fn resolve(app: &tauri::AppHandle) -> Option<Branding> {
    // Prefer the bundled resource, but allow override via env for testing.
    if let Ok(p) = std::env::var("BETTERDESK_AGENT_BRANDING") {
        if let Ok(raw) = fs::read_to_string(&p) {
            if let Ok(b) = serde_json::from_str::<Branding>(&raw) {
                log::info!("Branding loaded from env override: {}", p);
                return Some(merge_with_defaults(b));
            }
        }
    }
    let resource_path = app
        .path()
        .resolve("resources/branding.json", tauri::path::BaseDirectory::Resource)
        .ok()?;
    let raw = fs::read_to_string(&resource_path).ok()?;
    let parsed: Branding = serde_json::from_str(&raw).ok()?;
    log::info!(
        "Branding loaded from resource: bundle_id={} product={}",
        parsed.bundle_id,
        parsed.product_name
    );
    Some(merge_with_defaults(parsed))
}

fn merge_with_defaults(mut b: Branding) -> Branding {
    let d = Branding::defaults();
    if b.product_name.is_empty()  { b.product_name  = d.product_name; }
    if b.company_name.is_empty()  { b.company_name  = d.company_name; }
    if b.primary_color.is_empty() { b.primary_color = d.primary_color; }
    if b.accent_color.is_empty()  { b.accent_color  = d.accent_color; }
    if b.default_language.is_empty() { b.default_language = d.default_language; }
    b
}
