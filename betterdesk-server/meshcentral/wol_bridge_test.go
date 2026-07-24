package meshcentral

import "testing"

func TestMeshMACFromPeerConfig(t *testing.T) {
	raw := `{"action":"network","netif2":{"00:11:22:33:44:55":{"type":"wired"}}}`
	// Without DB — test JSON parser directly
	mac := macFromMeshJSON(raw)
	if mac != "00:11:22:33:44:55" {
		t.Fatalf("mac = %q", mac)
	}
}

func TestNormalizeMAC(t *testing.T) {
	if normalizeMAC("AA-BB-CC-DD-EE-FF") != "aa:bb:cc:dd:ee:ff" {
		t.Fatal("normalize dash mac failed")
	}
}
