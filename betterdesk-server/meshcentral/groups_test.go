package meshcentral

import (
	"strings"
	"testing"
)

func TestNewMeshIDHexLength(t *testing.T) {
	id, err := NewMeshIDHex()
	if err != nil {
		t.Fatal(err)
	}
	if len(id) != 96 {
		t.Fatalf("mesh id len %d, want 96", len(id))
	}
	if !IsValidMeshIDHex(id) {
		t.Fatalf("generated id not valid: %s", id)
	}
	if IsValidMeshIDHex("EDBE1BE377EFC5B6D11DE0D50FED96017ADFAD0") {
		t.Fatal("legacy 40-char placeholder must not be valid")
	}
}

func TestEnsureGroupMeshIDsStable(t *testing.T) {
	gw, _ := newTestGateway(t)
	g1 := gw.ListGroups()
	if len(g1) != 1 || g1[0].ID != "default" {
		t.Fatalf("expected default group, got %+v", g1)
	}
	if !IsValidMeshIDHex(g1[0].MeshID) || len(NormalizeMeshIDHex(g1[0].MeshID)) != 96 {
		t.Fatalf("default mesh_id invalid: %q", g1[0].MeshID)
	}
	first := g1[0].MeshID
	g2 := gw.ListGroups()
	if g2[0].MeshID != first {
		t.Fatalf("mesh_id rotated on second list: %q vs %q", first, g2[0].MeshID)
	}
}

func TestEnsureGroupMeshIDsMigratesLegacy(t *testing.T) {
	gw, _ := newTestGateway(t)
	if err := gw.persistGroups([]MeshGroup{{ID: "lab", Name: "Lab"}}); err != nil {
		t.Fatal(err)
	}
	groups := gw.ListGroups()
	if len(groups) != 1 || groups[0].ID != "lab" {
		t.Fatalf("unexpected groups: %+v", groups)
	}
	if !IsValidMeshIDHex(groups[0].MeshID) {
		t.Fatalf("migrated mesh_id invalid: %q", groups[0].MeshID)
	}
	again := gw.ListGroups()
	if again[0].MeshID != groups[0].MeshID {
		t.Fatalf("migrated mesh_id not stable: %q vs %q", groups[0].MeshID, again[0].MeshID)
	}
}

func TestResolveMeshIDHexRejectsLegacyPlaceholder(t *testing.T) {
	gw, _ := newTestGateway(t)
	got := gw.ResolveMeshIDHex("EDBE1BE377EFC5B6D11DE0D50FED96017ADFAD0")
	if !IsValidMeshIDHex(got) || len(got) != 96 {
		t.Fatalf("ResolveMeshIDHex fallback invalid: %q", got)
	}
	if strings.EqualFold(got, "EDBE1BE377EFC5B6D11DE0D50FED96017ADFAD0") {
		t.Fatal("legacy placeholder accepted as MeshID")
	}
}

func TestBuildMSHMeshIDLength(t *testing.T) {
	gw, _ := newTestGateway(t)
	msh := gw.BuildMSH("BetterDesk Mesh", "", "wss://example.com/agent.ashx")
	assertMSHMeshID96(t, msh)
	if strings.Contains(strings.ToUpper(msh), "EDBE1BE377EFC5B6D11DE0D50FED96017ADFAD0") {
		t.Fatal("legacy placeholder still present in .msh")
	}
	if !strings.Contains(msh, "ServerID="+gw.ServerID()) {
		t.Fatal("ServerID missing from .msh")
	}
}

func TestBuildMSHAcceptsExplicit64Hex(t *testing.T) {
	gw, _ := newTestGateway(t)
	explicit := strings.Repeat("ab", 32) // 64 hex
	msh := gw.BuildMSH("Lab", explicit, "wss://example.com/agent.ashx")
	line := meshIDLine(msh)
	if !strings.EqualFold(line, "0x"+explicit) {
		t.Fatalf("MeshID=%s want 0x%s", line, explicit)
	}
}

func meshIDLine(msh string) string {
	for _, line := range strings.Split(msh, "\n") {
		if strings.HasPrefix(line, "MeshID=") {
			return strings.TrimPrefix(line, "MeshID=")
		}
	}
	return ""
}

func assertMSHMeshID96(t *testing.T, msh string) {
	t.Helper()
	line := meshIDLine(msh)
	hexPart := strings.TrimPrefix(line, "0x")
	if len(hexPart) != 96 {
		t.Fatalf("MeshID hex len %d, want 96; got %s", len(hexPart), line)
	}
	if !IsValidMeshIDHex(hexPart) {
		t.Fatalf("invalid MeshID: %s", line)
	}
}
