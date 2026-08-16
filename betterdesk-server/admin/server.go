// Package admin provides a TCP command interface for server management.
// Administrators can connect via telnet/netcat to execute server commands
// without using the HTTP API, useful for emergency management and scripting.
package admin

import (
	"bufio"
	"context"
	"crypto/subtle"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/peer"
	"github.com/unitronix/betterdesk-server/security"
)

// Server is the TCP admin interface.
type Server struct {
	cfg           *config.Config
	db            db.Database
	peers         *peer.Map
	blocklist     *security.Blocklist
	reloadFunc    func() error
	adminPassword string
	listener      net.Listener
	ctx           context.Context
	cancel        context.CancelFunc
	wg            sync.WaitGroup
	version       string
}

// New creates a new admin TCP server.
func New(cfg *config.Config, database db.Database, peerMap *peer.Map, version string) *Server {
	return &Server{
		cfg:     cfg,
		db:      database,
		peers:   peerMap,
		version: version,
	}
}

// SetBlocklist sets the blocklist for admin commands.
func (s *Server) SetBlocklist(bl *security.Blocklist) {
	s.blocklist = bl
}

// SetPeerMap sets the peer map for admin commands.
func (s *Server) SetPeerMap(pm *peer.Map) {
	s.peers = pm
}

// SetReloadFunc sets the config reload function for the admin 'reload' command.
func (s *Server) SetReloadFunc(fn func() error) {
	s.reloadFunc = fn
}

// SetAdminPassword sets the password required for admin TCP connections.
func (s *Server) SetAdminPassword(pw string) {
	s.adminPassword = pw
}

// Start launches the admin TCP listener.
func (s *Server) Start(ctx context.Context) error {
	if err := s.cfg.ValidateAdminInterface(); err != nil {
		return fmt.Errorf("admin: %w", err)
	}
	if s.cfg.AdminPort == 0 {
		return nil // Admin interface disabled
	}

	s.ctx, s.cancel = context.WithCancel(ctx)

	var err error
	addr := fmt.Sprintf("127.0.0.1:%d", s.cfg.AdminPort) // Bind to localhost only
	s.listener, err = net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("admin: listen %s: %w", addr, err)
	}

	log.Printf("[admin] TCP listening on %s (localhost only)", addr)

	s.wg.Add(1)
	go s.serve()

	return nil
}

// Stop gracefully shuts down the admin server.
func (s *Server) Stop() {
	if s.listener == nil {
		return
	}
	log.Printf("[admin] Shutting down...")
	s.cancel()
	s.listener.Close()
	s.wg.Wait()
	log.Printf("[admin] Stopped")
}

func (s *Server) serve() {
	defer s.wg.Done()

	for {
		conn, err := s.listener.Accept()
		if err != nil {
			select {
			case <-s.ctx.Done():
				return
			default:
				log.Printf("[admin] Accept error: %v", err)
				continue
			}
		}
		go s.handleConn(conn)
	}
}

func (s *Server) handleConn(conn net.Conn) {
	defer conn.Close()

	remote := conn.RemoteAddr().String()
	log.Printf("[admin] Client connected: %s", remote)

	// Password authentication (if configured)
	if s.adminPassword != "" {
		fmt.Fprint(conn, "Password: ")
		conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		scanner := bufio.NewScanner(conn)
		if !scanner.Scan() {
			log.Printf("[admin] Client %s disconnected during auth", remote)
			return
		}
		if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(scanner.Text())), []byte(s.adminPassword)) != 1 {
			// BD-2026-011: Delay after failed auth to slow brute-force attempts
			time.Sleep(2 * time.Second)
			fmt.Fprintln(conn, "Authentication failed.")
			log.Printf("[admin] Authentication failed from %s", remote)
			return
		}
		fmt.Fprintln(conn, "Authenticated.")
	}

	fmt.Fprintf(conn, "BetterDesk Admin Console %s\r\n", s.version)
	fmt.Fprintf(conn, "Type 'help' for available commands.\r\n\r\n")

	scanner := bufio.NewScanner(conn)
	for {
		fmt.Fprint(conn, "> ")
		conn.SetReadDeadline(time.Now().Add(5 * time.Minute))

		if !scanner.Scan() {
			break
		}

		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		parts := strings.Fields(line)
		cmd := strings.ToLower(parts[0])
		args := parts[1:]

		switch cmd {
		case "help":
			s.cmdHelp(conn)
		case "status":
			s.cmdStatus(conn)
		case "peers":
			s.cmdPeers(conn, args)
		case "ban":
			s.cmdBan(conn, args)
		case "unban":
			s.cmdUnban(conn, args)
		case "kick":
			s.cmdKick(conn, args)
		case "blocklist":
			s.cmdBlocklist(conn, args)
		case "config":
			s.cmdConfig(conn, args)
		case "reload":
			s.cmdReload(conn)
		case "quit", "exit":
			fmt.Fprintln(conn, "Bye!")
			return
		default:
			fmt.Fprintf(conn, "Unknown command: %s (type 'help' for usage)\r\n", cmd)
		}
	}

	log.Printf("[admin] Client disconnected: %s", remote)
}

func (s *Server) cmdHelp(conn net.Conn) {
	help := `Available commands:
  status              Show server status
  peers               List online peers
  peers count         Show peer counts
  peers info <id>     Show detailed peer info
  ban <id> [reason]   Ban a peer
  unban <id>          Unban a peer
  kick <id>           Remove peer from memory (force offline)
  blocklist           List blocklist entries
  blocklist add <v>   Add IP/ID to blocklist
  blocklist rm <v>    Remove entry from blocklist
  config get <key>    Get config value
  config set <k> <v>  Set config value
  reload              Reload configuration (blocklist, env vars)
  quit                Disconnect
`
	fmt.Fprint(conn, help)
}

func (s *Server) cmdStatus(conn net.Conn) {
	total, online, _ := s.db.GetPeerCount()
	stats := s.peers.GetStats(config.DegradedThreshold, config.CriticalThreshold)

	fmt.Fprintf(conn, "Server:    BetterDesk %s\r\n", s.version)
	fmt.Fprintf(conn, "Uptime:    %s\r\n", time.Since(startTime).Truncate(time.Second))
	fmt.Fprintf(conn, "DB Peers:  %d total, %d online\r\n", total, online)
	fmt.Fprintf(conn, "In Memory: %d total, %d online, %d degraded, %d critical\r\n",
		stats.Total, stats.Online, stats.Degraded, stats.Critical)
	fmt.Fprintf(conn, "Transport: %d UDP, %d TCP, %d WS\r\n", stats.UDP, stats.TCP, stats.WS)
	fmt.Fprintf(conn, "Blocked:   %d banned, %d disabled\r\n", stats.Banned, stats.Disabled)
	if s.blocklist != nil {
		fmt.Fprintf(conn, "Blocklist: %d entries\r\n", s.blocklist.Count())
	}
}

func (s *Server) cmdPeers(conn net.Conn, args []string) {
	if len(args) > 0 {
		switch args[0] {
		case "count":
			total, online, _ := s.db.GetPeerCount()
			fmt.Fprintf(conn, "Total: %d, Online: %d\r\n", total, online)
			return
		case "info":
			if len(args) < 2 {
				fmt.Fprintln(conn, "Usage: peers info <id>")
				return
			}
			s.cmdPeerInfo(conn, args[1])
			return
		}
	}

	// List online peers
	snapshots := s.peers.GetAllSnapshots(config.DegradedThreshold, config.CriticalThreshold)
	if len(snapshots) == 0 {
		fmt.Fprintln(conn, "No online peers")
		return
	}

	fmt.Fprintf(conn, "%-12s %-8s %-22s %-10s %s\r\n", "ID", "STATUS", "IP", "CONN", "UPTIME")
	fmt.Fprintf(conn, "%s\r\n", strings.Repeat("-", 70))
	for _, snap := range snapshots {
		fmt.Fprintf(conn, "%-12s %-8s %-22s %-10s %s\r\n",
			snap.ID, snap.Status, snap.IP, snap.ConnType, snap.Uptime)
	}
	fmt.Fprintf(conn, "\nTotal: %d peers\r\n", len(snapshots))
}

func (s *Server) cmdPeerInfo(conn net.Conn, id string) {
	p, err := s.db.GetPeer(id)
	if err != nil {
		fmt.Fprintf(conn, "Error: %v\r\n", err)
		return
	}
	if p == nil {
		fmt.Fprintf(conn, "Peer %s not found\r\n", id)
		return
	}

	fmt.Fprintf(conn, "ID:          %s\r\n", p.ID)
	fmt.Fprintf(conn, "UUID:        %s\r\n", p.UUID)
	fmt.Fprintf(conn, "IP:          %s\r\n", p.IP)
	fmt.Fprintf(conn, "Hostname:    %s\r\n", p.Hostname)
	fmt.Fprintf(conn, "OS:          %s\r\n", p.OS)
	fmt.Fprintf(conn, "Version:     %s\r\n", p.Version)
	fmt.Fprintf(conn, "Status (DB): %s\r\n", p.Status)
	fmt.Fprintf(conn, "NAT Type:    %d\r\n", p.NATType)
	fmt.Fprintf(conn, "Banned:      %v\r\n", p.Banned)
	fmt.Fprintf(conn, "Tags:        %s\r\n", p.Tags)
	fmt.Fprintf(conn, "Last Online: %s\r\n", p.LastOnline.Format(time.RFC3339))
	fmt.Fprintf(conn, "Created:     %s\r\n", p.CreatedAt.Format(time.RFC3339))

	// Live status if in memory
	if snap, ok := s.peers.GetSnapshot(id, config.DegradedThreshold, config.CriticalThreshold); ok {
		fmt.Fprintf(conn, "Live Status: %s (uptime %s, %d heartbeats)\r\n",
			snap.Status, snap.Uptime, snap.HeartbeatCount)
	} else {
		fmt.Fprintln(conn, "Live Status: not in memory (offline)")
	}
}

func (s *Server) cmdBan(conn net.Conn, args []string) {
	if len(args) < 1 {
		fmt.Fprintln(conn, "Usage: ban <id> [reason]")
		return
	}
	id := args[0]
	reason := strings.Join(args[1:], " ")

	if err := s.db.BanPeer(id, reason); err != nil {
		fmt.Fprintf(conn, "Error: %v\r\n", err)
		return
	}
	if entry := s.peers.Get(id); entry != nil {
		entry.Banned = true
	}
	fmt.Fprintf(conn, "Peer %s banned\r\n", id)
}

func (s *Server) cmdUnban(conn net.Conn, args []string) {
	if len(args) < 1 {
		fmt.Fprintln(conn, "Usage: unban <id>")
		return
	}
	id := args[0]

	if err := s.db.UnbanPeer(id); err != nil {
		fmt.Fprintf(conn, "Error: %v\r\n", err)
		return
	}
	if entry := s.peers.Get(id); entry != nil {
		entry.Banned = false
	}
	fmt.Fprintf(conn, "Peer %s unbanned\r\n", id)
}

func (s *Server) cmdKick(conn net.Conn, args []string) {
	if len(args) < 1 {
		fmt.Fprintln(conn, "Usage: kick <id>")
		return
	}
	id := args[0]
	removed := s.peers.Remove(id)
	if removed != nil {
		s.db.UpdatePeerStatus(id, "OFFLINE", "")
		fmt.Fprintf(conn, "Peer %s kicked (forced offline)\r\n", id)
	} else {
		fmt.Fprintf(conn, "Peer %s not in memory\r\n", id)
	}
}

func (s *Server) cmdBlocklist(conn net.Conn, args []string) {
	if s.blocklist == nil {
		fmt.Fprintln(conn, "Blocklist not enabled")
		return
	}

	if len(args) == 0 {
		entries := s.blocklist.List()
		if len(entries) == 0 {
			fmt.Fprintln(conn, "Blocklist is empty")
			return
		}
		for _, e := range entries {
			fmt.Fprintf(conn, "  %s\r\n", e)
		}
		fmt.Fprintf(conn, "Total: %d entries\r\n", len(entries))
		return
	}

	switch args[0] {
	case "add":
		if len(args) < 2 {
			fmt.Fprintln(conn, "Usage: blocklist add <ip/id>")
			return
		}
		value := args[1]
		// Auto-detect type
		if ip := net.ParseIP(value); ip != nil {
			s.blocklist.BlockIP(value, "admin")
		} else if strings.Contains(value, "/") {
			if err := s.blocklist.BlockCIDR(value, "admin"); err != nil {
				fmt.Fprintf(conn, "Error: %v\r\n", err)
				return
			}
		} else {
			s.blocklist.BlockID(value, "admin")
		}
		fmt.Fprintf(conn, "Added %s to blocklist\r\n", value)

	case "rm", "remove":
		if len(args) < 2 {
			fmt.Fprintln(conn, "Usage: blocklist rm <entry>")
			return
		}
		value := args[1]
		removed := s.blocklist.UnblockIP(value) || s.blocklist.UnblockID(value) || s.blocklist.UnblockCIDR(value)
		if removed {
			fmt.Fprintf(conn, "Removed %s from blocklist\r\n", value)
		} else {
			fmt.Fprintf(conn, "Entry %s not found\r\n", value)
		}

	default:
		fmt.Fprintln(conn, "Usage: blocklist [add|rm <value>]")
	}
}

func (s *Server) cmdConfig(conn net.Conn, args []string) {
	if len(args) < 2 {
		fmt.Fprintln(conn, "Usage: config get <key> | config set <key> <value>")
		return
	}

	switch args[0] {
	case "get":
		val, err := s.db.GetConfig(args[1])
		if err != nil {
			fmt.Fprintf(conn, "Error: %v\r\n", err)
			return
		}
		fmt.Fprintf(conn, "%s = %s\r\n", args[1], val)

	case "set":
		if len(args) < 3 {
			fmt.Fprintln(conn, "Usage: config set <key> <value>")
			return
		}
		val := strings.Join(args[2:], " ")
		if err := s.db.SetConfig(args[1], val); err != nil {
			fmt.Fprintf(conn, "Error: %v\r\n", err)
			return
		}
		fmt.Fprintf(conn, "%s = %s (updated)\r\n", args[1], val)

	default:
		fmt.Fprintln(conn, "Usage: config get <key> | config set <key> <value>")
	}
}

func (s *Server) cmdReload(conn net.Conn) {
	if s.reloadFunc == nil {
		fmt.Fprintln(conn, "Reload not configured")
		return
	}
	fmt.Fprintln(conn, "Reloading configuration...")
	if err := s.reloadFunc(); err != nil {
		fmt.Fprintf(conn, "Reload error: %v\r\n", err)
		return
	}
	fmt.Fprintln(conn, "Configuration reloaded successfully")
}

var startTime = time.Now()
