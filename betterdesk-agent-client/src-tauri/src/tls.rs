//! Central TLS helpers for HTTP and WebSocket clients.

use log::warn;
use native_tls::TlsConnector as NativeTlsConnector;
use reqwest::Client;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub fn strict_tls_enabled() -> bool {
    !matches!(
        std::env::var("BETTERDESK_ALLOW_INVALID_TLS").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes") | Ok("YES")
    )
}

pub fn allow_invalid_certs() -> bool {
    !strict_tls_enabled()
}

fn warn_self_signed_once() {
    static WARNED: AtomicBool = AtomicBool::new(false);
    if !WARNED.swap(true, Ordering::SeqCst) {
        warn!(
            "TLS certificate validation is DISABLED for BetterDesk API calls. \
             BETTERDESK_ALLOW_INVALID_TLS is a development-only override; \
             use a trusted certificate or configure certificate pinning in production."
        );
    }
}

pub fn build_http_client(timeout_secs: u64) -> Result<Client, reqwest::Error> {
    let mut builder = Client::builder().timeout(Duration::from_secs(timeout_secs));
    if allow_invalid_certs() {
        warn_self_signed_once();
        builder = builder.danger_accept_invalid_certs(true);
    }
    builder.build()
}

pub fn build_http_client_no_redirect(timeout_secs: u64) -> Result<Client, reqwest::Error> {
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .redirect(reqwest::redirect::Policy::none());
    if allow_invalid_certs() {
        warn_self_signed_once();
        builder = builder.danger_accept_invalid_certs(true);
    }
    builder.build()
}

pub fn build_native_tls_connector() -> Result<NativeTlsConnector, native_tls::Error> {
    let mut builder = NativeTlsConnector::builder();
    if allow_invalid_certs() {
        warn_self_signed_once();
        builder.danger_accept_invalid_certs(true);
    }
    builder.build()
}

pub fn build_ws_connector() -> Option<tokio_tungstenite::Connector> {
    if allow_invalid_certs() {
        build_native_tls_connector()
            .ok()
            .map(tokio_tungstenite::Connector::NativeTls)
    } else {
        None
    }
}
