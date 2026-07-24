package meshcentral

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/coder/websocket"
	"github.com/unitronix/betterdesk-server/auth"
)

func (g *Gateway) handleControlWS(w http.ResponseWriter, r *http.Request) {
	if !g.allowIP(w, r) {
		return
	}

	userID := ""
	if g.jwt != nil {
		if tok := r.Header.Get("x-meshauth"); tok != "" {
			parts := strings.Split(tok, ",")
			if len(parts) >= 1 {
				claims, err := g.jwt.Validate(parts[0])
				if err == nil {
					userID = claims.Sub
				}
			}
		}
		if userID == "" {
			if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
				claims, err := g.jwt.Validate(strings.TrimPrefix(h, "Bearer "))
				if err == nil {
					userID = claims.Sub
				}
			}
		}
	}
	if userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	ctx := r.Context()
	if g.ctx != nil {
		ctx = g.ctx
	}

	// Push initial nodes list
	g.sendNodesList(ctx, conn, userID)

	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		var msg map[string]interface{}
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		action, _ := msg["action"].(string)
		switch action {
		case "ping":
			conn.Write(ctx, websocket.MessageText, []byte(`{"action":"pong"}`))
		case "authcookie":
			cookie, err := g.cookies.Encode(&RelayCookieData{RUserID: userID, ExpireMin: 240}, 240)
			if err == nil {
				resp, _ := json.Marshal(map[string]string{"action": "authcookie", "cookie": cookie})
				conn.Write(ctx, websocket.MessageText, resp)
			}
		case "nodes":
			g.sendNodesList(ctx, conn, userID)
		case "runcommands":
			nodeid, _ := msg["nodeid"].(string)
			cmds, _ := msg["cmds"].(string)
			peerID := g.peerIDFromNode(nodeid)
			if peerID != "" {
				_ = g.SendRunCommand(peerID, userID, cmds, true)
			}
		case "devicepower":
			nodeid, _ := msg["nodeid"].(string)
			peerID := g.peerIDFromNode(nodeid)
			if peerID == "" {
				continue
			}
			forced := false
			if f, ok := msg["forced"].(float64); ok && int(f) == 1 {
				forced = true
			}
			actionType := 0
			switch v := msg["actiontype"].(type) {
			case float64:
				actionType = int(v)
			case int:
				actionType = v
			}
			if actionType == 0 {
				if typ, ok := msg["type"].(string); ok {
					switch strings.ToLower(typ) {
					case "wake", "wakeup", "on":
						actionType = 6
					case "sleep":
						actionType = 2
					case "off", "poweroff":
						actionType = 3
					case "reset":
						actionType = 4
					}
				}
			}
			if actionType > 0 {
				_ = g.SendPowerAction(peerID, userID, actionType, forced)
			}
		default:
			log.Printf("[mesh] control action %s from %s", action, userID)
		}
	}
}

func (g *Gateway) sendNodesList(ctx context.Context, conn *websocket.Conn, userID string) {
	nodes := []map[string]interface{}{}
	g.agents.Range(func(key, value any) bool {
		pid, _ := key.(string)
		ac, _ := value.(*AgentConn)
		if ac == nil || !ac.authenticated {
			return true
		}
		nodes = append(nodes, map[string]interface{}{
			"_id":     "node//" + ac.meshNodeID,
			"name":    ac.hostname,
			"peer_id": pid,
			"conn":    1,
			"agent": map[string]interface{}{
				"ver":  g.assets.Version,
				"id":   ac.meshNodeID,
				"caps": 0,
			},
		})
		return true
	})
	resp := map[string]interface{}{
		"action": "nodes",
		"nodes":  nodes,
	}
	b, _ := json.Marshal(resp)
	conn.Write(ctx, websocket.MessageText, b)
}

func (g *Gateway) peerIDFromNode(nodeKey string) string {
	raw := strings.TrimPrefix(nodeKey, "node//")
	var found string
	g.agents.Range(func(key, value any) bool {
		pid, _ := key.(string)
		ac, _ := value.(*AgentConn)
		if ac != nil && ac.meshNodeID == raw {
			found = pid
			return false
		}
		return true
	})
	if found != "" {
		return found
	}
	peers, _ := g.db.ListPeers(false)
	for _, p := range peers {
		if stored, _ := g.db.GetConfig("mesh_node_id_" + p.ID); stored == raw || stored == nodeKey {
			return p.ID
		}
	}
	return ""
}

// ControlAuthBridge builds x-meshauth header value from JWT.
func ControlAuthBridge(jwt string, user *auth.Claims) string {
	return jwt
}
