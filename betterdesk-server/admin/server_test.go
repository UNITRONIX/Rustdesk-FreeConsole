package admin

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/peer"
	"github.com/unitronix/betterdesk-server/security"
)

const testAdminPassword = "test-admin-password"

func setupTestAdmin(t *testing.T) (*Server, int) {
	t.Helper()

	cfg := config.DefaultConfig()
	// Find a free port
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to find free port: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	cfg.AdminPort = port
	cfg.AdminPassword = testAdminPassword

	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("failed to open db: %v", err)
	}
	database.Migrate()
	t.Cleanup(func() { database.Close() })

	peerMap := peer.NewMap()
	srv := New(cfg, database, peerMap, "test")
	srv.SetAdminPassword(testAdminPassword)
	srv.SetBlocklist(security.NewBlocklist())

	ctx := context.Background()
	if err := srv.Start(ctx); err != nil {
		t.Fatalf("failed to start admin: %v", err)
	}
	t.Cleanup(srv.Stop)

	return srv, port
}

func connectAdmin(t *testing.T, port int) net.Conn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 2*time.Second)
	if err != nil {
		t.Fatalf("failed to connect to admin: %v", err)
	}
	t.Cleanup(func() { conn.Close() })

	// Read banner
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	reader := bufio.NewReader(conn)
	if prompt, err := reader.ReadString(' '); err != nil || prompt != "Password: " {
		t.Fatalf("expected password prompt, got %q (err: %v)", prompt, err)
	}
	fmt.Fprintf(conn, "%s\r\n", testAdminPassword)
	reader.ReadString('\n') // Authenticated.
	reader.ReadString('\n') // BetterDesk Admin Console
	reader.ReadString('\n') // Type 'help'...
	reader.ReadString('\n') // blank line

	return conn
}

func sendCommand(conn net.Conn, cmd string) string {
	// Read the prompt first
	buf := make([]byte, 4096)
	conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	conn.Read(buf) // "> " prompt

	// Send command
	fmt.Fprintf(conn, "%s\r\n", cmd)

	// Read response
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var response strings.Builder
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			response.Write(buf[:n])
		}
		if err != nil || n == 0 {
			break
		}
		// Check if we've received the next prompt
		if strings.Contains(response.String(), "> ") && response.Len() > 2 {
			break
		}
	}
	return response.String()
}

func TestAdminStatusCommand(t *testing.T) {
	_, port := setupTestAdmin(t)
	conn := connectAdmin(t, port)

	resp := sendCommand(conn, "status")
	if !strings.Contains(resp, "BetterDesk") {
		t.Errorf("status should contain server name, got: %s", resp)
	}
	if !strings.Contains(resp, "DB Peers") {
		t.Errorf("status should contain peer info, got: %s", resp)
	}
}

func TestAdminHelpCommand(t *testing.T) {
	_, port := setupTestAdmin(t)
	conn := connectAdmin(t, port)

	resp := sendCommand(conn, "help")
	if !strings.Contains(resp, "Available commands") {
		t.Errorf("help should list commands, got: %s", resp)
	}
}

func TestAdminPeersCount(t *testing.T) {
	_, port := setupTestAdmin(t)
	conn := connectAdmin(t, port)

	resp := sendCommand(conn, "peers count")
	if !strings.Contains(resp, "Total:") {
		t.Errorf("peers count should show total, got: %s", resp)
	}
}

func TestAdminDisabledByDefault(t *testing.T) {
	cfg := config.DefaultConfig()
	// AdminPort defaults to 0 (disabled)
	database, _ := db.Open(":memory:")
	database.Migrate()
	defer database.Close()

	srv := New(cfg, database, peer.NewMap(), "test")
	err := srv.Start(context.Background())
	if err != nil {
		t.Errorf("should not error when disabled, got: %v", err)
	}
	srv.Stop()
}

func TestAdminRejectsEnabledPortWithoutPassword(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.AdminPort = 21115

	srv := New(cfg, nil, peer.NewMap(), "test")
	if err := srv.Start(context.Background()); err == nil {
		t.Fatal("expected enabled admin interface without password to be rejected")
	}
}
