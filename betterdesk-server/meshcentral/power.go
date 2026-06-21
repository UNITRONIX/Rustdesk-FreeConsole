package meshcentral

import (
	"encoding/json"
	"fmt"

	"github.com/coder/websocket"
	"github.com/unitronix/betterdesk-server/audit"
)

// SendPowerAction forwards MeshCentral poweraction to the connected agent.
func (g *Gateway) SendPowerAction(peerID, userID string, actionType int, forced bool) error {
	v, ok := g.agents.Load(peerID)
	if !ok {
		return fmt.Errorf("mesh agent not connected")
	}
	ac, _ := v.(*AgentConn)
	msg := map[string]interface{}{
		"action":     "poweraction",
		"actiontype": actionType,
	}
	if forced {
		msg["forced"] = 1
	}
	b, _ := json.Marshal(msg)
	if err := ac.conn.Write(g.ctx, websocket.MessageText, b); err != nil {
		return err
	}
	if g.auditLog != nil && userID != "" {
		g.auditLog.Log(audit.ActionPeerUpdated, userID, peerID, map[string]string{
			"event":       "mesh_devicepower",
			"action_type": fmt.Sprintf("%d", actionType),
		})
	}
	return nil
}
