package main

import "testing"

func TestCDAPHealthURLHTTP(t *testing.T) {
	b := Branding{
		ServerAddress: "http://78.31.94.73:21114",
		Server: &ServerBranding{
			CDAPPort:    21122,
			ConsolePort: 5000,
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

func TestConsoleAPIURLWithPorts(t *testing.T) {
	b := Branding{
		ServerAddress: "http://host.example:21114",
		Server: &ServerBranding{
			ConsolePort: 5000,
		},
	}.normalize()
	got := b.ConsoleAPIURL("/bd/help-request")
	want := "http://host.example:5000/api/bd/help-request"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
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
