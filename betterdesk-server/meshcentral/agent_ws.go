package meshcentral

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/coder/websocket"
	"github.com/unitronix/betterdesk-server/audit"
	"github.com/unitronix/betterdesk-server/events"
)

// AgentConn represents an authenticated MeshAgent control WebSocket.
type AgentConn struct {
	gw          *Gateway
	conn        *websocket.Conn
	peerID      string
	meshNodeID  string
	meshGroupID string
	clientIP    string
	hostname    string

	serverNonce []byte
	agentNonce  []byte
	webHash     []byte
	receivedCmd uint8
	authenticated bool
	coreStable    bool

	mu sync.Mutex
}

func (g *Gateway) handleAgentWS(w http.ResponseWriter, r *http.Request) {
	if !g.allowIP(w, r) {
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Printf("[mesh] agent WS upgrade failed: %v", err)
		return
	}
	conn.SetReadLimit(16 * 1024 * 1024)

	g.activeAgents.Add(1)
	ac := &AgentConn{
		gw:       g,
		conn:     conn,
		clientIP: clientIP(r),
	}
	defer func() {
		g.activeAgents.Add(-1)
		ac.close()
	}()

	ctx := r.Context()
	if g.ctx != nil {
		ctx = g.ctx
	}

	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageBinary && typ != websocket.MessageText {
			continue
		}
		if len(data) == 0 {
			continue
		}
		if data[0] == '{' {
			ac.handleJSON(ctx, data)
			continue
		}
		if err := ac.handleBinary(ctx, data); err != nil {
			log.Printf("[mesh] agent binary error from %s: %v", ac.clientIP, err)
			return
		}
	}
}

func (ac *AgentConn) handleJSON(ctx context.Context, data []byte) {
	if !ac.authenticated {
		return
	}
	var msg map[string]interface{}
	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}
	action, _ := msg["action"].(string)
	switch action {
	case "ping":
		ac.sendText(ctx, `{"action":"pong"}`)
	case "pong":
		// ok
	case "coreinfo":
		ac.handleCoreInfo(msg)
	default:
		// telemetry / state — update peer metadata
		if ac.peerID != "" {
			b, _ := json.Marshal(msg)
			ac.gw.db.SetConfig("mesh_last_msg_"+ac.peerID, string(b))
		}
	}
}

func (ac *AgentConn) handleCoreInfo(msg map[string]interface{}) {
	ac.coreStable = true
	if ac.peerID != "" {
		b, _ := json.Marshal(msg)
		ac.gw.db.SetConfig("mesh_coreinfo_"+ac.peerID, string(b))
	}
}

func (ac *AgentConn) handleBinary(ctx context.Context, data []byte) error {
	if len(data) < 2 {
		return nil
	}
	cmd := readU16(data, 0)

	if !ac.authenticated {
		return ac.handleAuthBinary(ctx, cmd, data)
	}

	switch cmd {
	case cmdCoreModuleHash:
		// Agent reports hash — respond with core or CoreOk
		if len(data) >= 2+sha384Size {
			agentHash := data[4 : 4+sha384Size]
			if bytesEqual(agentHash, ac.gw.assets.CoreModuleHash) {
				return ac.sendBinary(ctx, BuildCoreOkPacket())
			}
		}
		return ac.sendBinary(ctx, BuildCoreModulePacket(ac.gw.assets.CoreModule))
	default:
		if cmd >= 10 {
			// post-auth binary — forward to logging only
			return nil
		}
	}
	return nil
}

func (ac *AgentConn) handleAuthBinary(ctx context.Context, cmd uint16, data []byte) error {
	switch cmd {
	case cmdAuthRequest:
		if len(data) != 98 || ac.receivedCmd&1 != 0 {
			return nil
		}
		ac.receivedCmd |= 1
		ac.webHash = append([]byte(nil), data[2:50]...)
		ac.agentNonce = append([]byte(nil), data[50:98]...)

		webHash := ac.webHash
		if g := ac.gw.webHash; len(g) == sha384Size {
			// validate agent saw our web cert when we have one
			if !bytesEqual(webHash, g) {
				log.Printf("[mesh] agent web cert hash mismatch from %s", ac.clientIP)
				return fmt.Errorf("bad web cert hash")
			}
		}

		ac.serverNonce = make([]byte, sha384Size)
		if _, err := rand.Read(ac.serverNonce); err != nil {
			return err
		}

		// AuthRequest response: cmd1 + webHash + serverNonce
		resp := make([]byte, 98)
		binaryPutU16(resp, 0, cmdAuthRequest)
		copy(resp[2:50], webHash)
		copy(resp[50:98], ac.serverNonce)
		if err := ac.sendBinary(ctx, resp); err != nil {
			return err
		}

		// AuthVerify: cmd2 + certLen + cert + signature(serverHash+serverNonce)
		sig, err := ac.gw.creds.SignServerAuth(webHash, ac.serverNonce)
		if err != nil {
			return err
		}
		cert := ac.gw.creds.CertDER
		pkt := make([]byte, 4+len(cert)+len(sig))
		binaryPutU16(pkt, 0, cmdAuthVerify)
		binaryPutU16(pkt, 2, uint16(len(cert)))
		copy(pkt[4:], cert)
		copy(pkt[4+len(cert):], sig)
		return ac.sendBinary(ctx, pkt)

	case cmdAuthVerify:
		if len(data) < 4 || ac.receivedCmd&2 != 0 {
			return nil
		}
		ac.receivedCmd |= 2
		certLen := int(readU16(data, 2))
		if len(data) < 4+certLen {
			return fmt.Errorf("short cert")
		}
		certDER := data[4 : 4+certLen]
		signature := data[4+certLen:]
		if ac.agentNonce == nil {
			return nil
		}
		nodeID, err := VerifyAgentSignature(certDER, signature, ac.webHash, ac.serverNonce, ac.agentNonce)
		if err != nil {
			return err
		}
		ac.meshNodeID = nodeID
		return ac.tryCompleteAuth(ctx)

	case cmdAuthInfo:
		if len(data) < 72 || ac.receivedCmd&4 != 0 {
			return nil
		}
		ac.receivedCmd |= 4
		// mesh id at offset 18, 48 bytes (base64 mesh id)
		meshRaw := data[18:66]
		if isZero(meshRaw[16:32]) {
			ac.meshGroupID = fmt.Sprintf("%x", meshRaw[0:16])
		} else {
			ac.meshGroupID = base64MeshID(meshRaw)
		}
		capabilities := readU32(data, 66)
		if len(data) > 72 {
			hnLen := int(readU16(data, 70))
			if len(data) >= 72+hnLen {
				ac.hostname = string(data[72 : 72+hnLen])
			}
		}
		_ = capabilities
		return ac.tryCompleteAuth(ctx)

	case cmdAuthConfirm:
		ac.receivedCmd |= 8
		return ac.tryCompleteAuth(ctx)

	case cmdServerID:
		// optional — select cert identity
		return nil
	}
	return nil
}

func (ac *AgentConn) tryCompleteAuth(ctx context.Context) error {
	if ac.meshNodeID == "" || ac.meshGroupID == "" {
		return nil
	}
	if ac.authenticated {
		return nil
	}
	// Need auth verify + auth info
	if ac.receivedCmd&2 == 0 || ac.receivedCmd&4 == 0 {
		return nil
	}

	ac.authenticated = true
	peerID, err := ac.gw.registerAgent(ac)
	if err != nil {
		return err
	}
	ac.peerID = peerID

	// AuthConfirm cmd 4
	if err := ac.sendBinary(ctx, buildAuthConfirm()); err != nil {
		return err
	}
	// Request core hash
	if err := ac.sendBinary(ctx, BuildCoreModuleHashRequest()); err != nil {
		return err
	}
	ac.sendText(ctx, `{"action":"serverInfo"}`)
	return nil
}

func buildAuthConfirm() []byte {
	p := make([]byte, 2)
	binaryPutU16(p, 0, cmdAuthConfirm)
	return p
}

func (ac *AgentConn) sendBinary(ctx context.Context, data []byte) error {
	return ac.conn.Write(ctx, websocket.MessageBinary, data)
}

func (ac *AgentConn) sendText(ctx context.Context, s string) error {
	return ac.conn.Write(ctx, websocket.MessageText, []byte(s))
}

func (ac *AgentConn) disconnect(reason string) {
	ac.mu.Lock()
	pid := ac.peerID
	ac.peerID = ""
	ac.mu.Unlock()
	if pid != "" {
		ac.gw.agents.Delete(pid)
		ac.gw.db.UpdatePeerStatus(pid, "OFFLINE", ac.clientIP)
		if ac.gw.eventBus != nil {
		ac.gw.eventBus.Publish(events.Event{
			Type: events.EventType("mesh_agent_disconnect"),
				Data: map[string]string{"peer_id": pid, "reason": reason},
			})
		}
	}
	if ac.conn != nil {
		ac.conn.Close(websocket.StatusGoingAway, reason)
	}
}

func (ac *AgentConn) close() {
	ac.disconnect("closed")
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func isZero(b []byte) bool {
	for _, c := range b {
		if c != 0 {
			return false
		}
	}
	return true
}

func base64MeshID(raw []byte) string {
	s := encodeBase64(raw)
	return strings.ReplaceAll(strings.ReplaceAll(s, "+", "@"), "/", "$")
}

// SendTunnel instructs agent to open meshrelay tunnel.
func (g *Gateway) SendTunnel(peerID, tunnelURL string) error {
	v, ok := g.agents.Load(peerID)
	if !ok {
		return fmt.Errorf("mesh agent not connected")
	}
	ac, _ := v.(*AgentConn)
	msg := map[string]interface{}{
		"action":   "msg",
		"type":     "tunnel",
		"value":    tunnelURL,
		"rights":   0xFFFFFFFF,
		"consent":  0,
		"username": "BetterDesk",
		"realname": "BetterDesk Operator",
	}
	b, _ := json.Marshal(msg)
	return ac.conn.Write(g.ctx, websocket.MessageText, b)
}

// SendRunCommand sends runcommands JSON to agent.
func (g *Gateway) SendRunCommand(peerID, userID, cmd string, shell bool) error {
	v, ok := g.agents.Load(peerID)
	if !ok {
		return fmt.Errorf("mesh agent not connected")
	}
	ac, _ := v.(*AgentConn)
	msg := map[string]interface{}{
		"action":    "runcommands",
		"cmds":      cmd,
		"runAsUser": 0,
	}
	if shell {
		msg["type"] = 1
	}
	b, _ := json.Marshal(msg)
	if err := ac.conn.Write(g.ctx, websocket.MessageText, b); err != nil {
		return err
	}
	if g.auditLog != nil && userID != "" {
		g.auditLog.Log(audit.ActionPeerUpdated, userID, peerID, map[string]string{
			"event": "mesh_runcommand",
		})
	}
	return nil
}
