//go:build release

package main

import "testing"

func TestReleaseTransportCandidatesRejectDowngradeAndStaleEndpoints(t *testing.T) {
	brand := Branding{
		AllowedEndpoints: []string{
			"https://desk.example.test/api",
			"wss://desk.example.test:21122/cdap",
		},
		Server: &ServerBranding{
			APIURL:  "https://desk.example.test/api",
			CDAPURL: "wss://desk.example.test:21122/cdap",
		},
	}
	state := &AppState{
		LastGoodCDAP: "ws://desk.example.test:21122/cdap",
		LastGoodAPI:  "http://desk.example.test/api",
	}
	if got := CandidateCDAPWebSockets(brand, state); len(got) != 1 || got[0] != brand.Server.CDAPURL {
		t.Fatalf("CDAP candidates = %v", got)
	}
	if got := CandidateAPIBases(brand, state); len(got) != 1 || got[0] != brand.Server.APIURL {
		t.Fatalf("API candidates = %v", got)
	}
}
