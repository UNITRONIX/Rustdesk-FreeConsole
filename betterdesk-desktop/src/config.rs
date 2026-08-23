use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("server URL is empty")]
    EmptyUrl,
    #[error("server URL must use http or https")]
    InsecureUrl,
    #[error("server URL is invalid: {0}")]
    InvalidUrl(String),
    #[error("server URL must not contain credentials")]
    UrlCredentials,
    #[error("server public key is invalid")]
    InvalidPublicKey,
    #[error("deploy string is not valid base64 JSON")]
    InvalidDeployString,
    #[error("deploy configuration is missing host")]
    MissingHost,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServerConfig {
    pub id_server: String,
    #[serde(default)]
    pub relay_server: String,
    #[serde(default)]
    pub api_url: String,
    #[serde(default)]
    pub server_key: String,
    #[serde(default)]
    pub allow_untrusted_tls: bool,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            id_server: String::new(),
            relay_server: String::new(),
            api_url: String::new(),
            server_key: String::new(),
            allow_untrusted_tls: false,
        }
    }
}

impl ServerConfig {
    pub fn validate(&self) -> Result<(), ConfigError> {
        validate_host_endpoint(&self.id_server)?;
        if !self.relay_server.trim().is_empty() {
            validate_host_endpoint(&self.relay_server)?;
        }
        if !self.api_url.trim().is_empty() {
            validate_panel_url(&self.api_url)?;
        }
        if !self.server_key.trim().is_empty() {
            decode_public_key(&self.server_key)?;
        }
        Ok(())
    }

    pub fn from_deploy_string(value: &str) -> Result<Self, ConfigError> {
        let value = value.trim();
        let decoded = STANDARD
            .decode(value.chars().rev().collect::<String>())
            .or_else(|_| {
                let mut reversed = value.chars().rev().collect::<String>();
                while reversed.len() % 4 != 0 {
                    reversed.push('=');
                }
                STANDARD.decode(reversed)
            })
            .map_err(|_| ConfigError::InvalidDeployString)?;
        let json: DeployPayload =
            serde_json::from_slice(&decoded).map_err(|_| ConfigError::InvalidDeployString)?;
        let config = Self {
            id_server: json.host.ok_or(ConfigError::MissingHost)?,
            relay_server: json.relay.unwrap_or_default(),
            api_url: json.api.unwrap_or_default(),
            server_key: json.key.unwrap_or_default(),
            allow_untrusted_tls: false,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn to_deploy_string(&self) -> Result<String, ConfigError> {
        self.validate()?;
        let payload = DeployPayload {
            host: Some(self.id_server.clone()),
            relay: (!self.relay_server.is_empty()).then(|| self.relay_server.clone()),
            api: (!self.api_url.is_empty()).then(|| self.api_url.clone()),
            key: (!self.server_key.is_empty()).then(|| self.server_key.clone()),
        };
        let json = serde_json::to_vec(&payload).map_err(|_| ConfigError::InvalidDeployString)?;
        let encoded = STANDARD.encode(json);
        Ok(encoded.trim_end_matches('=').chars().rev().collect())
    }

    pub fn websocket_url(&self, path: &str) -> Result<Url, ConfigError> {
        let panel = if !self.api_url.trim().is_empty() {
            self.api_url.trim()
        } else {
            &self.id_server
        };
        let mut url = parse_endpoint_url(panel)?;
        let scheme = match url.scheme() {
            "https" => "wss",
            "http" => "ws",
            "ws" | "wss" => url.scheme(),
            _ => return Err(ConfigError::InvalidUrl(panel.to_string())),
        }
        .to_owned();
        url.set_scheme(&scheme)
            .map_err(|_| ConfigError::InvalidUrl(panel.to_string()))?;
        url.set_path(path);
        url.set_query(None);
        url.set_fragment(None);
        Ok(url)
    }

    /// Build the RustDesk-compatible WebSocket signal endpoint.
    ///
    /// BetterDesk exposes native signal/relay WebSockets on ports 21118/21119.
    /// When the ID host is also a public HTTPS host without an explicit port,
    /// use the reverse-proxy paths instead.
    pub fn rustdesk_signal_url(&self) -> Result<Url, ConfigError> {
        websocket_host_url(&self.id_server, &self.api_url, 21118, "/ws/id")
    }

    /// Build the RustDesk-compatible WebSocket relay endpoint.
    pub fn rustdesk_relay_url(&self) -> Result<Url, ConfigError> {
        let source = if self.relay_server.trim().is_empty() {
            &self.id_server
        } else {
            &self.relay_server
        };
        websocket_host_url(source, &self.api_url, 21119, "/ws/relay")
    }

    /// Build the native BetterDesk CDAP WebSocket endpoint.
    pub fn cdap_url(&self) -> Result<Url, ConfigError> {
        let source = if self.api_url.trim().is_empty() {
            &self.id_server
        } else {
            &self.api_url
        };
        let mut url = parse_endpoint_url(source)?;
        let scheme = match url.scheme() {
            "https" => "wss",
            "http" => "ws",
            "ws" | "wss" => url.scheme(),
            _ => return Err(ConfigError::InvalidUrl(source.to_owned())),
        }
        .to_owned();
        url.set_scheme(&scheme)
            .map_err(|_| ConfigError::InvalidUrl(source.to_owned()))?;
        if matches!(url.port(), Some(21114 | 21121)) {
            url.set_port(Some(21122))
                .map_err(|_| ConfigError::InvalidUrl(source.to_owned()))?;
        } else if url.port().is_none() && self.api_url.trim().is_empty() {
            url.set_port(Some(21122))
                .map_err(|_| ConfigError::InvalidUrl(source.to_owned()))?;
        }
        url.set_path("/cdap");
        url.set_query(None);
        url.set_fragment(None);
        Ok(url)
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct DeployPayload {
    host: Option<String>,
    relay: Option<String>,
    api: Option<String>,
    key: Option<String>,
}

pub fn validate_panel_url(value: &str) -> Result<(), ConfigError> {
    if value.trim().is_empty() {
        return Err(ConfigError::EmptyUrl);
    }
    let parsed = parse_endpoint_url(value)?;
    if parsed.username() != "" || parsed.password().is_some() {
        return Err(ConfigError::UrlCredentials);
    }
    match parsed.scheme() {
        "https" | "wss" | "http" | "ws" => Ok(()),
        _ => Err(ConfigError::InsecureUrl),
    }
}

fn validate_host_endpoint(value: &str) -> Result<(), ConfigError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(ConfigError::EmptyUrl);
    }
    if value.contains('/') || value.contains('@') {
        return Err(ConfigError::InvalidUrl(value.to_string()));
    }
    let candidate = format!("https://{value}");
    let parsed = Url::parse(&candidate).map_err(|_| ConfigError::InvalidUrl(value.to_string()))?;
    if parsed.host_str().is_none() || parsed.username() != "" || parsed.password().is_some() {
        return Err(ConfigError::InvalidUrl(value.to_string()));
    }
    Ok(())
}

fn parse_endpoint_url(value: &str) -> Result<Url, ConfigError> {
    let value = value.trim();
    let candidate = if value.contains("://") {
        value.to_owned()
    } else {
        format!("https://{value}")
    };
    Url::parse(&candidate).map_err(|error| ConfigError::InvalidUrl(error.to_string()))
}

fn websocket_host_url(
    host_value: &str,
    scheme_source: &str,
    default_port: u16,
    path: &str,
) -> Result<Url, ConfigError> {
    let mut url = parse_endpoint_url(host_value)?;
    let source_url = if scheme_source.trim().is_empty() {
        None
    } else {
        Some(parse_endpoint_url(scheme_source)?)
    };
    let scheme = match source_url.as_ref().map(Url::scheme) {
        Some("https" | "wss") => "wss",
        Some("http" | "ws") => "ws",
        _ => "ws",
    };
    url.set_scheme(scheme)
        .map_err(|_| ConfigError::InvalidUrl(host_value.to_owned()))?;
    let use_reverse_proxy = source_url.as_ref().is_some_and(|source| {
        url.port().is_none()
            && source.port().is_none()
            && source.host_str() == url.host_str()
            && matches!(source.scheme(), "http" | "https")
    });
    if use_reverse_proxy {
        url.set_port(None)
            .map_err(|_| ConfigError::InvalidUrl(host_value.to_owned()))?;
        url.set_path(path);
        url.set_query(None);
        url.set_fragment(None);
        return Ok(url);
    }
    let port = match url.port() {
        Some(21116) if default_port == 21118 => 21118,
        Some(21116) if default_port == 21119 => 21119,
        Some(21117) if default_port == 21119 => 21119,
        Some(value) => value,
        None => default_port,
    };
    url.set_port(Some(port))
        .map_err(|_| ConfigError::InvalidUrl(host_value.to_owned()))?;
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

pub fn decode_public_key(value: &str) -> Result<Vec<u8>, ConfigError> {
    let value = value.trim();
    let hex_value = value.strip_prefix("0x").unwrap_or(value);
    if hex_value.len() == 64
        && hex_value
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        let bytes = hex::decode(hex_value).map_err(|_| ConfigError::InvalidPublicKey)?;
        if bytes.len() == 32 {
            return Ok(bytes);
        }
    }
    let bytes = STANDARD
        .decode(value)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(value))
        .map_err(|_| ConfigError::InvalidPublicKey)?;
    if bytes.len() != 32 {
        return Err(ConfigError::InvalidPublicKey);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deploy_string_round_trips() {
        let config = ServerConfig {
            id_server: "desk.example.test:21116".into(),
            relay_server: "desk.example.test:21117".into(),
            api_url: "https://desk.example.test:21114".into(),
            server_key: STANDARD.encode([7_u8; 32]),
            allow_untrusted_tls: false,
        };
        let encoded = config.to_deploy_string().unwrap();
        assert_eq!(ServerConfig::from_deploy_string(&encoded).unwrap(), config);
    }

    #[test]
    fn explicit_http_is_accepted_for_automatic_transport() {
        assert!(validate_panel_url("http://127.0.0.1:5000").is_ok());
        assert!(validate_panel_url("http://example.test").is_ok());
    }

    #[test]
    fn direct_signal_uses_plain_ws_when_api_is_plain_http() {
        let config = ServerConfig {
            id_server: "desk.example.test:21116".into(),
            api_url: "http://desk.example.test:21114".into(),
            ..Default::default()
        };
        let url = config.rustdesk_signal_url().unwrap();
        assert_eq!(url.scheme(), "ws");
        assert_eq!(url.port(), Some(21118));
        assert_eq!(url.path(), "/");
    }

    #[test]
    fn public_https_host_uses_reverse_proxy_signal_path() {
        let config = ServerConfig {
            id_server: "desk.example.test".into(),
            api_url: "https://desk.example.test".into(),
            ..Default::default()
        };
        let signal = config.rustdesk_signal_url().unwrap();
        let relay = config.rustdesk_relay_url().unwrap();
        assert_eq!(signal.as_str(), "wss://desk.example.test/ws/id");
        assert_eq!(relay.as_str(), "wss://desk.example.test/ws/relay");
    }

    #[test]
    fn native_endpoints_use_betterdesk_service_ports() {
        let config = ServerConfig {
            id_server: "desk.example.test:21116".into(),
            relay_server: "desk.example.test:21117".into(),
            api_url: "http://desk.example.test:21114".into(),
            server_key: String::new(),
            allow_untrusted_tls: false,
        };
        assert_eq!(config.rustdesk_signal_url().unwrap().port(), Some(21118));
        assert_eq!(config.rustdesk_relay_url().unwrap().port(), Some(21119));
        assert_eq!(config.rustdesk_signal_url().unwrap().scheme(), "ws");
        assert_eq!(config.cdap_url().unwrap().port(), Some(21122));
    }

    #[test]
    fn reverse_proxy_cdap_keeps_public_https_port() {
        let config = ServerConfig {
            id_server: "desk.example.test:21116".into(),
            api_url: "https://desk.example.test".into(),
            ..Default::default()
        };
        let url = config.cdap_url().unwrap();
        assert_eq!(url.scheme(), "wss");
        assert_eq!(url.port(), None);
        assert_eq!(url.path(), "/cdap");
    }

    #[test]
    fn credentials_in_url_are_rejected() {
        assert!(validate_panel_url("https://user:pass@example.test").is_err());
    }

    #[test]
    fn public_key_hex_is_supported() {
        assert_eq!(
            decode_public_key(&format!("0x{}", "ab".repeat(32))).unwrap(),
            vec![0xab; 32]
        );
    }
}
