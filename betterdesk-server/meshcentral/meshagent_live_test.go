//go:build meshagent_live

package meshcentral

import (
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestMeshAgentLiveConnect runs an unmodified MeshCentral meshagent binary against the gateway.
func TestMeshAgentLiveConnect(t *testing.T) {
	gw, srv := newTestGateway(t)

	binPath := os.Getenv("MESHAGENT_BIN")
	if binPath == "" {
		dir := t.TempDir()
		binPath = filepath.Join(dir, "meshagent_x86-64")
		if err := downloadMeshAgentLinux64(binPath); err != nil {
			t.Fatal(err)
		}
	}

	mshDir := t.TempDir()
	meshHex := make([]byte, 32)
	rand.Read(meshHex)
	meshID := "0x" + fmt.Sprintf("%x", meshHex)
	msh := fmt.Sprintf("MeshName=BetterDeskInterop\nMeshType=2\nMeshID=%s\nServerID=%s\nMeshServer=%s\nMeshServerNoSSL=1\n",
		meshID,
		gw.creds.ServerID,
		strings.Replace(srv.URL, "http://", "ws://", 1)+"/agent.ashx",
	)

	agentBin := filepath.Join(mshDir, "meshagent")
	if err := copyFile(binPath, agentBin); err != nil {
		t.Fatal(err)
	}
	mshPath := filepath.Join(mshDir, "meshagent.msh")
	if err := os.WriteFile(mshPath, []byte(msh), 0600); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(mshDir, "meshagent.log")

	cmd := exec.Command(agentBin, "-meshSettingsFile="+mshPath, "-logfile="+logPath)
	cmd.Dir = mshDir
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
	})

	deadline := time.Now().Add(120 * time.Second)
	for gw.ActiveAgentCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(500 * time.Millisecond)
	}
	if gw.ActiveAgentCount() != 1 {
		// One retry after brief pause (CI download/network flake)
		time.Sleep(3 * time.Second)
		for gw.ActiveAgentCount() == 0 && time.Now().Before(deadline) {
			time.Sleep(500 * time.Millisecond)
		}
	}
	if gw.ActiveAgentCount() != 1 {
		if data, err := os.ReadFile(logPath); err == nil && len(data) > 0 {
			t.Logf("meshagent log:\n%s", string(data))
		}
		t.Fatalf("live meshagent did not register within timeout (count=%d)", gw.ActiveAgentCount())
	}
}
