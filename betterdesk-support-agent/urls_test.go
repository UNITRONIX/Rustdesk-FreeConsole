package main

import "testing"

func TestAPIHealthURLHTTP(t *testing.T) {
	b := Branding{
		ServerAddress: "http://78.31.94.73:21114",
	}.normalize()
	got := b.APIHealthURL()
	want := "http://78.31.94.73:21114/api/health"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestCDAPHealthURLHTTP(t *testing.T) {
	b := Branding{
		ServerAddress: "http://78.31.94.73:21114",
		Server: &ServerBranding{
			CDAPPort: 21122,
		},
	}.normalize()
	got := b.CDAPHealthURL()
	want := "http://78.31.94.73:21122/cdap/health"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestCDAPWebSocketURLWithHTTPS(t *testing.T) {
	b := Branding{
		ServerAddress: "https://desk.example.com:21114",
		UseHTTPS:      true,
		Server: &ServerBranding{
			CDAPURL: "wss://desk.example.com:21122/cdap",
		},
	}.normalize()
	got := b.CDAPWebSocketURL()
	if got != "wss://desk.example.com:21122/cdap" {
		t.Fatalf("got %q", got)
	}
}

func TestCDAPWebSocketURLWithHTTP(t *testing.T) {
	b := Branding{
		ServerAddress: "http://192.168.0.110:5443",
		UseHTTPS:      false,
		Server: &ServerBranding{
			CDAPURL: "ws://192.168.0.110:21122/cdap",
		},
	}.normalize()
	got := b.CDAPWebSocketURL()
	if got != "ws://192.168.0.110:21122/cdap" {
		t.Fatalf("got %q", got)
	}
	if b.useTLS() {
		t.Fatal("HTTP profile must not force TLS")
	}
}

func TestHostFromAddr(t *testing.T) {
	if got := hostFromAddr("https://78.31.94.73:21114"); got != "78.31.94.73" {
		t.Fatalf("host: %q", got)
	}
	if got := hostFromAddr("78.31.94.73"); got != "78.31.94.73" {
		t.Fatalf("bare host: %q", got)
	}
}
