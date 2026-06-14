use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerProbeResult {
    pub ok: bool,
    pub normalized_url: String,
    pub product: Option<String>,
    pub version: Option<String>,
    pub panel_name: Option<String>,
    pub error: Option<String>,
}

pub async fn probe_panel_url(base: &str, tls_strict: bool) -> ServerProbeResult {
    let normalized = match super::normalize_server_url(base) {
        Ok(u) => u,
        Err(e) => {
            return ServerProbeResult {
                ok: false,
                normalized_url: base.trim().to_string(),
                product: None,
                version: None,
                panel_name: None,
                error: Some(e),
            };
        }
    };

    let url = format!("{}/api/bd/server-info", normalized.trim_end_matches('/'));
    let client = match build_http_client(tls_strict) {
        Ok(c) => c,
        Err(e) => {
            return ServerProbeResult {
                ok: false,
                normalized_url: normalized,
                product: None,
                version: None,
                panel_name: None,
                error: Some(e),
            };
        }
    };

    match client.get(&url).send().await {
        Ok(resp) => {
            if !resp.status().is_success() {
                return ServerProbeResult {
                    ok: false,
                    normalized_url: normalized,
                    product: None,
                    version: None,
                    panel_name: None,
                    error: Some(format!("HTTP {}", resp.status())),
                };
            }
            match resp.json::<serde_json::Value>().await {
                Ok(body) => {
                    let ok = body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                    ServerProbeResult {
                        ok,
                        normalized_url: normalized,
                        product: body
                            .get("product")
                            .and_then(|v| v.as_str())
                            .map(String::from),
                        version: body
                            .get("version")
                            .and_then(|v| v.as_str())
                            .map(String::from),
                        panel_name: body
                            .get("panel_name")
                            .and_then(|v| v.as_str())
                            .map(String::from),
                        error: if ok {
                            None
                        } else {
                            Some("Not a BetterDesk panel".into())
                        },
                    }
                }
                Err(e) => ServerProbeResult {
                    ok: false,
                    normalized_url: normalized,
                    product: None,
                    version: None,
                    panel_name: None,
                    error: Some(format!("Invalid JSON: {e}")),
                },
            }
        }
        Err(e) => ServerProbeResult {
            ok: false,
            normalized_url: normalized,
            product: None,
            version: None,
            panel_name: None,
            error: Some(format!("Connection failed: {e}")),
        },
    }
}

fn build_http_client(tls_strict: bool) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("BetterDesk-RdClient/0.1");

    if !tls_strict {
        builder = builder.danger_accept_invalid_certs(true);
    }

    builder.build().map_err(|e| e.to_string())
}
