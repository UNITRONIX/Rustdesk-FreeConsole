use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::time::Duration;

const DISCOVERY_PORT: u16 = 21119;
const PROBE: &str = r#"{"type":"betterdesk-discover","version":1}"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredServer {
    pub name: String,
    pub url: String,
    pub source: String,
}

#[derive(Debug, Deserialize)]
struct Announcement {
    #[serde(rename = "type")]
    kind: String,
    server: Option<AnnounceServer>,
}

#[derive(Debug, Deserialize)]
struct AnnounceServer {
    name: Option<String>,
    version: Option<String>,
    port: Option<u16>,
    #[serde(rename = "apiPort")]
    api_port: Option<u16>,
    protocol: Option<String>,
    addresses: Option<Vec<String>>,
    #[serde(rename = "panelUrl")]
    panel_url: Option<String>,
}

/// UDP LAN discovery using the existing BetterDesk console protocol.
pub fn discover_udp(timeout_ms: u64) -> Vec<DiscoveredServer> {
    let socket = match UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let _ = socket.set_broadcast(true);
    let _ = socket.set_read_timeout(Some(Duration::from_millis(timeout_ms.max(500))));

    let probe = PROBE.as_bytes();
    let broadcast = SocketAddr::new(Ipv4Addr::BROADCAST.into(), DISCOVERY_PORT);
    let _ = socket.send_to(probe, broadcast);

    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);

    while std::time::Instant::now() < deadline {
        match socket.recv_from(&mut buf) {
            Ok((len, _addr)) => {
                if let Ok(text) = std::str::from_utf8(&buf[..len]) {
                    if let Ok(parsed) = serde_json::from_str::<Announcement>(text) {
                        if parsed.kind == "betterdesk-announce" {
                            if let Some(server) = parsed.server {
                                if let Some(entry) = server_to_discovered(&server) {
                                    if !out.iter().any(|x: &DiscoveredServer| x.url == entry.url) {
                                        out.push(entry);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(_) => break,
        }
    }

    out
}

fn server_to_discovered(server: &AnnounceServer) -> Option<DiscoveredServer> {
    if let Some(url) = server.panel_url.as_ref().filter(|u| !u.is_empty()) {
        return Some(DiscoveredServer {
            name: server.name.clone().unwrap_or_else(|| url.clone()),
            url: url.trim_end_matches('/').to_string(),
            source: "udp".into(),
        });
    }

    let protocol = server.protocol.as_deref().unwrap_or("https");
    let port = server.port.or(server.api_port)?;
    let addr = server.addresses.as_ref()?.first()?.clone();
    let url = format!("{protocol}://{addr}:{port}");
    Some(DiscoveredServer {
        name: server.name.clone().unwrap_or_else(|| addr.clone()),
        url,
        source: "udp".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_panel_url_from_announcement() {
        let server = AnnounceServer {
            name: Some("Test".into()),
            version: None,
            port: Some(5443),
            api_port: None,
            protocol: Some("https".into()),
            addresses: Some(vec!["192.168.1.10".into()]),
            panel_url: Some("https://desk.local:5443".into()),
        };
        let d = server_to_discovered(&server).unwrap();
        assert_eq!(d.url, "https://desk.local:5443");
    }
}
