package meshcentral

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/unitronix/betterdesk-server/audit"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/events"
)

func (g *Gateway) registerAgent(ac *AgentConn) (string, error) {
	peerID := meshPeerID(ac.meshNodeID)
	hostname := ac.hostname
	if hostname == "" {
		hostname = "MeshAgent-" + ac.meshNodeID[:min(8, len(ac.meshNodeID))]
	}

	peer := &db.Peer{
		ID:         peerID,
		Hostname:   hostname,
		Status:     "ONLINE",
		IP:         ac.clientIP,
		DeviceType: "mesh_agent",
		LastOnline: time.Now(),
		OS:         "mesh",
		Version:    g.assets.Version,
	}
	if err := g.db.UpsertPeer(peer); err != nil {
		return "", err
	}
	g.db.UpdatePeerStatus(peerID, "ONLINE", ac.clientIP)
	g.db.SetConfig("mesh_node_id_"+peerID, ac.meshNodeID)
	g.db.SetConfig("mesh_group_id_"+peerID, ac.meshGroupID)

	if old, loaded := g.agents.LoadAndDelete(peerID); loaded {
		if oac, ok := old.(*AgentConn); ok {
			oac.disconnect("replaced")
		}
	}
	g.agents.Store(peerID, ac)
	g.AutoLinkHybrid(peerID, hostname)

	if g.auditLog != nil {
		g.auditLog.Log(audit.ActionPeerUpdated, "mesh", peerID, map[string]string{
			"event": "mesh_agent_register",
			"node":  ac.meshNodeID,
		})
	}
	if g.eventBus != nil {
		g.eventBus.Publish(events.Event{
			Type: events.EventType("mesh_agent_connect"),
			Data: map[string]string{
				"peer_id":      peerID,
				"mesh_node_id": ac.meshNodeID,
			},
		})
	}
	log.Printf("[mesh] Agent registered peer=%s node=%s host=%s", peerID, ac.meshNodeID, hostname)
	return peerID, nil
}

func meshPeerID(nodeID string) string {
	s := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			return r
		}
		return '_'
	}, nodeID)
	if len(s) > 15 {
		s = s[:15]
	}
	if len(s) < 6 {
		s = "mesh_" + s
	}
	return "M" + s
}

func (g *Gateway) AutoLinkHybrid(peerID, hostname string) {
	if hostname == "" {
		return
	}
	peers, err := g.db.ListPeers(false)
	if err != nil {
		return
	}
	for _, p := range peers {
		if p.ID == peerID || p.DeviceType == "mesh_agent" {
			continue
		}
		if strings.EqualFold(p.Hostname, hostname) && p.LinkedPeerID == "" {
			g.db.UpdatePeerFields(peerID, map[string]string{"linked_peer_id": p.ID})
			return
		}
	}
}

func (g *Gateway) ListGroups() []MeshGroup {
	groups := g.loadGroupsRaw()
	groups, changed, err := ensureGroupMeshIDs(groups)
	if err != nil {
		log.Printf("[mesh] ensure group mesh ids: %v", err)
		return groups
	}
	if changed {
		if err := g.persistGroups(groups); err != nil {
			log.Printf("[mesh] persist group mesh ids: %v", err)
		}
	}
	return groups
}

func (g *Gateway) loadGroupsRaw() []MeshGroup {
	raw, _ := g.db.GetConfig("mesh_groups")
	if raw == "" {
		return nil
	}
	var groups []MeshGroup
	if err := json.Unmarshal([]byte(raw), &groups); err != nil {
		return nil
	}
	return groups
}

func (g *Gateway) persistGroups(groups []MeshGroup) error {
	b, err := json.Marshal(groups)
	if err != nil {
		return err
	}
	return g.db.SetConfig("mesh_groups", string(b))
}

func (g *Gateway) SaveGroups(groups []MeshGroup) error {
	groups, _, err := ensureGroupMeshIDs(groups)
	if err != nil {
		return err
	}
	return g.persistGroups(groups)
}

// DefaultMeshIDHex returns the persisted 96-hex MeshID for the default group
// (or the first group). Generates and stores one if missing.
func (g *Gateway) DefaultMeshIDHex() string {
	groups := g.ListGroups()
	for _, gr := range groups {
		if gr.ID == "default" && IsValidMeshIDHex(gr.MeshID) {
			return NormalizeMeshIDHex(gr.MeshID)
		}
	}
	if len(groups) > 0 && IsValidMeshIDHex(groups[0].MeshID) {
		return NormalizeMeshIDHex(groups[0].MeshID)
	}
	id, err := NewMeshIDHex()
	if err != nil {
		return ""
	}
	return id
}

// ResolveMeshIDHex picks a MeshAgent-valid MeshID: prefer explicit query value,
// otherwise the default/first group. Never returns the legacy 40-char placeholder.
func (g *Gateway) ResolveMeshIDHex(explicit string) string {
	if IsValidMeshIDHex(explicit) {
		return NormalizeMeshIDHex(explicit)
	}
	return g.DefaultMeshIDHex()
}

// AssignDeviceGroup stores mesh group membership for a mesh_agent peer.
func (g *Gateway) AssignDeviceGroup(peerID, groupID string) error {
	groupID = strings.TrimSpace(groupID)
	if err := g.db.SetConfig("mesh_group_id_"+peerID, groupID); err != nil {
		return err
	}
	if v, ok := g.agents.Load(peerID); ok {
		if ac, ok := v.(*AgentConn); ok && ac != nil {
			ac.meshGroupID = groupID
		}
	}
	return nil
}

func (g *Gateway) BuildMSH(meshName, meshIDHex, meshServerURL string) string {
	meshID := NormalizeMeshIDHex(meshIDHex)
	if !IsValidMeshIDHex(meshID) {
		meshID = g.ResolveMeshIDHex("")
	}
	if !strings.HasPrefix(meshID, "0x") {
		meshID = "0x" + meshID
	}
	return fmt.Sprintf("MeshName=%s\nMeshType=2\nMeshID=%s\nServerID=%s\nMeshServer=%s\n",
		meshName, meshID, g.creds.ServerID, meshServerURL)
}

func (g *Gateway) CreateDesktopTunnel(ctx context.Context, peerID, userID, relayBase string, record, viewOnly bool) (string, string, error) {
	return g.createRelayTunnel(peerID, userID, relayBase, relayProtocolKVM, "kvm", record, viewOnly, nil)
}

// CreateTerminalTunnel opens relay p=1 (admin shell) for browser terminal sessions.
func (g *Gateway) CreateTerminalTunnel(peerID, userID, relayBase string) (string, string, error) {
	return g.createRelayTunnel(peerID, userID, relayBase, relayProtocolTerminal, "terminal", false, false, nil)
}

// CreateFilesTunnel opens relay p=5 for remote file browser sessions.
func (g *Gateway) CreateFilesTunnel(peerID, userID, relayBase string) (string, string, error) {
	return g.createRelayTunnel(peerID, userID, relayBase, relayProtocolFiles, "files", false, false, nil)
}

func (g *Gateway) createRelayTunnel(peerID, userID, relayBase string, protocol int, sessionType string, record, viewOnly bool, tunnelOpts *TunnelOpts) (string, string, error) {
	relayID := newRelayID()
	nodeID := g.MeshNodeID(peerID)
	rights := uint32(0xFFFFFFFF)
	if viewOnly {
		rights = 0x00000002
	}
	authCookie, err := g.cookies.Encode(&RelayCookieData{
		RUserID:   userID,
		NodeID:    nodeID,
		Rights:    rights,
		ExpireMin: 240,
	}, 240)
	if err != nil {
		return "", "", err
	}
	rauthCookie, err := g.cookies.Encode(&RelayCookieData{
		RUserID:   userID,
		NodeID:    nodeID,
		ExpireMin: 240,
	}, 240)
	if err != nil {
		return "", "", err
	}
	tunnelPath := fmt.Sprintf("*/meshrelay.ashx?p=%d&id=%s&rauth=%s", protocol, relayID, rauthCookie)
	browserPath := fmt.Sprintf("%smeshrelay.ashx?browser=1&p=%d&id=%s&nodeid=%s&auth=%s",
		relayBase, protocol, relayID, nodeID, authCookie)

	g.setRelayMeta(relayID, &relayMeta{
		PeerID:      peerID,
		UserID:      userID,
		SessionType: sessionType,
		Protocol:    protocol,
		Record:      record,
		ViewOnly:    viewOnly,
	})

	if err := g.SendTunnel(peerID, tunnelPath, rights, viewOnly, tunnelOpts); err != nil {
		g.setRelayMeta(relayID, nil)
		return "", "", err
	}
	if g.auditLog != nil {
		fields := map[string]string{
			"event": "mesh_session_start",
			"type":  sessionType,
		}
		if record {
			fields["record"] = "1"
		}
		if viewOnly {
			fields["view_only"] = "1"
		}
		if tunnelOpts != nil && tunnelOpts.TCPPort > 0 {
			fields["tcp_target"] = fmt.Sprintf("%s:%d", tunnelOpts.TCPAddr, tunnelOpts.TCPPort)
		}
		if tunnelOpts != nil && tunnelOpts.UDPPort > 0 {
			fields["udp_target"] = fmt.Sprintf("%s:%d", tunnelOpts.UDPAddr, tunnelOpts.UDPPort)
		}
		g.auditLog.Log(audit.ActionPeerUpdated, userID, peerID, fields)
	}
	return relayID, browserPath, nil
}

func newRelayID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
