package main

import (
	"fmt"
	"net/url"
	"os"
	"strings"
)

const defaultCDAPPort = 21122

// useTLS reports whether baked branding expects TLS for HTTP/WebSocket calls.
func (b Branding) useTLS() bool {
	if b.UseHTTPS {
		return true
	}
	addr := strings.TrimSpace(b.ServerAddress)
	if strings.HasPrefix(addr, "https://") || strings.HasPrefix(addr, "wss://") {
		return true
	}
	if b.Server != nil {
		s := strings.TrimSpace(b.Server.Address)
		if strings.HasPrefix(s, "https://") {
			return true
		}
	}
	return os.Getenv("BETTERDESK_CDAP_TLS") == "1"
}

func (b Branding) httpScheme() string {
	if b.useTLS() {
		return "https"
	}
	return "http"
}

func (b Branding) wsScheme() string {
	if b.useTLS() {
		return "wss"
	}
	return "ws"
}

func (b Branding) cdapPort() int {
	if b.Server != nil && b.Server.CDAPPort > 0 {
		return b.Server.CDAPPort
	}
	return defaultCDAPPort
}

func hostFromAddr(addr string) string {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return "localhost"
	}
	withScheme := addr
	if !strings.HasPrefix(addr, "http://") && !strings.HasPrefix(addr, "https://") &&
		!strings.HasPrefix(addr, "ws://") && !strings.HasPrefix(addr, "wss://") {
		withScheme = "http://" + addr
	}
	u, err := url.Parse(withScheme)
	if err == nil && u.Hostname() != "" {
		return u.Hostname()
	}
	host := strings.Split(addr, "/")[0]
	host = strings.Trim(host, "[]")
	if i := strings.LastIndex(host, ":"); i > 0 && !strings.Contains(host, "]") {
		host = host[:i]
	}
	if host == "" {
		return "localhost"
	}
	return host
}

func schemeFromAddr(addr string) string {
	addr = strings.TrimSpace(addr)
	if strings.HasPrefix(addr, "https://") || strings.HasPrefix(addr, "wss://") {
		return "https"
	}
	return "http"
}

func formatHostPort(host string, port int, tls bool) string {
	if host == "" {
		host = "localhost"
	}
	scheme := "http"
	if tls {
		scheme = "https"
	}
	if (tls && port == 443) || (!tls && port == 80) {
		return fmt.Sprintf("%s://%s", scheme, host)
	}
	return fmt.Sprintf("%s://%s:%d", scheme, host, port)
}

// CDAPHealthURL is the gateway health probe target.
func (b Branding) CDAPHealthURL() string {
	host := hostFromAddr(b.ServerAddress)
	return formatHostPort(host, b.cdapPort(), b.useTLS()) + "/cdap/health"
}

// APIHealthURL is the Go management API health probe (enrollment, devices, branding).
func (b Branding) APIHealthURL() string {
	return apiBaseURL(b) + "/health"
}

// CDAPWebSocketURL is the remote-session gateway URL passed to the engine.
func (b Branding) CDAPWebSocketURL() string {
	if b.Server != nil && strings.TrimSpace(b.Server.CDAPURL) != "" {
		return strings.TrimRight(strings.TrimSpace(b.Server.CDAPURL), "/")
	}
	host := hostFromAddr(b.ServerAddress)
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return fmt.Sprintf("%s://%s:%d/cdap", b.wsScheme(), host, b.cdapPort())
}

// apiOriginHostPort extracts host:port from the baked API address for logging.
func (b Branding) apiOriginHostPort() string {
	addr := strings.TrimSpace(b.ServerAddress)
	if addr == "" && b.Server != nil {
		addr = b.Server.Address
	}
	withScheme := addr
	if !strings.HasPrefix(addr, "http://") && !strings.HasPrefix(addr, "https://") {
		withScheme = b.httpScheme() + "://" + addr
	}
	u, err := url.Parse(withScheme)
	if err != nil || u.Host == "" {
		return addr
	}
	return u.Host
}
