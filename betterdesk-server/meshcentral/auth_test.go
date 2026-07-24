package meshcentral

import (
	"testing"
)

func TestCookieCodecRoundTrip(t *testing.T) {
	c, err := NewCookieCodec("test-secret-key-for-mesh-cookies")
	if err != nil {
		t.Fatal(err)
	}
	data := &RelayCookieData{
		RUserID:   "user/admin",
		NodeID:    "node@test",
		Rights:    0xFFFFFFFF,
		ExpireMin: 60,
	}
	cookie, err := c.Encode(data, 60)
	if err != nil {
		t.Fatal(err)
	}
	out, err := c.Decode(cookie, 60)
	if err != nil {
		t.Fatal(err)
	}
	if out.RUserID != data.RUserID || out.NodeID != data.NodeID {
		t.Fatalf("mismatch: %+v", out)
	}
}

func TestAgentCredentialsServerID(t *testing.T) {
	cred, err := LoadOrCreateAgentCredentials("")
	if err != nil {
		t.Fatal(err)
	}
	if len(cred.ServerID) != 96 { // hex sha384
		t.Fatalf("server id len %d", len(cred.ServerID))
	}
	if len(cred.ServerIDBin) != sha384Size {
		t.Fatalf("server id bin len %d", len(cred.ServerIDBin))
	}
}

func TestBuildCoreModulePacket(t *testing.T) {
	core := []byte("console.log('test');")
	pkt := BuildCoreModulePacket(core)
	if readU16(pkt, 0) != cmdCoreModule {
		t.Fatalf("cmd %d", readU16(pkt, 0))
	}
	if string(pkt[4:]) != string(core) {
		t.Fatal("core payload mismatch")
	}
}

func TestMeshPeerIDSanitize(t *testing.T) {
	id := meshPeerID("abc@def$ghi")
	if id == "" || len(id) < 6 {
		t.Fatalf("bad id %s", id)
	}
}
