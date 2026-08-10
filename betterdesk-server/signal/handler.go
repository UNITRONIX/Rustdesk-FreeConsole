package signal

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/unitronix/betterdesk-server/audit"
	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/crypto"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/events"
	"github.com/unitronix/betterdesk-server/peer"
	pb "github.com/unitronix/betterdesk-server/proto"
	"github.com/unitronix/betterdesk-server/relay"
)

// refuseRelayProtocolMismatch is returned when one peer uses WebSocket Mode
// and the other uses native TCP/UDP — their relay framings are incompatible (#290).
const refuseRelayProtocolMismatch = "Protocol mismatch: WebSocket and native TCP/UDP cannot share a relay session"

// refuseInitiatorNotAuthorized is returned when PunchHole/RequestRelay comes from
// a peer that is not registered (or not enrollment-approved in managed/locked).
const refuseInitiatorNotAuthorized = "Not authorized"

// panelWebRemoteInitiatorID is the synthetic initiator id logged when PunchHole/
// RequestRelay arrives from the Node panel WebSocket→TCP proxy (#302 Web Remote).
const panelWebRemoteInitiatorID = "panel-web-remote"

// relayTransportMismatch reports whether initiator and target use incompatible
// relay transports (WebSocket Mode vs native TCP/UDP). Signaling may still be
// mixed; this gate only covers the typical case where ConnType reflects the
// client's relay mode. The relay server remains the hard barrier.
func relayTransportMismatch(initiator, target peer.ConnType) bool {
	return (initiator == peer.ConnWS) != (target == peer.ConnWS)
}

// isInboundOnlyDeviceType identifies agents that may be contacted by an
// operator/client but must never start RustDesk P2P or relay sessions
// themselves. Normalize common spelling variants because metadata has existed
// in both underscore and hyphen forms.
func isInboundOnlyDeviceType(deviceType string) bool {
	normalized := strings.ToLower(strings.TrimSpace(deviceType))
	normalized = strings.NewReplacer("-", "", "_", "", " ", "").Replace(normalized)
	return normalized == "osagent" || normalized == "supportagent"
}

func isInboundOnlyPeer(p *db.Peer) bool {
	if p == nil {
		return false
	}
	if isInboundOnlyDeviceType(p.DeviceType) {
		return true
	}
	for _, tag := range strings.FieldsFunc(p.Tags, func(r rune) bool {
		return r == ',' || r == ';' || r == ' ' || r == '\t' || r == '\n'
	}) {
		if isInboundOnlyDeviceType(tag) {
			return true
		}
	}
	return false
}

// targetAcceptsInboundSession checks durable target status before forwarding a
// new signaling or relay request. The in-memory peer map can remain populated
// briefly after an administrator disables, bans, or deletes a device.
func (s *Server) targetAcceptsInboundSession(targetID string) bool {
	if targetID == "" || s.db == nil {
		return targetID != ""
	}
	p, err := s.db.GetPeer(targetID)
	if err != nil {
		log.Printf("[signal] Target %s database lookup failed: %v", targetID, err)
		return false
	}
	if p != nil {
		return !p.Banned && !p.Disabled && !p.SoftDeleted
	}
	state, err := s.db.GetPeerIDState(targetID)
	if err != nil {
		log.Printf("[signal] Target %s state lookup failed: %v", targetID, err)
		return false
	}
	// A target that was never stored by the BetterDesk inventory can still use
	// compatibility signaling in open mode; a known soft-deleted ID cannot.
	return state != db.PeerIDSoftDeleted
}

// requiresRelayOnlyCompatibility keeps the temporary RustDesk-compatible
// support-agent path on relay transport. Direct transport has no equivalent
// server-bound session grant yet, so allowing P2P would create an
// authorization bypass around the passive-session policy.
func (s *Server) requiresRelayOnlyCompatibility(peerID string) bool {
	if peerID == "" || s.db == nil {
		return false
	}
	p, err := s.db.GetPeer(peerID)
	if err != nil {
		log.Printf("[signal] Compatibility peer %s lookup failed: %v", peerID, err)
		return true
	}
	return isInboundOnlyPeer(p)
}

// handleUDPMessage dispatches a UDP message to the appropriate handler.
func (s *Server) handleUDPMessage(msg *pb.RendezvousMessage, raddr *net.UDPAddr) {
	switch {
	case msg.GetRegisterPeer() != nil:
		s.handleRegisterPeer(msg.GetRegisterPeer(), raddr)
	case msg.GetRegisterPk() != nil:
		s.handleRegisterPk(msg.GetRegisterPk(), raddr)
	case msg.GetPunchHoleRequest() != nil:
		s.handlePunchHoleRequest(msg.GetPunchHoleRequest(), raddr)
	case msg.GetPunchHoleSent() != nil:
		// Target B tells signal that it's ready — convert to PunchHoleResponse for initiator A
		s.handlePunchHoleSent(msg.GetPunchHoleSent(), raddr, true)
	case msg.GetRequestRelay() != nil:
		s.handleRequestRelay(msg.GetRequestRelay(), raddr)
	case msg.GetFetchLocalAddr() != nil:
		s.handleFetchLocalAddr(msg.GetFetchLocalAddr(), raddr)
	case msg.GetLocalAddr() != nil:
		s.handleLocalAddr(msg.GetLocalAddr(), raddr)
	case msg.GetHc() != nil:
		// Health check — respond with the same token
		resp := &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_Hc{
				Hc: &pb.HealthCheck{Token: msg.GetHc().Token},
			},
		}
		s.sendUDP(resp, raddr)
	case msg.GetKeyExchange() != nil:
		// Some clients probe signal UDP with KeyExchange; secure handshake is TCP-only.
		log.Printf("[signal] UDP KeyExchange from %s ignored (use TCP signal for secure sessions)", raddr)
	case msg.GetOnlineRequest() != nil:
		resp := s.handleOnlineRequest(msg.GetOnlineRequest())
		if resp != nil {
			s.sendUDP(resp, raddr)
		}
	default:
		log.Printf("[signal] UDP: unhandled message type from %s", raddr)
	}
}

func signalLimiterKey(kind, clientHost, peerID string) string {
	if peerID == "" {
		return fmt.Sprintf("%s:%s", kind, clientHost)
	}
	return fmt.Sprintf("%s:%s:%s", kind, clientHost, peerID)
}

func (s *Server) publishPeerOnline(id string) {
	if s.eventBus == nil {
		return
	}
	s.eventBus.Publish(events.Event{
		Type: events.EventPeerOnline,
		Data: map[string]string{
			"id":     id,
			"status": "online",
		},
	})
}

func (s *Server) allowRegistration(clientHost, peerID string, knownPeer bool) bool {
	// Registered peers send heartbeats every ~12s — rate-limiting those adds
	// lock contention without abuse benefit (peer ID is already validated in memory).
	if knownPeer {
		return true
	}
	if s.limiter == nil {
		return true
	}
	return s.limiter.Allow(signalLimiterKey("reg-new", clientHost, ""))
}

func (s *Server) allowSignalConnection(clientHost string) bool {
	if s.limiter == nil {
		return true
	}
	return s.limiter.Allow(signalLimiterKey("conn", clientHost, ""))
}

// handleMessage dispatches a TCP/WS message. Returns a response or nil.
// For PunchHoleRequest and RequestRelay, we return nil (no immediate response)
// because the signal server holds the TCP connection open and forwards the
// target's response later via tcpPunchConns.
func (s *Server) handleMessage(msg *pb.RendezvousMessage, raddr net.Addr) *pb.RendezvousMessage {
	switch {
	case msg.GetRegisterPk() != nil:
		return s.handleRegisterPkTCP(msg.GetRegisterPk(), raddr)
	case msg.GetPunchHoleRequest() != nil:
		// TCP punch hole: forward PunchHole to target via UDP.
		// If target is online, return nil (keep TCP open for later response).
		// If target is offline/not found, return PunchHoleResponse with failure.
		udpAddr, _ := net.ResolveUDPAddr("udp", raddr.String())
		return s.handlePunchHoleRequestTCP(msg.GetPunchHoleRequest(), udpAddr)
	case msg.GetRequestRelay() != nil:
		// TCP relay request: forward to target via UDP AND send immediate
		// RelayResponse to TCP initiator with signed PK (matching UDP behavior).
		udpAddr, _ := net.ResolveUDPAddr("udp", raddr.String())
		return s.handleRequestRelayTCP(msg.GetRequestRelay(), udpAddr, peer.ConnTCP)
	case msg.GetRelayResponse() != nil:
		// Target sends RelayResponse to be forwarded to the initiator via TCP.
		udpAddr, _ := net.ResolveUDPAddr("udp", raddr.String())
		s.handleRelayResponseForward(msg, udpAddr)
		return nil
	case msg.GetPunchHoleSent() != nil:
		// Target sends PunchHoleSent via TCP — convert to PunchHoleResponse
		// and forward to initiator via their stored TCP connection.
		udpAddr, _ := net.ResolveUDPAddr("udp", raddr.String())
		s.handlePunchHoleSent(msg.GetPunchHoleSent(), udpAddr, false)
		return nil
	case msg.GetFetchLocalAddr() != nil:
		// Forward FetchLocalAddr via UDP (fire-and-forget)
		udpAddr, _ := net.ResolveUDPAddr("udp", raddr.String())
		if udpAddr != nil {
			s.handleFetchLocalAddr(msg.GetFetchLocalAddr(), udpAddr)
		}
		return nil
	case msg.GetLocalAddr() != nil:
		// Forward LocalAddr via UDP (fire-and-forget)
		udpAddr, _ := net.ResolveUDPAddr("udp", raddr.String())
		if udpAddr != nil {
			s.handleLocalAddr(msg.GetLocalAddr(), udpAddr)
		}
		return nil
	case msg.GetHc() != nil:
		return &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_Hc{
				Hc: &pb.HealthCheck{Token: msg.GetHc().Token},
			},
		}
	case msg.GetHttpProxyRequest() != nil:
		// Recognized so clients no longer see Union=<nil> (#296), but we do not
		// implement an open HTTP egress proxy (SSRF risk). Honest rejection.
		return &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_HttpProxyResponse{
				HttpProxyResponse: &pb.HttpProxyResponse{
					Error: "not supported",
				},
			},
		}
	default:
		return nil
	}
}

// peerIDRegexp validates RustDesk peer ID format: 6-16 alphanumeric chars, hyphens, underscores.
var peerIDRegexp = regexp.MustCompile(`^[A-Za-z0-9_-]{6,16}$`)

// isValidPeerID checks if a peer ID conforms to the expected format.
func isValidPeerID(id string) bool {
	return peerIDRegexp.MatchString(id)
}

func hostFromAddrString(addrStr string) string {
	host, _, err := net.SplitHostPort(addrStr)
	if err == nil && host != "" {
		return host
	}
	return addrStr
}

// handleRegisterPeer processes a heartbeat registration from a client.
// This is the most frequent message — called every ~12 seconds per device.
func (s *Server) handleRegisterPeer(msg *pb.RegisterPeer, raddr *net.UDPAddr) {
	id := msg.Id
	if id == "" {
		return
	}

	// Validate peer ID format (S7)
	if !isValidPeerID(id) {
		log.Printf("[signal] Rejected invalid peer ID format: %q from %s", id, raddr.IP)
		return
	}

	// Blocklist check (IP and ID)
	clientHost := raddr.IP.String()
	if s.blocklist != nil {
		if s.blocklist.IsIPBlocked(clientHost) {
			log.Printf("[signal] Blocked IP %s tried to register", raddr.IP)
			return
		}
		if s.blocklist.IsIDBlocked(id) {
			log.Printf("[signal] Blocked ID %s tried to register", id)
			return
		}
	}

	// Panel rename: map stale client IDs to the successor row before lookup.
	if effectiveID, ok := s.resolveRegistrationPeerID(id, clientHost, nil, nil); !ok {
		return
	} else if effectiveID != id {
		id = effectiveID
	}

	// Check if peer exists in memory map
	existing := s.peers.Get(id)
	var dbPeer *db.Peer
	knownPeer := existing != nil
	if !knownPeer {
		if loadedPeer, err := s.db.GetPeer(id); err == nil && loadedPeer != nil {
			dbPeer = loadedPeer
			knownPeer = true
		}
	}
	if !s.allowRegistration(clientHost, id, knownPeer) {
		if knownPeer {
			log.Printf("[signal] Rate limited registration from %s for peer %s", clientHost, id)
		} else {
			log.Printf("[signal] Rate limited new registration from %s for peer %s", clientHost, id)
		}
		return
	}
	if existing != nil {
		// Reject banned peers — do not heartbeat or respond
		if existing.Banned {
			log.Printf("[signal] Rejected banned peer heartbeat: %s from %s", id, raddr.IP)
			s.revokeBannedPeerAccess(id, nil)
			return
		}
		if banned, err := s.db.IsPeerBanned(id); err != nil || banned {
			if err != nil {
				log.Printf("[signal] Failed ban check for peer heartbeat %s: %v", id, err)
			} else {
				log.Printf("[signal] Rejected banned peer heartbeat: %s from %s", id, raddr.IP)
				s.revokeBannedPeerAccess(id, nil)
			}
			return
		}

		// Update heartbeat
		s.peers.UpdateHeartbeat(id, raddr, msg.Serial)
		if err := s.db.TouchDeviceOnlineSession(id, time.Now().UTC(), config.RegTimeout); err != nil {
			log.Printf("[signal] Failed to record online heartbeat for %s: %v", id, err)
		}

		// Respond: don't need PK (we already have it)
		requestPk := len(existing.PK) == 0
		resp := &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_RegisterPeerResponse{
				RegisterPeerResponse: &pb.RegisterPeerResponse{
					RequestPk: requestPk,
				},
			},
		}
		s.sendUDP(resp, raddr)

		// Debounce database status updates — only sync every 60s per peer (P1)
		if time.Since(existing.LastDBSync) > 60*time.Second {
			s.db.UpdatePeerStatus(id, "ONLINE", raddr.IP.String())
			existing.LastDBSync = time.Now()
		}
		return
	}

	if s.rejectIfPeerSoftDeleted(id, raddr.IP.String()) {
		return
	}

	// NEW PEER — Dual Key System enrollment check.
	if !s.checkEnrollmentPermission(id, raddr.IP.String()) {
		log.Printf("[signal] Rejected new peer %s from %s (enrollment policy)", id, raddr.IP)
		if s.auditLog != nil {
			s.auditLog.Log(audit.ActionPeerRegistrationRejected, raddr.IP.String(), id, map[string]string{
				"reason": "enrollment_policy",
			})
		}
		return
	}

	// Check if this peer is banned in the database (e.g. removed from memory
	// map after ban but trying to re-register)
	if banned, err := s.db.IsPeerBanned(id); err != nil || banned {
		if err != nil {
			log.Printf("[signal] Failed ban check for peer registration %s: %v", id, err)
			return
		}
		log.Printf("[signal] Rejected banned peer registration: %s from %s", id, raddr.IP)
		s.revokeBannedPeerAccess(id, nil)
		if s.auditLog != nil {
			s.auditLog.Log(audit.ActionPeerRegistrationRejected, raddr.IP.String(), id, map[string]string{
				"reason": "banned",
			})
		}
		return
	}

	// New peer — add to memory map
	// Try to load existing PK from database first (peer may have registered PK before server restart)
	now := time.Now()
	entry := &peer.Entry{
		ID:              id,
		IP:              raddr.String(),
		UDPAddr:         raddr,
		Serial:          msg.Serial,
		ConnType:        peer.ConnUDP,
		LastReg:         now,
		FirstSeen:       now,
		HeartbeatCount:  1,
		StatusTier:      peer.StatusOnline,
		LastStatusCheck: now,
	}

	// Load PK and UUID from database if available (survives server restarts)
	if dbPeer == nil {
		dbPeer, _ = s.db.GetPeer(id)
	}
	if dbPeer != nil {
		if len(dbPeer.PK) > 0 {
			entry.PK = dbPeer.PK
			log.Printf("[signal] Loaded PK from database for %s (%d bytes)", id, len(entry.PK))
		}
		if dbPeer.UUID != "" {
			entry.UUID = peerUUIDFromDB(dbPeer.UUID)
		}
	}

	s.peers.Put(entry)

	// Only request PK if we don't have it from database
	requestPk := len(entry.PK) == 0
	resp := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RegisterPeerResponse{
			RegisterPeerResponse: &pb.RegisterPeerResponse{
				RequestPk: requestPk,
			},
		},
	}
	s.sendUDP(resp, raddr)

	log.Printf("[signal] New peer registered: %s from %s (pk_loaded=%v)", id, raddr, len(entry.PK) > 0)
	s.db.UpdatePeerStatus(id, "ONLINE", raddr.IP.String())
	if err := s.db.TouchDeviceOnlineSession(id, now.UTC(), config.RegTimeout); err != nil {
		log.Printf("[signal] Failed to start online session for %s: %v", id, err)
	}
	s.publishPeerOnline(id)
}

// handleRegisterPk processes a public key registration.
func (s *Server) handleRegisterPk(msg *pb.RegisterPk, raddr *net.UDPAddr) {
	resp := s.processRegisterPk(msg, raddr.String())
	s.sendUDP(resp, raddr)
}

// handleRegisterPkTCP handles RegisterPk over TCP (returns response).
func (s *Server) handleRegisterPkTCP(msg *pb.RegisterPk, raddr net.Addr) *pb.RendezvousMessage {
	return s.processRegisterPk(msg, raddr.String())
}

// processRegisterPk is the shared logic for RegisterPk handling.
func (s *Server) processRegisterPk(msg *pb.RegisterPk, addrStr string) *pb.RendezvousMessage {
	id := msg.Id
	if id == "" {
		return registerPkResponse(pb.RegisterPkResponse_SERVER_ERROR)
	}
	clientHost := hostFromAddrString(addrStr)

	// Validate peer ID format (S7)
	if !isValidPeerID(id) {
		log.Printf("[signal] Rejected invalid peer ID format in RegisterPk: %q", id)
		return registerPkResponse(pb.RegisterPkResponse_NOT_SUPPORT)
	}

	// IP blocklist check
	if s.blocklist != nil {
		if s.blocklist.IsIPBlocked(clientHost) {
			log.Printf("[signal] Blocked IP %s tried RegisterPk", clientHost)
			return registerPkResponse(pb.RegisterPkResponse_NOT_SUPPORT)
		}
		if s.blocklist.IsIDBlocked(id) {
			log.Printf("[signal] Blocked ID %s tried RegisterPk", id)
			return registerPkResponse(pb.RegisterPkResponse_NOT_SUPPORT)
		}
	}

	// Check for ID change request
	if msg.OldId != "" {
		return s.processIDChange(msg)
	}

	// Panel rename: map stale client IDs to the successor row before enrollment/DB checks.
	if effectiveID, ok := s.resolveRegistrationPeerID(id, clientHost, msg.Uuid, msg.Pk); !ok {
		return registerPkResponse(pb.RegisterPkResponse_NOT_SUPPORT)
	} else if effectiveID != id {
		id = effectiveID
		msg.Id = effectiveID
	}

	// Handle no_register_device (key-only exchange, no DB entry)
	if msg.NoRegisterDevice {
		return registerPkResponse(pb.RegisterPkResponse_OK)
	}

	// RegisterPk can be the first persistence point for stock RustDesk clients.
	// Enforce enrollment before creating a new peer row, otherwise managed/locked
	// mode can be bypassed by sending PK registration without a prior heartbeat.
	softDeleted, _ := s.db.IsPeerSoftDeleted(id)

	// SECURITY (GHSA-3v82-3gf8-fxx8): Reject PK registration for soft-deleted
	// peers. UpsertPeer would otherwise silently restore the row AND overwrite
	// the previously-stored PK with the attacker's key, completing an identity
	// takeover of a device the admin explicitly removed.
	if softDeleted {
		log.Printf("[signal] Rejected PK registration of deleted peer: %s from %s", id, clientHost)
		if s.auditLog != nil {
			s.auditLog.Log(audit.ActionPeerRegistrationRejected, clientHost, id, map[string]string{
				"reason": "soft_deleted",
				"stage":  "register_pk",
			})
		}
		s.peers.Remove(id)
		return registerPkResponse(pb.RegisterPkResponse_NOT_SUPPORT)
	}

	existingPeer, err := s.db.GetPeer(id)
	if err != nil {
		log.Printf("[signal] Failed to check peer %s before RegisterPk enrollment: %v", id, err)
		return registerPkResponse(pb.RegisterPkResponse_SERVER_ERROR)
	}
	if existingPeer == nil && !s.checkEnrollmentPermission(id, clientHost) {
		log.Printf("[signal] Rejected new peer PK registration: %s from %s (enrollment policy)", id, clientHost)
		s.peers.Remove(id)
		return registerPkResponse(pb.RegisterPkResponse_NOT_SUPPORT)
	}

	// Check ban status
	banned, err := s.db.IsPeerBanned(id)
	if err != nil {
		log.Printf("[signal] Failed ban check before RegisterPk for %s: %v", id, err)
		return registerPkResponse(pb.RegisterPkResponse_SERVER_ERROR)
	}
	if banned {
		log.Printf("[signal] Rejected banned peer: %s", id)
		s.revokeBannedPeerAccess(id, nil)
		return registerPkResponse(pb.RegisterPkResponse_NOT_SUPPORT)
	}

	// Get or create peer entry in memory
	entry := s.peers.Get(id)
	if entry == nil {
		entry = &peer.Entry{
			ID:      id,
			LastReg: time.Now(),
		}
		s.peers.Put(entry)
	}

	// Bind the persisted device identity before processing RegisterPk. After a
	// restart peer.Map is empty; without this hydration any caller could replace
	// the stored PK/UUID on its first RegisterPk. Empty stored fields remain
	// enrollable for legacy rows and legitimate first enrollment.
	if existingPeer != nil {
		if len(entry.UUID) == 0 && existingPeer.UUID != "" {
			entry.UUID = peerUUIDFromDB(existingPeer.UUID)
		}
		if len(entry.PK) == 0 && len(existingPeer.PK) > 0 {
			entry.PK = append([]byte(nil), existingPeer.PK...)
		}
	}

	// Existing identity is immutable through RegisterPk. RustDesk public keys
	// are long-lived; rotation must use an authenticated management workflow.
	if len(entry.UUID) > 0 && len(msg.Uuid) > 0 && !peerUUIDEqual(entry.UUID, msg.Uuid) {
		log.Printf("[signal] UUID mismatch for %s: registered=%x, received=%x",
			id, entry.UUID, msg.Uuid)
		return registerPkResponse(pb.RegisterPkResponse_UUID_MISMATCH)
	}
	if len(entry.PK) > 0 && len(msg.Pk) > 0 && !bytes.Equal(entry.PK, msg.Pk) {
		log.Printf("[signal] PK mismatch for %s", id)
		return registerPkResponse(pb.RegisterPkResponse_NOT_SUPPORT)
	}

	// Preserve a persisted identity when a compatible client omits either field.
	if len(msg.Uuid) > 0 {
		entry.UUID = normalizePeerUUIDBytes(msg.Uuid)
	}
	if len(msg.Pk) > 0 {
		entry.PK = append([]byte(nil), msg.Pk...)
	}
	entry.LastReg = time.Now()
	// Bind exact ip:port so FindByAddr can authorize TCP/WS-only RegisterPk
	// (viewer-only outbound when the OS service is not sending UDP heartbeats, #327).
	// Prefer same-TCP-session bind (tcpSessionPeerID) when RegisterPk keep-alive
	// leaves the connection open for a following PunchHole.
	if addrStr != "" {
		entry.IP = addrStr
		if entry.UDPAddr == nil && entry.ConnType != peer.ConnWS {
			entry.ConnType = peer.ConnTCP
		}
	}
	s.bindTCPSessionPeer(addrStr, id)

	// Persist to database
	dbPeer := &db.Peer{
		ID:     id,
		UUID:   fmt.Sprintf("%x", entry.UUID),
		PK:     entry.PK,
		Status: "ONLINE",
	}
	if err := s.db.UpsertPeer(dbPeer); err != nil {
		log.Printf("[signal] Failed to upsert peer %s: %v", id, err)
	} else {
		// Bind peers.user when an active RustDesk client login exists for this device.
		db.ApplyActiveSessionOwner(s.db, id, dbPeer.UUID)
	}

	log.Printf("[signal] PK registered for %s (pk=%d bytes)", id, len(msg.Pk))

	return &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RegisterPkResponse{
			RegisterPkResponse: &pb.RegisterPkResponse{
				Result:    pb.RegisterPkResponse_OK,
				KeepAlive: 12, // Suggest 12s heartbeat interval
			},
		},
	}
}

// processIDChange handles old_id → new id change requests.
func (s *Server) processIDChange(msg *pb.RegisterPk) *pb.RendezvousMessage {
	oldID := msg.OldId
	newID := msg.Id

	if !isValidPeerID(oldID) {
		log.Printf("[signal] Rejected invalid old peer ID in ID change: %q", oldID)
		return registerPkResponse(pb.RegisterPkResponse_NOT_SUPPORT)
	}
	if !isValidPeerID(newID) {
		log.Printf("[signal] Rejected invalid new peer ID in ID change: %q", newID)
		return registerPkResponse(pb.RegisterPkResponse_NOT_SUPPORT)
	}

	oldPeer, err := s.db.GetPeer(oldID)
	if err != nil {
		log.Printf("[signal] Failed to load old ID %s before ID change: %v", oldID, err)
		return registerPkResponse(pb.RegisterPkResponse_SERVER_ERROR)
	}
	if oldPeer == nil {
		return registerPkResponse(pb.RegisterPkResponse_NOT_SUPPORT)
	}

	// RustDesk 1.4.x change-ID sends RegisterPk without pk (see change_id_shared).
	// When pk is omitted, use the stored key; when present, enforce a match (#213).
	effectivePK := msg.Pk
	if len(effectivePK) == 0 {
		effectivePK = oldPeer.PK
	} else if len(oldPeer.PK) > 0 && !bytes.Equal(oldPeer.PK, effectivePK) {
		log.Printf("[signal] Rejected ID change %s → %s: PK mismatch", oldID, newID)
		return registerPkResponse(pb.RegisterPkResponse_NOT_SUPPORT)
	}

	// UUID: stock clients send machine_uid bytes on ID change (not 16-byte get_uuid()).
	// Enforce match only for wire-format 16-byte UUIDs.
	if len(msg.Uuid) == 16 && oldPeer.UUID != "" {
		if !peerUUIDEqual(peerUUIDFromDB(oldPeer.UUID), msg.Uuid) {
			log.Printf("[signal] Rejected ID change %s → %s: UUID mismatch", oldID, newID)
			return registerPkResponse(pb.RegisterPkResponse_UUID_MISMATCH)
		}
	}

	// Validate new ID doesn't exist
	existing := s.peers.Get(newID)
	if existing != nil {
		return registerPkResponse(pb.RegisterPkResponse_ID_EXISTS)
	}

	targetState, err := s.db.GetPeerIDState(newID)
	if err != nil {
		log.Printf("[signal] Failed to check target ID %s before ID change: %v", newID, err)
		return registerPkResponse(pb.RegisterPkResponse_SERVER_ERROR)
	}
	if targetState == db.PeerIDActive || targetState == db.PeerIDSoftDeleted {
		return registerPkResponse(pb.RegisterPkResponse_ID_EXISTS)
	}

	// Perform the change
	if err := s.db.ChangePeerID(oldID, newID, "client"); err != nil {
		if errors.Is(err, db.ErrPeerIDExists) || errors.Is(err, db.ErrPeerIDSoftDeleted) {
			return registerPkResponse(pb.RegisterPkResponse_ID_EXISTS)
		}
		if errors.Is(err, db.ErrPeerNotFound) {
			return registerPkResponse(pb.RegisterPkResponse_NOT_SUPPORT)
		}
		log.Printf("[signal] ID change %s → %s failed: %v", oldID, newID, err)
		return registerPkResponse(pb.RegisterPkResponse_SERVER_ERROR)
	}

	// Update in-memory map
	oldEntry := s.peers.Remove(oldID)
	if oldEntry != nil {
		oldEntry.ID = newID
		oldEntry.PK = effectivePK
		if len(msg.Uuid) > 0 {
			oldEntry.UUID = normalizePeerUUIDBytes(msg.Uuid)
		}
		s.peers.Put(oldEntry)
	}

	log.Printf("[signal] ID changed: %s → %s", oldID, newID)
	if s.eventBus != nil {
		s.eventBus.Publish(events.Event{
			Type: events.EventPeerIDChanged,
			Data: map[string]string{
				"old_id": oldID,
				"new_id": newID,
				"source": "client",
			},
		})
	}
	return registerPkResponse(pb.RegisterPkResponse_OK)
}

// handlePunchHoleRequest processes a hole-punch request from the initiator.
func (s *Server) handlePunchHoleRequest(msg *pb.PunchHoleRequest, raddr *net.UDPAddr) {
	targetID := msg.Id
	if targetID == "" {
		return
	}

	log.Printf("[signal] PunchHoleRequest from %s for target %s", raddr, targetID)

	initiatorID, ok := s.requireAuthorizedInitiator(raddr, targetID, msg.GetToken())
	if !ok {
		s.sendUDP(s.punchHoleUnauthorizedResponse(), raddr)
		return
	}

	target := s.peers.Get(targetID)

	// Target not found or offline
	if target == nil || target.IsExpired(config.RegTimeout) {
		if target == nil {
			log.Printf("[signal] PunchHole: target %s not found in peer map", targetID)
		} else {
			log.Printf("[signal] PunchHole: target %s expired (last heartbeat: %v ago)", targetID, time.Since(target.LastReg))
		}
		resp := &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_PunchHoleResponse{
				PunchHoleResponse: &pb.PunchHoleResponse{
					Failure:     pb.PunchHoleResponse_OFFLINE,
					RelayServer: s.getRelayServer(),
				},
			},
		}
		s.sendUDP(resp, raddr)
		return
	}

	// Target policy is durable; do not trust a stale live-peer entry after an
	// administrator has disabled, banned, or removed the device.
	if target.Banned || !s.targetAcceptsInboundSession(targetID) {
		resp := &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_PunchHoleResponse{
				PunchHoleResponse: &pb.PunchHoleResponse{
					Failure: pb.PunchHoleResponse_OFFLINE,
				},
			},
		}
		s.sendUDP(resp, raddr)
		return
	}

	if s.billing != nil {
		if check := s.billing.CheckConnection(targetID); !check.Allowed {
			log.Printf("[signal] PunchHole: billing denied for target %s: %s", targetID, check.Reason)
			resp := &pb.RendezvousMessage{
				Union: &pb.RendezvousMessage_PunchHoleResponse{
					PunchHoleResponse: &pb.PunchHoleResponse{
						Failure: pb.PunchHoleResponse_OFFLINE,
					},
				},
			}
			s.sendUDP(resp, raddr)
			return
		}
	}

	relayServer, sameNetwork, hairpin := s.selectPeerRelayServer(s.getRelayServer(), raddr, target.UDPAddr)
	relayServer = s.applyNetworkRelayPolicy(relayServer, initiatorID, targetID)
	if sameNetwork {
		log.Printf("[signal] LAN detected: %s and %s on same network, relay=%s", raddr.IP, target.UDPAddr.IP, relayServer)
	}
	if hairpin {
		log.Printf("[signal] PunchHole: shared public IP %s detected (issue #121 hairpin) → forcing relay for %s",
			raddr.IP, targetID)
	}

	log.Printf("[signal] PunchHole: target %s found (addr=%s, status=%s, lastReg=%v ago), relay=%s",
		targetID, target.UDPAddr, target.StatusTier, time.Since(target.LastReg), relayServer)

	// If force relay or always use relay
	if msg.ForceRelay || s.cfg.AlwaysUseRelay || hairpin ||
		s.shouldForceRelayForPeers(initiatorID, targetID) ||
		s.requiresRelayOnlyCompatibility(targetID) {
		log.Printf("[signal] PunchHole: force relay for %s", targetID)
		s.sendRelayResponse(target, raddr, msg, relayServer, initiatorID)
		return
	}

	// Send PunchHole to the TARGET peer (tell it the initiator's address)
	punchHole := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_PunchHole{
			PunchHole: &pb.PunchHole{
				SocketAddr:   crypto.EncodeAddr(raddr),
				RelayServer:  relayServer,
				NatType:      msg.NatType,
				UdpPort:      msg.UdpPort,
				ForceRelay:   msg.ForceRelay,
				UpnpPort:     msg.UpnpPort,
				SocketAddrV6: msg.SocketAddrV6,
			},
		},
	}

	if target.UDPAddr != nil {
		s.sendUDP(punchHole, target.UDPAddr)
	} else {
		// Target is connected via TCP/WS (e.g. logged in): forward PunchHole
		// over its active connection so it can still open its NAT for P2P.
		s.sendToPeer(targetID, punchHole)
	}

	// Send PunchHoleResponse to the INITIATOR with signed PK for E2E.
	// The original Rust hbbs sends PunchHoleResponse (not PunchHoleSent) to the initiator.
	// PunchHoleResponse has a 'pk' field for E2E key verification;
	// PunchHoleSent does NOT have a pk field, so using it breaks E2E encryption.
	var targetAddr []byte
	if target.UDPAddr != nil {
		targetAddr = crypto.EncodeAddr(target.UDPAddr)
	}

	// Sign the target's PK with server's Ed25519 key for E2E verification.
	var signedPk []byte
	if len(target.PK) > 0 {
		signed, err := s.kp.SignIdPk(targetID, target.PK)
		if err != nil {
			log.Printf("[signal] PunchHole: failed to sign PK for %s: %v", targetID, err)
		} else {
			signedPk = signed
			log.Printf("[signal] PunchHole: signed PK for %s (%d bytes)", targetID, len(signedPk))
		}
	}

	// When peers are on the same LAN, set IsLocal instead of NatType so the
	// client knows to use direct LAN addresses (FetchLocalAddr exchange).
	phr := &pb.PunchHoleResponse{
		SocketAddr:  targetAddr,
		Pk:          signedPk,
		RelayServer: relayServer,
	}
	if sameNetwork {
		phr.Union = &pb.PunchHoleResponse_IsLocal{IsLocal: true}
	} else {
		phr.Union = &pb.PunchHoleResponse_NatType{NatType: pb.NatType(target.NATType)}
	}

	resp := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_PunchHoleResponse{
			PunchHoleResponse: phr,
		},
	}

	// P2P-first (issue #157): when the peers are not on the same LAN, defer
	// this response and wait for the target's PunchHoleSent, which carries the
	// target's actual punched address and lets direct P2P succeed. If the
	// target stays silent past the grace period, the scheduled fallback sends
	// this relay-capable response so the client can fall back to relay instead
	// of hanging. handlePunchHoleSent cancels the fallback once the genuine
	// response is forwarded.
	if s.cfg.P2PFirst && !sameNetwork {
		raddrCopy := *raddr
		s.schedulePunchFallback(normalizeAddrKey(raddr.String()), func() {
			log.Printf("[signal] P2P-first: target %s did not complete hole punch in time, sending relay fallback to %s",
				targetID, raddrCopy.String())
			s.sendUDP(resp, &raddrCopy)
		})
		return
	}

	s.sendUDP(resp, raddr)
}

// handlePunchHoleRequestTCP handles punch hole over TCP/WS.
//
// Matching the UDP handler behavior: always send an immediate PunchHoleResponse
// to the TCP initiator with the target's signed PK, socket address, relay server,
// and NAT type.  This ensures the initiator can proceed with the connection
// (direct P2P or relay fallback) without waiting for the target to respond.
//
// Previous behavior (returning nil and waiting for the target's PunchHoleSent)
// caused "Failed to secure tcp: deadline has elapsed" timeouts when:
//   - The target was behind a strict NAT and didn't receive the UDP PunchHole
//   - The RustDesk client used TCP signaling (e.g. when logged in with a token)
//   - ForceRelay was set but the TCP path didn't handle it
//
// The TCP connection is kept alive (keepAlive=true via logAndCheckKeepAlive) so
// the server can still forward PunchHoleSent/RelayResponse from the target if
// they arrive later — this provides an update but is no longer required for the
// initiator to proceed.
func (s *Server) handlePunchHoleRequestTCP(msg *pb.PunchHoleRequest, raddr *net.UDPAddr) *pb.RendezvousMessage {
	if raddr == nil {
		log.Printf("[signal] PunchHoleRequest (TCP): nil address, ignoring")
		return nil
	}
	targetID := msg.Id
	if targetID == "" {
		return nil
	}

	log.Printf("[signal] PunchHoleRequest (TCP) from %s for target %s", raddr, targetID)

	initiatorID, ok := s.requireAuthorizedInitiator(raddr, targetID, msg.GetToken())
	if !ok {
		return s.punchHoleUnauthorizedResponse()
	}

	target := s.peers.Get(targetID)
	if target == nil || target.IsExpired(config.RegTimeout) {
		if target == nil {
			log.Printf("[signal] PunchHole (TCP): target %s not found in peer map", targetID)
		} else {
			log.Printf("[signal] PunchHole (TCP): target %s expired (last heartbeat: %v ago)", targetID, time.Since(target.LastReg))
		}
		return &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_PunchHoleResponse{
				PunchHoleResponse: &pb.PunchHoleResponse{
					Failure:     pb.PunchHoleResponse_OFFLINE,
					RelayServer: s.getRelayServer(),
				},
			},
		}
	}

	// Reject disabled, banned, or soft-deleted targets as offline.
	if target.Banned || !s.targetAcceptsInboundSession(targetID) {
		log.Printf("[signal] PunchHole (TCP): target %s is unavailable, rejecting", targetID)
		return &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_PunchHoleResponse{
				PunchHoleResponse: &pb.PunchHoleResponse{
					Failure: pb.PunchHoleResponse_OFFLINE,
				},
			},
		}
	}

	relayServer, sameNetwork, hairpin := s.selectPeerRelayServer(s.getRelayServer(), raddr, target.UDPAddr)
	relayServer = s.applyNetworkRelayPolicy(relayServer, initiatorID, targetID)
	if sameNetwork {
		log.Printf("[signal] LAN detected (TCP): %s and %s on same network, relay=%s", raddr.IP, target.UDPAddr.IP, relayServer)
	}
	if hairpin {
		log.Printf("[signal] PunchHole (TCP): shared public IP %s detected (issue #121 hairpin) → forcing relay for %s",
			raddr.IP, targetID)
	}

	log.Printf("[signal] PunchHole (TCP): target %s found (addr=%s, status=%s), relay=%s",
		targetID, target.UDPAddr, target.StatusTier, relayServer)

	// ForceRelay or AlwaysUseRelay: return PunchHoleResponse with SYMMETRIC NAT
	// type instead of RelayResponse. This tells the client that direct P2P is
	// impossible and it should fall back to relay via RequestRelay.
	//
	// The client will then send RequestRelay (with its own UUID) on this same
	// TCP connection. handleRequestRelayTCP will forward it to the target and
	// return RelayResponse to the initiator. Both sides connect to relay with
	// the SAME client-generated UUID, ensuring relay pairing succeeds.
	//
	// Previously, returning RelayResponse directly with a server-generated UUID
	// caused UUID mismatch: some RustDesk client versions ignore the UUID from
	// a RelayResponse received in response to PunchHoleRequest (they expect
	// PunchHoleResponse), generate their own UUID, and connect to relay with it
	// — while the target connects with the server's UUID. This broke relay
	// pairing every time (Issue #66).
	if msg.ForceRelay || s.cfg.AlwaysUseRelay || hairpin ||
		s.shouldForceRelayForPeers(initiatorID, targetID) ||
		s.requiresRelayOnlyCompatibility(targetID) {
		log.Printf("[signal] PunchHole (TCP): force relay for %s (returning SYMMETRIC to let client drive relay UUID)", targetID)

		var signedPk []byte
		if len(target.PK) > 0 {
			signed, err := s.kp.SignIdPk(target.ID, target.PK)
			if err != nil {
				log.Printf("[signal] PunchHole (TCP): failed to sign PK for %s: %v", targetID, err)
			} else {
				signedPk = signed
			}
		}

		var targetAddr []byte
		if target.UDPAddr != nil {
			targetAddr = crypto.EncodeAddr(target.UDPAddr)
		}

		return &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_PunchHoleResponse{
				PunchHoleResponse: &pb.PunchHoleResponse{
					SocketAddr:  targetAddr,
					Pk:          signedPk,
					RelayServer: relayServer,
					Union:       &pb.PunchHoleResponse_NatType{NatType: pb.NatType_SYMMETRIC},
				},
			},
		}
	}

	// Forward PunchHole to the TARGET peer (supports UDP, TCP, and WebSocket targets).
	punchHole := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_PunchHole{
			PunchHole: &pb.PunchHole{
				SocketAddr:   crypto.EncodeAddr(raddr),
				RelayServer:  relayServer,
				NatType:      msg.NatType,
				UdpPort:      msg.UdpPort,
				ForceRelay:   msg.ForceRelay,
				UpnpPort:     msg.UpnpPort,
				SocketAddrV6: msg.SocketAddrV6,
			},
		},
	}
	s.sendToPeer(targetID, punchHole)
	log.Printf("[signal] PunchHole (TCP): forwarded to target %s (connType=%s)", targetID, target.ConnType)

	// Sign the target's PK with server's Ed25519 key for E2E verification.
	var signedPk []byte
	if len(target.PK) > 0 {
		signed, err := s.kp.SignIdPk(targetID, target.PK)
		if err != nil {
			log.Printf("[signal] PunchHole (TCP): failed to sign PK for %s: %v", targetID, err)
		} else {
			signedPk = signed
			log.Printf("[signal] PunchHole (TCP): signed PK for %s (%d bytes)", targetID, len(signedPk))
		}
	}

	// Send immediate PunchHoleResponse to the TCP initiator — matching the UDP
	// handler's behavior.  This includes the target's signed PK, socket address,
	// relay server, and NAT type so the client can proceed immediately.
	var targetAddr []byte
	if target.UDPAddr != nil {
		targetAddr = crypto.EncodeAddr(target.UDPAddr)
	}

	phr := &pb.PunchHoleResponse{
		SocketAddr:  targetAddr,
		Pk:          signedPk,
		RelayServer: relayServer,
	}
	if sameNetwork {
		phr.Union = &pb.PunchHoleResponse_IsLocal{IsLocal: true}
	} else {
		phr.Union = &pb.PunchHoleResponse_NatType{NatType: pb.NatType(target.NATType)}
	}

	resp := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_PunchHoleResponse{
			PunchHoleResponse: phr,
		},
	}

	// P2P-first (issue #157): for non-LAN peers, defer this response and wait
	// for the target's PunchHoleSent, which carries the target's actual punched
	// address and lets direct P2P succeed. The TCP connection is already kept
	// alive (keepAlive via logAndCheckKeepAlive) and registered in
	// tcpPunchConns, so handlePunchHoleSent can forward the genuine response
	// over it. If the target stays silent past the grace period, the scheduled
	// fallback forwards this relay-capable response so the client can fall back
	// to relay instead of hanging (preserving the Phase 7 timeout fix).
	if s.cfg.P2PFirst && !sameNetwork {
		initiatorKey := normalizeAddrKey(raddr.String())
		s.schedulePunchFallback(initiatorKey, func() {
			log.Printf("[signal] P2P-first (TCP): target %s did not complete hole punch in time, forwarding relay fallback to %s",
				targetID, initiatorKey)
			s.forwardToInitiator(initiatorKey, resp)
		})
		return nil
	}

	return resp
}

// handlePunchHoleSent processes a PunchHoleSent message from the target peer.
// This is sent by the target (B) after it receives PunchHole from the signal
// server.  "PunchHoleSent" means "B is ready to accept a direct connection".
//
// The signal server converts this to a PunchHoleResponse and forwards it to the
// initiator (A).  For TCP initiators the response goes via tcpPunchConns; for
// UDP initiators it goes directly via UDP.
//
// PunchHoleSent fields: socket_addr (initiator A's addr), id (target B's ID),
// relay_server, nat_type, version.
//
// PunchHoleResponse fields: socket_addr (target B's addr, encoded), pk (target
// B's public key), relay_server, nat_type.
func (s *Server) handlePunchHoleSent(phs *pb.PunchHoleSent, senderAddr *net.UDPAddr, viaUDP bool) {
	if phs == nil || len(phs.SocketAddr) == 0 {
		return
	}

	// Decode the initiator's address from socket_addr.
	initiatorAddr, err := crypto.DecodeAddr(phs.SocketAddr)
	if err != nil {
		log.Printf("[signal] PunchHoleSent: cannot decode socket_addr: %v", err)
		return
	}

	transport := "TCP"
	if viaUDP {
		transport = "UDP"
	}
	log.Printf("[signal] %s PunchHoleSent from %s for initiator %s (id=%s)",
		transport, senderAddr, initiatorAddr, phs.Id)

	// Look up the target's public key and sign it for E2E encryption verification.
	// RustDesk clients expect signed IdPk in NaCl format: [ signature | IdPk protobuf ]
	var signedPk []byte
	targetID := phs.Id

	// Fallback: if phs.Id is empty, try to identify the sender by IP lookup.
	// Older RustDesk clients may not populate the id field in PunchHoleSent.
	if targetID == "" {
		if n := s.peers.CountByIP(senderAddr.IP); n > 1 {
			log.Printf("[signal] PunchHoleSent: ambiguous IP lookup for %s (%d peers) — cannot resolve empty id", senderAddr.IP, n)
		} else if entry := s.peers.FindByIP(senderAddr.IP); entry != nil {
			targetID = entry.ID
			log.Printf("[signal] PunchHoleSent: resolved sender %s to peer %s via IP lookup", senderAddr, targetID)
		}
	}

	if targetID != "" {
		if target := s.peers.Get(targetID); target != nil && len(target.PK) > 0 {
			// Sign the PK with server's Ed25519 key (enables client E2E verification)
			signed, err := s.kp.SignIdPk(targetID, target.PK)
			if err != nil {
				log.Printf("[signal] Failed to sign PK for %s: %v", targetID, err)
			} else {
				signedPk = signed
				log.Printf("[signal] Signed PK for %s: %d bytes", targetID, len(signedPk))
			}
		}
	}

	if len(signedPk) == 0 {
		log.Printf("[signal] WARNING: PunchHoleSent from %s — no PK available for target %q, E2E will not be established", senderAddr, targetID)
	}

	// Build PunchHoleResponse for the initiator.
	// socket_addr = target's (sender's) address, pk = SIGNED target's public key.
	// LAN detection: set is_local only for genuine LAN cases. Shared public IP
	// peers keep the public relay to avoid NAT hairpin failures (#121).
	relayServer := phs.RelayServer
	if relayServer == "" {
		relayServer = s.getRelayServer()
	}
	relayServer, sameNetwork, hairpin := s.selectPeerRelayServer(relayServer, senderAddr, initiatorAddr)
	if sameNetwork {
		log.Printf("[signal] PunchHoleSent LAN detected: %s and %s on same network, relay=%s", senderAddr.IP, initiatorAddr.IP, relayServer)
	}
	if hairpin {
		log.Printf("[signal] PunchHoleSent shared public IP %s detected (issue #121 hairpin) → keeping public relay=%s", senderAddr.IP, relayServer)
	}

	phr := &pb.PunchHoleResponse{
		SocketAddr:  crypto.EncodeAddr(senderAddr),
		Pk:          signedPk,
		RelayServer: relayServer,
	}
	if sameNetwork {
		phr.Union = &pb.PunchHoleResponse_IsLocal{IsLocal: true}
	} else {
		phr.Union = &pb.PunchHoleResponse_NatType{NatType: phs.NatType}
	}

	resp := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_PunchHoleResponse{
			PunchHoleResponse: phr,
		},
	}

	addrStr := normalizeAddrKey(initiatorAddr.String())

	// P2P-first (issue #157): the target completed hole punching, so cancel any
	// scheduled relay fallback for this initiator before delivering the genuine
	// PunchHoleResponse (which carries the target's real punched address).
	if s.cancelPunchFallback(addrStr) {
		log.Printf("[signal] P2P-first: cancelled relay fallback for %s — direct P2P response incoming", addrStr)
	}

	// Try TCP then WebSocket delivery (initiator may be on either transport).
	if s.forwardToInitiator(addrStr, resp) {
		log.Printf("[signal] PunchHoleResponse forwarded to %s (target=%s)", addrStr, phs.Id)
		return
	}

	// UDP delivery — send directly if we came from UDP, or look up the peer.
	if viaUDP {
		s.sendUDP(resp, initiatorAddr)
		log.Printf("[signal] PunchHoleResponse sent via UDP to %s (target=%s)", initiatorAddr, phs.Id)
		return
	}

	// TCP source but no TCP conn for initiator — try peer registry.
	entry := s.peers.FindByIP(initiatorAddr.IP)
	if entry != nil && entry.UDPAddr != nil {
		s.sendUDP(resp, entry.UDPAddr)
		log.Printf("[signal] PunchHoleResponse sent to peer %s at %s via UDP (target=%s)", entry.ID, entry.UDPAddr, phs.Id)
		return
	}

	log.Printf("[signal] PunchHoleResponse: cannot deliver to %s (target=%s)", addrStr, phs.Id)
}

// handleRequestRelay forwards relay setup request to target peer.
func (s *Server) handleRequestRelay(msg *pb.RequestRelay, raddr *net.UDPAddr) {
	targetID := msg.Id

	// Generate UUID if the client sent an empty one. This happens when hole-punch
	// fails after receiving PunchHoleResponse (which has no uuid field) and the
	// client retries with RequestRelay. Without a valid UUID, the relay server
	// rejects both connections.
	relayUUID := msg.Uuid
	if relayUUID == "" {
		relayUUID = uuid.New().String()
		log.Printf("[signal] RequestRelay: client %s sent empty UUID, generated %s", raddr, relayUUID[:8])
	}

	log.Printf("[signal] RequestRelay from %s for target %s (uuid=%s, secure=%v, connType=%v)", raddr, targetID, relayUUID, msg.Secure, msg.ConnType)

	relayServer := s.getRelayServer()
	if msg.RelayServer != "" {
		relayServer = msg.RelayServer
	}

	initiatorID, ok := s.requireAuthorizedInitiator(raddr, targetID, msg.GetToken())
	if !ok {
		s.sendUDP(s.relayUnauthorizedResponse(relayServer), raddr)
		return
	}

	target := s.peers.Get(targetID)

	if target == nil || target.IsExpired(config.RegTimeout) {
		// Target offline — send relay response with failure
		resp := &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_RelayResponse{
				RelayResponse: &pb.RelayResponse{
					RefuseReason: "Target offline",
					RelayServer:  relayServer,
				},
			},
		}
		s.sendUDP(resp, raddr)
		return
	}

	// Reject disabled, banned, or soft-deleted targets as offline.
	if target.Banned || !s.targetAcceptsInboundSession(targetID) {
		log.Printf("[signal] RequestRelay: target %s is unavailable, rejecting", targetID)
		resp := &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_RelayResponse{
				RelayResponse: &pb.RelayResponse{
					RefuseReason: "Target offline",
					RelayServer:  relayServer,
				},
			},
		}
		s.sendUDP(resp, raddr)
		return
	}

	// WebSocket Mode and native TCP/UDP cannot share a relay session (#290).
	initiatorType := peer.ConnUDP
	if initiator := s.peers.Get(initiatorID); initiator != nil {
		initiatorType = initiator.ConnType
	}
	if relayTransportMismatch(initiatorType, target.ConnType) {
		log.Printf("[signal] RequestRelay: protocol mismatch initiator=%s target=%s (%s vs %s)",
			raddr, targetID, initiatorType, target.ConnType)
		resp := &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_RelayResponse{
				RelayResponse: &pb.RelayResponse{
					RefuseReason: refuseRelayProtocolMismatch,
					RelayServer:  relayServer,
				},
			},
		}
		s.sendUDP(resp, raddr)
		return
	}

	if s.billing != nil {
		if check := s.billing.CheckConnection(targetID); !check.Allowed {
			log.Printf("[signal] RequestRelay: billing denied for target %s: %s", targetID, check.Reason)
			resp := &pb.RendezvousMessage{
				Union: &pb.RendezvousMessage_RelayResponse{
					RelayResponse: &pb.RelayResponse{
						RefuseReason: "Billing suspended",
						RelayServer:  relayServer,
					},
				},
			}
			s.sendUDP(resp, raddr)
			return
		}
		if err := s.billing.PrepareRelay(relayUUID, targetID, initiatorID); err != nil {
			log.Printf("[signal] RequestRelay: billing prepare failed: %v", err)
			resp := &pb.RendezvousMessage{
				Union: &pb.RendezvousMessage_RelayResponse{
					RelayResponse: &pb.RelayResponse{
						RefuseReason: "Billing blocked",
						RelayServer:  relayServer,
					},
				},
			}
			s.sendUDP(resp, raddr)
			return
		}
	}
	if !s.authorizeRelayTicket(relayUUID, initiatorID, targetID) {
		s.sendUDP(s.relayTicketRejectedResponse(relayServer), raddr)
		return
	}

	// LAN detection: use server's LAN IP only for genuine LAN cases. Shared
	// public IP peers keep the public relay to avoid NAT hairpin failures (#121).
	relayServer, sameNetwork, hairpin := s.selectPeerRelayServer(relayServer, raddr, target.UDPAddr)
	relayServer = s.applyNetworkRelayPolicy(relayServer, initiatorID, targetID)
	if sameNetwork {
		log.Printf("[signal] RequestRelay LAN detected: %s and %s on same network, relay=%s", raddr.IP, target.UDPAddr.IP, relayServer)
	}
	if hairpin {
		log.Printf("[signal] RequestRelay shared public IP %s detected (issue #121 hairpin) → keeping public relay=%s", raddr.IP, relayServer)
	}

	// Forward relay request to target peer (supports UDP, TCP, and WebSocket targets).
	// NOTE: Must use RequestRelay type, not RelayResponse — RustDesk client's
	// handle_resp() dispatches RequestRelay to create_relay() but drops RelayResponse.
	relayReq := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RequestRelay{
			RequestRelay: &pb.RequestRelay{
				SocketAddr:  crypto.EncodeAddr(raddr),
				Uuid:        relayUUID,
				Id:          msg.Id,
				RelayServer: relayServer,
			},
		},
	}

	// Store the UUID so we can recover it if target responds with empty UUID.
	s.storePendingUUID(targetID, relayUUID)
	s.sendToPeer(targetID, relayReq)

	// Sign the target's PK for E2E encryption verification
	var signedPk []byte
	if len(target.PK) > 0 {
		signed, err := s.kp.SignIdPk(targetID, target.PK)
		if err != nil {
			log.Printf("[signal] Failed to sign PK for %s: %v", targetID, err)
		} else {
			signedPk = signed
			log.Printf("[signal] Signed PK for relay to %s: %d bytes", targetID, len(signedPk))
		}
	}

	// Confirm to initiator with SIGNED public key
	log.Printf("[signal] RequestRelay (UDP): returning RelayResponse to initiator %s (uuid=%s, relay=%s)", raddr, relayUUID[:8], relayServer)
	resp := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RelayResponse{
			RelayResponse: &pb.RelayResponse{
				Uuid:        relayUUID,
				RelayServer: relayServer,
				Union:       &pb.RelayResponse_Pk{Pk: signedPk},
			},
		},
	}
	s.sendUDP(resp, raddr)
}

// handleRequestRelayTCP handles relay setup request over TCP/WS.
//
// Matching the UDP handler behavior: forwards RequestRelay to the target via UDP
// AND sends an immediate RelayResponse to the TCP initiator with the target's
// signed PK, relay server, and UUID.  This ensures the initiator can proceed
// with the relay connection immediately without waiting for the target's response.
//
// Previous behavior (sending nothing back and waiting for the target's
// RelayResponse) caused timeouts for TCP signaling clients (e.g. logged-in users).
//
// initiatorHint is ConnTCP for native TCP signal or ConnWS for WebSocket Mode;
// if the initiator is registered, their stored ConnType wins.
func (s *Server) handleRequestRelayTCP(msg *pb.RequestRelay, raddr *net.UDPAddr, initiatorHint peer.ConnType) *pb.RendezvousMessage {
	if raddr == nil {
		log.Printf("[signal] RequestRelay (TCP): nil address, ignoring")
		return nil
	}
	targetID := msg.Id

	// Generate UUID if the client sent an empty one (see handleRequestRelay comment).
	relayUUID := msg.Uuid
	if relayUUID == "" {
		relayUUID = uuid.New().String()
		log.Printf("[signal] RequestRelay (TCP): client %s sent empty UUID, generated %s", raddr, relayUUID[:8])
	}

	log.Printf("[signal] RequestRelay (TCP) from %s for target %s (uuid=%s, secure=%v, connType=%v)", raddr, targetID, relayUUID, msg.Secure, msg.ConnType)

	relayServer := s.getRelayServer()
	if msg.RelayServer != "" {
		relayServer = msg.RelayServer
	}

	initiatorID, ok := s.requireAuthorizedInitiator(raddr, targetID, msg.GetToken())
	if !ok {
		return s.relayUnauthorizedResponse(relayServer)
	}

	target := s.peers.Get(targetID)

	if target == nil || target.IsExpired(config.RegTimeout) {
		log.Printf("[signal] RequestRelay (TCP): target %s offline", targetID)
		return &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_RelayResponse{
				RelayResponse: &pb.RelayResponse{
					RefuseReason: "Target offline",
					RelayServer:  relayServer,
				},
			},
		}
	}

	// Reject disabled, banned, or soft-deleted targets as offline.
	if target.Banned || !s.targetAcceptsInboundSession(targetID) {
		log.Printf("[signal] RequestRelay (TCP): target %s is unavailable, rejecting", targetID)
		return &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_RelayResponse{
				RelayResponse: &pb.RelayResponse{
					RefuseReason: "Target offline",
					RelayServer:  relayServer,
				},
			},
		}
	}

	// WebSocket Mode and native TCP/UDP cannot share a relay session (#290).
	initiatorType := initiatorHint
	if initiator := s.peers.Get(initiatorID); initiator != nil {
		initiatorType = initiator.ConnType
	}
	if relayTransportMismatch(initiatorType, target.ConnType) {
		log.Printf("[signal] RequestRelay (TCP): protocol mismatch initiator=%s target=%s (%s vs %s)",
			raddr, targetID, initiatorType, target.ConnType)
		return &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_RelayResponse{
				RelayResponse: &pb.RelayResponse{
					RefuseReason: refuseRelayProtocolMismatch,
					RelayServer:  relayServer,
				},
			},
		}
	}
	if !s.authorizeRelayTicket(relayUUID, initiatorID, targetID) {
		return s.relayTicketRejectedResponse(relayServer)
	}

	// LAN detection: use server's LAN IP only for genuine LAN cases. Shared
	// public IP peers keep the public relay to avoid NAT hairpin failures (#121).
	// Only applicable when target has a known UDP address for comparison.
	var sameNetwork, hairpin bool
	relayServer, sameNetwork, hairpin = s.selectPeerRelayServer(relayServer, raddr, target.UDPAddr)
	if sameNetwork {
		log.Printf("[signal] RequestRelay (TCP) LAN detected: %s and %s on same network, relay=%s", raddr.IP, target.UDPAddr.IP, relayServer)
	} else if hairpin {
		log.Printf("[signal] RequestRelay (TCP) shared public IP %s detected (issue #121 hairpin) → keeping public relay=%s", raddr.IP, relayServer)
	} else {
		// Debug: log why LAN detection failed
		if target.UDPAddr == nil {
			log.Printf("[signal] RequestRelay (TCP) LAN check skipped: target %s has no UDPAddr (connType=%s)", targetID, target.ConnType)
		} else {
			log.Printf("[signal] RequestRelay (TCP) LAN check failed: initiator=%s target=%s (isSameNetwork=false)", raddr, target.UDPAddr)
		}
	}

	// Forward RequestRelay to target peer (supports UDP, TCP, and WebSocket targets).
	reqRelay := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RequestRelay{
			RequestRelay: &pb.RequestRelay{
				SocketAddr:         crypto.EncodeAddr(raddr),
				Uuid:               relayUUID,
				Id:                 msg.Id,
				RelayServer:        relayServer,
				Secure:             msg.Secure,
				ConnType:           msg.ConnType,
				Token:              msg.Token,
				ControlPermissions: msg.ControlPermissions,
			},
		},
	}
	// Store the UUID so we can recover it if target responds with empty UUID.
	s.storePendingUUID(targetID, relayUUID)
	s.sendToPeer(targetID, reqRelay)
	log.Printf("[signal] RequestRelay (TCP): forwarded to %s (connType=%s) secure=%v", targetID, target.ConnType, msg.Secure)

	// Sign the target's PK for E2E encryption verification
	var signedPk []byte
	if len(target.PK) > 0 {
		signed, err := s.kp.SignIdPk(targetID, target.PK)
		if err != nil {
			log.Printf("[signal] RequestRelay (TCP): failed to sign PK for %s: %v", targetID, err)
		} else {
			signedPk = signed
			log.Printf("[signal] RequestRelay (TCP): signed PK for %s (%d bytes)", targetID, len(signedPk))
		}
	}

	// Immediate RelayResponse to TCP initiator — matching the UDP handler's behavior.
	log.Printf("[signal] RequestRelay (TCP): returning RelayResponse to initiator %s (uuid=%s, relay=%s)", raddr, relayUUID[:8], relayServer)
	return &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RelayResponse{
			RelayResponse: &pb.RelayResponse{
				Uuid:        relayUUID,
				RelayServer: relayServer,
				Union:       &pb.RelayResponse_Pk{Pk: signedPk},
			},
		},
	}
}

// handleRelayResponseForward forwards a RelayResponse from the target peer to
// the initiator.  The target sends this after receiving PunchHole/RequestRelay
// via UDP: it generates a relay UUID, connects to the relay server, and sends
// RelayResponse to the signal server (TCP) with socket_addr = initiator's
// address.
//
// senderAddr is the address of the TCP connection that sent this RelayResponse
// (the target peer). Used for IP-based PK lookup when the id field is empty.
//
// Following the Rust hbbs behavior:
// 1. Decode socket_addr to get initiator's address (addr_b in Rust)
// 2. Clear socket_addr (initiator doesn't need it)
// 3. Resolve target's PK from id field
// 4. Set pk field (initiator needs this)
// 5. Adjust relay_server if needed
// 6. Forward to initiator via their stored TCP connection (tcpPunchConns)
func (s *Server) handleRelayResponseForward(msg *pb.RendezvousMessage, senderAddr *net.UDPAddr) {
	rr := msg.GetRelayResponse()
	if rr == nil || len(rr.SocketAddr) == 0 {
		return
	}

	initiatorAddr, err := crypto.DecodeAddr(rr.SocketAddr)
	if err != nil {
		log.Printf("[signal] RelayResponse forward: cannot decode socket_addr: %v", err)
		return
	}

	addrStr := normalizeAddrKey(initiatorAddr.String())

	// Look up the target peer to get its public key and sign it (matching Rust's get_pk).
	targetID := rr.GetId()

	// Fallback: if id field is empty (common with some RustDesk client versions),
	// identify the sender by their IP address in the peer map.
	if targetID == "" && senderAddr != nil {
		if n := s.peers.CountByIP(senderAddr.IP); n > 1 {
			log.Printf("[signal] RelayResponse forward: ambiguous IP lookup for %s (%d peers) — cannot resolve empty id", senderAddr.IP, n)
		} else if entry := s.peers.FindByIP(senderAddr.IP); entry != nil {
			targetID = entry.ID
			log.Printf("[signal] RelayResponse forward: resolved sender %s to peer %s via IP lookup", senderAddr, targetID)
		}
	}

	// If the target sent a RelayResponse with an empty UUID, try to recover the
	// original UUID that we sent to the target in RequestRelay/PunchHole. This
	// is critical for relay pairing — the target may have connected to relay with
	// that UUID, but the old RustDesk client doesn't echo it back.
	if rr.Uuid == "" {
		if storedUUID := s.getPendingUUID(targetID); storedUUID != "" {
			rr.Uuid = storedUUID
			log.Printf("[signal] RelayResponse from %s has empty UUID — recovered original %s from pending store", senderAddr, storedUUID[:8])
		} else {
			// Last resort: generate a new UUID. This will likely fail relay pairing
			// because target already connected with different (empty?) UUID.
			rr.Uuid = uuid.New().String()
			log.Printf("[signal] WARNING: RelayResponse from %s has empty UUID and no pending UUID found — generated %s (relay pairing may fail)", senderAddr, rr.Uuid[:8])
		}
	}

	// Resolve the initiator so we can mint a relay ticket before advertising the
	// UUID. Without this, P2P→relay fallback forwards a RelayResponse that the
	// hardened relay rejects as "Unauthorized relay UUID" (#356).
	initiatorID := s.peerIDForAddr(initiatorAddr)
	if initiatorID == "" && initiatorAddr != nil {
		if n := s.peers.CountByIP(initiatorAddr.IP); n > 1 {
			log.Printf("[signal] RelayResponse forward: ambiguous initiator IP lookup for %s (%d peers)", initiatorAddr.IP, n)
		} else if entry := s.peers.FindByIP(initiatorAddr.IP); entry != nil {
			initiatorID = entry.ID
			log.Printf("[signal] RelayResponse forward: resolved initiator %s to peer %s via IP lookup", initiatorAddr, initiatorID)
		}
	}
	if targetID == "" || initiatorID == "" {
		log.Printf("[signal] RelayResponse forward: refusing uuid=%q — unresolved pair (initiator=%q target=%q sender=%s)",
			rr.Uuid, initiatorID, targetID, senderAddr)
		return
	}
	if !s.authorizeRelayTicket(rr.Uuid, initiatorID, targetID) {
		log.Printf("[signal] RelayResponse forward: relay ticket rejected (uuid=%q initiator=%q target=%q) — not forwarding",
			rr.Uuid, initiatorID, targetID)
		return
	}

	var signedPk []byte
	if target := s.peers.Get(targetID); target != nil && len(target.PK) > 0 {
		// Sign the PK with server's Ed25519 key (enables client E2E verification)
		signed, err := s.kp.SignIdPk(targetID, target.PK)
		if err != nil {
			log.Printf("[signal] Failed to sign PK for %s in RelayResponse: %v", targetID, err)
		} else {
			signedPk = signed
			log.Printf("[signal] Signed PK for %s in RelayResponse: %d bytes", targetID, len(signedPk))
		}
	}

	if len(signedPk) == 0 {
		log.Printf("[signal] WARNING: RelayResponse forward — no PK available for target %q (sender=%s)", targetID, senderAddr)
	}

	// Modify the RelayResponse in-place (matching Rust hbbs behavior).
	rr.SocketAddr = nil
	rr.SocketAddrV6 = nil

	// LAN detection: use LAN relay only for genuine LAN cases. Shared public IP
	// peers keep the public relay to avoid NAT hairpin failures (#121).
	relayServer := s.getRelayServer()
	relayServer, sameNetwork, hairpin := s.selectPeerRelayServer(relayServer, senderAddr, initiatorAddr)
	if sameNetwork {
		log.Printf("[signal] RelayResponse LAN detected: %s and %s on same network, relay=%s", senderAddr.IP, initiatorAddr.IP, relayServer)
	}
	if hairpin && senderAddr != nil {
		log.Printf("[signal] RelayResponse shared public IP %s detected (issue #121 hairpin) → keeping public relay=%s", senderAddr.IP, relayServer)
	}
	rr.RelayServer = relayServer

	// Replace union: id → SIGNED pk (initiator needs target's signed public key)
	rr.Union = &pb.RelayResponse_Pk{Pk: signedPk}

	initiatorResp := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RelayResponse{
			RelayResponse: rr,
		},
	}

	// Primary delivery: TCP punch map or WebSocket peer (#276).
	if s.forwardToInitiator(addrStr, initiatorResp) {
		log.Printf("[signal] RelayResponse forwarded to %s (uuid=%s, relay=%s, signedPk=%d bytes)", addrStr, rr.Uuid, relayServer, len(signedPk))
		return
	}

	// Fallback: peer-map lookup by IP → forward via registered UDP address.
	entry := s.peers.FindByIP(initiatorAddr.IP)
	if entry != nil && entry.UDPAddr != nil {
		s.sendUDP(initiatorResp, entry.UDPAddr)
		log.Printf("[signal] RelayResponse forwarded to peer %s at %s via UDP (uuid=%s, relay=%s, signedPk=%d bytes)", entry.ID, entry.UDPAddr, rr.Uuid, relayServer, len(signedPk))
		return
	}

	log.Printf("[signal] RelayResponse: cannot deliver to %s (no TCP conn, no peer match, uuid=%s)", addrStr, rr.Uuid)
}

// handleFetchLocalAddr forwards a local address fetch request to the target peer.
// The FetchLocalAddr message carries socket_addr (who is asking), not an ID.
// We decode the socket_addr to identify the requester's origin, then forward.
func (s *Server) handleFetchLocalAddr(msg *pb.FetchLocalAddr, raddr *net.UDPAddr) {
	// FetchLocalAddr contains the target's socket_addr from a previous PunchHole.
	// We forward the request to the peer at that address, including the requester's addr.
	targetAddr, err := crypto.DecodeAddr(msg.SocketAddr)
	if err != nil || targetAddr == nil {
		return
	}

	// Forward to target with requester's address
	fetch := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_FetchLocalAddr{
			FetchLocalAddr: &pb.FetchLocalAddr{
				SocketAddr: crypto.EncodeAddr(raddr),
			},
		},
	}
	s.sendUDP(fetch, targetAddr)
}

// handleLocalAddr forwards a LocalAddr response from the target peer back to the
// requester. This completes the FetchLocalAddr→LocalAddr exchange needed for LAN
// direct connections.
func (s *Server) handleLocalAddr(msg *pb.LocalAddr, raddr *net.UDPAddr) {
	// socket_addr identifies the original requester that initiated FetchLocalAddr.
	requesterAddr, err := crypto.DecodeAddr(msg.SocketAddr)
	if err != nil || requesterAddr == nil {
		return
	}

	// Forward the LocalAddr (with the responder's local address) to the requester.
	resp := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_LocalAddr{
			LocalAddr: &pb.LocalAddr{
				SocketAddr:   crypto.EncodeAddr(raddr),
				LocalAddr:    msg.LocalAddr,
				RelayServer:  msg.RelayServer,
				Id:           msg.Id,
				Version:      msg.Version,
				SocketAddrV6: msg.SocketAddrV6,
			},
		},
	}
	s.sendUDP(resp, requesterAddr)
}

// handleTestNat handles NAT type detection (TCP port 21115).
// M8: Also sends ConfigUpdate with relay/rendezvous server info for clients ≥1.3.x.
func (s *Server) handleTestNat(msg *pb.TestNatRequest, raddr net.Addr) *pb.RendezvousMessage {
	// Extract the source port from the remote address
	tcpAddr, ok := raddr.(*net.TCPAddr)
	if !ok {
		return nil
	}

	resp := &pb.TestNatResponse{
		Port: int32(tcpAddr.Port),
	}

	// M8: Include ConfigUpdate so clients ≥1.3.x learn about relay/rendezvous
	// servers. This allows dynamic server reconfiguration without client-side changes.
	rendezvousServers := s.cfg.GetRelayServers()
	if s.cfg.RendezvousServers != "" {
		for _, srv := range splitAndTrim(s.cfg.RendezvousServers) {
			rendezvousServers = append(rendezvousServers, srv)
		}
	}
	if len(rendezvousServers) > 0 {
		resp.Cu = &pb.ConfigUpdate{
			Serial:            msg.Serial + 1,
			RendezvousServers: rendezvousServers,
		}
	}

	return &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_TestNatResponse{
			TestNatResponse: resp,
		},
	}
}

// splitAndTrim splits a comma-separated string and trims whitespace from each element.
func splitAndTrim(s string) []string {
	parts := make([]string, 0)
	for _, p := range regexp.MustCompile(`\s*,\s*`).Split(s, -1) {
		if p != "" {
			parts = append(parts, p)
		}
	}
	return parts
}

// handleOnlineRequest checks which peers are online (TCP port 21115).
func (s *Server) handleOnlineRequest(msg *pb.OnlineRequest) *pb.RendezvousMessage {
	states := s.peers.OnlineStates(msg.Peers, config.RegTimeout)

	return &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_OnlineResponse{
			OnlineResponse: &pb.OnlineResponse{
				States: states,
			},
		},
	}
}

// sendRelayResponse sends relay-only response to the initiator when direct connection is skipped.
// The target's public key is signed with the server's Ed25519 key (NaCl combined format)
// so the initiator can verify the target's identity for E2E encryption.
func (s *Server) sendRelayResponse(target *peer.Entry, raddr *net.UDPAddr, msg *pb.PunchHoleRequest, relay, initiatorID string) {
	// Generate a relay session UUID for pairing both peers at hbbr.
	relayUUID := uuid.New().String()
	if !s.authorizeRelayTicket(relayUUID, initiatorID, target.ID) {
		s.sendUDP(s.relayTicketRejectedResponse(relay), raddr)
		return
	}

	// Sign the target's PK with server's Ed25519 key for E2E verification.
	// Format: [64-byte Ed25519 signature][serialized IdPk protobuf] — NaCl combined mode.
	// Without signing, clients cannot verify target identity and E2E will fail.
	var signedPk []byte
	if len(target.PK) > 0 {
		signed, err := s.kp.SignIdPk(target.ID, target.PK)
		if err != nil {
			log.Printf("[signal] sendRelayResponse: failed to sign PK for %s: %v", target.ID, err)
		} else {
			signedPk = signed
			log.Printf("[signal] sendRelayResponse: signed PK for %s (%d bytes)", target.ID, len(signedPk))
		}
	}

	// Send RelayResponse (NOT PunchHoleResponse) to the initiator.
	// RelayResponse contains the UUID field required by hbbr for session pairing.
	// PunchHoleResponse does not have a uuid field, so clients would send
	// RequestRelay with an empty UUID, causing hbbr to reject the connection.
	resp := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RelayResponse{
			RelayResponse: &pb.RelayResponse{
				Uuid:        relayUUID,
				RelayServer: relay,
				Union:       &pb.RelayResponse_Pk{Pk: signedPk},
			},
		},
	}
	s.sendUDP(resp, raddr)

	// Forward RequestRelay to the target so it connects to hbbr with the same UUID.
	reqRelay := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RequestRelay{
			RequestRelay: &pb.RequestRelay{
				Id:          msg.Id,
				Uuid:        relayUUID,
				SocketAddr:  crypto.EncodeAddr(raddr),
				RelayServer: relay,
				Secure:      false,
				ConnType:    msg.ConnType,
			},
		},
	}
	if target.UDPAddr != nil {
		// Store the UUID so we can recover it if target responds with empty UUID.
		s.storePendingUUID(target.ID, relayUUID)
		s.sendUDP(reqRelay, target.UDPAddr)
		log.Printf("[signal] sendRelayResponse: forwarded RequestRelay to target %s at %s (uuid=%s)", target.ID, target.UDPAddr, relayUUID[:8])
	}
}

func (s *Server) peerIDForAddr(raddr *net.UDPAddr) string {
	if raddr == nil || s.peers == nil {
		return ""
	}
	if p := s.peers.FindByAddr(raddr); p != nil {
		return p.ID
	}
	if id := s.tcpSessionPeerID(raddr); id != "" {
		return id
	}
	return ""
}

// punchHoleUnauthorizedResponse refuses outbound PunchHole when the initiator
// is not an authorized peer (#302).
func (s *Server) punchHoleUnauthorizedResponse() *pb.RendezvousMessage {
	return &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_PunchHoleResponse{
			PunchHoleResponse: &pb.PunchHoleResponse{
				Failure: pb.PunchHoleResponse_ID_NOT_EXIST,
			},
		},
	}
}

// relayUnauthorizedResponse refuses outbound RequestRelay when the initiator
// is not an authorized peer (#302).
func (s *Server) relayUnauthorizedResponse(relayServer string) *pb.RendezvousMessage {
	return &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RelayResponse{
			RelayResponse: &pb.RelayResponse{
				RefuseReason: refuseInitiatorNotAuthorized,
				RelayServer:  relayServer,
			},
		},
	}
}

// relayTicketRejectedResponse avoids advertising a relay UUID that has not been
// accepted by the server-side relay authorization registry.
func (s *Server) relayTicketRejectedResponse(relayServer string) *pb.RendezvousMessage {
	return &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RelayResponse{
			RelayResponse: &pb.RelayResponse{
				RefuseReason: "Relay authorization rejected",
				RelayServer:  relayServer,
			},
		},
	}
}

func (s *Server) authorizeRelayTicket(relayUUID, initiatorID, targetID string) bool {
	if relay.AuthorizeRelayPair(relayUUID, initiatorID, targetID) {
		return true
	}
	log.Printf("[signal] Rejected relay authorization (uuid=%q initiator=%q target=%q)",
		relayUUID, initiatorID, targetID)
	return false
}

// requireAuthorizedInitiator enforces that PunchHole/RequestRelay may only be
// started by an authorized initiator (#302 / #327), or by the Node panel Web
// Remote proxy (trusted PANEL_SIGNAL_PROXY_CIDRS — typically loopback).
//
// Authorization sources (first match wins):
//  1. Same Secure TCP session that already completed RegisterPk (#327)
//  2. Valid BetterDesk client login token on the punch/relay message (#327)
//  3. Panel signal-proxy CIDR (Web Remote)
//  4. Live peer with exact ip:port match (FindByAddr)
//  5. Exactly one live peer at the same public IP (safe FindByIP fallback for
//     stock clients that PunchHole on a new TCP port). Multiple live peers at
//     that IP → initiator_ambiguous_same_nat (no identity inheritance, #302)
//
// Managed and locked modes additionally require an approved DB peer row (pending
// enrollment alone is not enough). Panel proxy initiators skip peer-map / DB
// checks: operator auth is enforced at the panel WS upgrade before TCP is
// bridged to hbbs.
func (s *Server) requireAuthorizedInitiator(raddr *net.UDPAddr, targetID, token string) (string, bool) {
	if raddr == nil {
		return "", false
	}

	// 1. Same TCP session after RegisterPk (viewer-only / secure TCP, #327).
	if id := s.tcpSessionPeerID(raddr); id != "" {
		banned := false
		if e := s.peers.Get(id); e != nil {
			banned = e.Banned
		}
		return s.finalizeAuthorizedInitiator(id, raddr, targetID, banned)
	}

	// 2. Opaque client login token — hard-fail when present so we never fall
	// through to address matching with a different peer identity.
	if tok := strings.TrimSpace(token); tok != "" && opaqueClientTokenRegexp.MatchString(tok) {
		if id, ok := s.authorizeViaClientToken(tok, raddr, targetID); ok {
			return id, true
		}
		return "", false
	}

	// 3. Panel Web Remote proxy (loopback / PANEL_SIGNAL_PROXY_CIDRS).
	if s.cfg != nil && s.cfg.IPIsPanelSignalProxy(raddr.IP) {
		return panelWebRemoteInitiatorID, true
	}

	// 4. Exact registered endpoint (ip:port).
	initiator := s.peers.FindByAddr(raddr)
	if initiator != nil && !initiator.IsExpired(config.RegTimeout) {
		return s.finalizeAuthorizedInitiator(initiator.ID, raddr, targetID, initiator.Banned)
	}

	// 5. Safe IP-only fallback: stock RustDesk opens PunchHole on a new TCP
	// port after RegisterPk/UDP heartbeat, so FindByAddr misses. Authorize only
	// when exactly one live peer shares this public IP.
	var live []*peer.Entry
	for _, e := range s.peers.FindAllByIP(raddr.IP) {
		if e != nil && !e.IsExpired(config.RegTimeout) {
			live = append(live, e)
		}
	}
	switch len(live) {
	case 0:
		s.logUnauthorizedInitiator(raddr, "", targetID, "initiator_not_registered")
		return "", false
	case 1:
		return s.finalizeAuthorizedInitiator(live[0].ID, raddr, targetID, live[0].Banned)
	default:
		s.logUnauthorizedInitiator(raddr, "", targetID, "initiator_ambiguous_same_nat")
		return "", false
	}
}

// bindTCPSessionPeer records the peer ID on an open tcpPunchConn so a later
// PunchHole on the same Secure TCP session can authorize without UDP heartbeats.
func (s *Server) bindTCPSessionPeer(addrStr, peerID string) {
	if addrStr == "" || peerID == "" {
		return
	}
	key := normalizeAddrKey(addrStr)
	if val, ok := s.tcpPunchConns.Load(key); ok {
		pc := val.(*tcpPunchConn)
		pc.peerID = peerID
	}
}

// tcpSessionPeerID returns the peer ID bound to the TCP punch connection for raddr.
func (s *Server) tcpSessionPeerID(raddr *net.UDPAddr) string {
	if raddr == nil {
		return ""
	}
	key := normalizeAddrKey(raddr.String())
	val, ok := s.tcpPunchConns.Load(key)
	if !ok {
		return ""
	}
	pc := val.(*tcpPunchConn)
	return pc.peerID
}

var opaqueClientTokenRegexp = regexp.MustCompile(`(?i)^[a-f0-9]{64}$`)

func hashOpaqueClientToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// authorizeViaClientToken accepts PunchHole/RequestRelay when the stock RustDesk
// client sends a BetterDesk opaque login token (service may be stopped, #327).
func (s *Server) authorizeViaClientToken(token string, raddr *net.UDPAddr, targetID string) (string, bool) {
	token = strings.TrimSpace(token)
	if token == "" || s.db == nil || !opaqueClientTokenRegexp.MatchString(token) {
		return "", false
	}
	sess, err := s.db.GetClientSessionByTokenHash(hashOpaqueClientToken(token))
	if err != nil || sess == nil {
		s.logUnauthorizedInitiator(raddr, "", targetID, "initiator_token_rejected")
		return "", false
	}
	initiatorID := strings.TrimSpace(sess.ClientID)
	if initiatorID == "" {
		// Logged-in but device id unknown — open mode only (no enrollment claim).
		mode := s.cfg.EnrollmentMode
		if mode == "" {
			mode = config.EnrollmentModeOpen
		}
		if mode == config.EnrollmentModeManaged || mode == config.EnrollmentModeLocked {
			s.logUnauthorizedInitiator(raddr, "", targetID, "initiator_session_no_device")
			return "", false
		}
		return fmt.Sprintf("session-user-%d", sess.UserID), true
	}
	// Token initiators must always consult the persisted ban state, including
	// open enrollment mode. Memory entries are cleared on restart and cannot be
	// the authority for a revocation decision.
	banned, err := s.db.IsPeerBanned(initiatorID)
	if err != nil {
		s.logUnauthorizedInitiator(raddr, initiatorID, targetID, "initiator_ban_check_failed")
		return "", false
	}
	if banned {
		s.revokeBannedPeerAccess(initiatorID, sess)
		s.logUnauthorizedInitiator(raddr, initiatorID, targetID, "initiator_banned")
		return "", false
	}
	return s.finalizeAuthorizedInitiator(initiatorID, raddr, targetID, false)
}

// finalizeAuthorizedInitiator applies ban / soft-delete / enrollment checks shared
// by live-peer and token-based authorization paths.
func (s *Server) finalizeAuthorizedInitiator(initiatorID string, raddr *net.UDPAddr, targetID string, memoryBanned bool) (string, bool) {
	if memoryBanned {
		s.revokeBannedPeerAccess(initiatorID, nil)
		s.logUnauthorizedInitiator(raddr, initiatorID, targetID, "initiator_banned")
		return "", false
	}
	if s.db != nil {
		banned, err := s.db.IsPeerBanned(initiatorID)
		if err != nil {
			s.logUnauthorizedInitiator(raddr, initiatorID, targetID, "initiator_ban_check_failed")
			return "", false
		}
		if banned {
			s.revokeBannedPeerAccess(initiatorID, nil)
			s.logUnauthorizedInitiator(raddr, initiatorID, targetID, "initiator_banned")
			return "", false
		}
		if softDeleted, _ := s.db.IsPeerSoftDeleted(initiatorID); softDeleted {
			s.logUnauthorizedInitiator(raddr, initiatorID, targetID, "initiator_soft_deleted")
			return "", false
		}
		// Defense in depth: still queued for approval must not initiate (#302 residual).
		if pending, _ := s.db.GetConfig("pending_device_" + initiatorID); pending != "" {
			s.logUnauthorizedInitiator(raddr, initiatorID, targetID, "initiator_pending_enrollment")
			return "", false
		}
	}

	mode := s.cfg.EnrollmentMode
	if mode == "" {
		mode = config.EnrollmentModeOpen
	}
	if mode == config.EnrollmentModeManaged || mode == config.EnrollmentModeLocked {
		if s.db == nil {
			s.logUnauthorizedInitiator(raddr, initiatorID, targetID, "initiator_not_enrolled")
			return "", false
		}
		dbPeer, err := s.db.GetPeer(initiatorID)
		if err != nil || dbPeer == nil {
			s.logUnauthorizedInitiator(raddr, initiatorID, targetID, "initiator_not_enrolled")
			return "", false
		}
		if isInboundOnlyPeer(dbPeer) {
			s.logUnauthorizedInitiator(raddr, initiatorID, targetID, "initiator_inbound_only_device")
			return "", false
		}
	} else if s.db != nil {
		// Open mode still needs to prevent an approved support/OS agent from
		// initiating connections. Do not rely on the in-memory peer map: it
		// does not carry durable device_type metadata.
		dbPeer, err := s.db.GetPeer(initiatorID)
		if err != nil {
			s.logUnauthorizedInitiator(raddr, initiatorID, targetID, "initiator_type_lookup_failed")
			return "", false
		}
		if isInboundOnlyPeer(dbPeer) {
			s.logUnauthorizedInitiator(raddr, initiatorID, targetID, "initiator_inbound_only_device")
			return "", false
		}
	}

	return initiatorID, true
}

func (s *Server) logUnauthorizedInitiator(raddr *net.UDPAddr, initiatorID, targetID, reason string) {
	clientHost := ""
	if raddr != nil {
		clientHost = raddr.IP.String()
	}
	log.Printf("[signal] Rejected outbound from %s (initiator=%q target=%q reason=%s)",
		clientHost, initiatorID, targetID, reason)
	if s.auditLog == nil {
		return
	}
	details := map[string]string{"reason": reason}
	if initiatorID != "" {
		details["initiator_id"] = initiatorID
	}
	if targetID != "" {
		details["target_id"] = targetID
	}
	s.auditLog.Log(audit.ActionConnectionDenied, clientHost, targetID, details)
}

func (s *Server) shouldForceRelayForPeers(peerIDs ...string) bool {
	if s.networkPolicy == nil {
		return false
	}
	return s.networkPolicy.ShouldForceRelay(peerIDs...)
}

func (s *Server) applyNetworkRelayPolicy(defaultRelay string, peerIDs ...string) string {
	if s.networkPolicy == nil {
		return defaultRelay
	}
	return s.networkPolicy.ResolveRelay(defaultRelay, peerIDs...)
}

// getRelayServer returns the relay server address to advertise to clients.
// Priority:
//  1. Explicitly configured relay servers (-relay-servers flag / RELAY_SERVERS env)
//  2. Server's detected public IP + relay port (auto-detected via external service)
//  3. LAN IP + relay port (from OS routing table — works for LAN-only setups)
//
// Never returns bare ":port" — that is unusable by remote clients.
func (s *Server) getRelayServer() string {
	relays := s.cfg.GetRelayServers()
	if len(relays) > 0 {
		return relays[0]
	}
	// Use auto-detected public IP if available
	if ip, ok := s.localIP.Load().(string); ok && ip != "" {
		return fmt.Sprintf("%s:%d", ip, s.cfg.RelayPort)
	}
	// Last resort: use LAN IP (better than bare port which is unusable)
	if ip, ok := s.lanIP.Load().(string); ok && ip != "" {
		return fmt.Sprintf("%s:%d", ip, s.cfg.RelayPort)
	}
	// Should not happen — detectLocalIP always detects LAN IP
	log.Printf("[signal] WARN: No relay address available — remote connections will fail")
	return fmt.Sprintf(":%d", s.cfg.RelayPort)
}

// getLANRelayServer returns the relay server address suitable for LAN peers.
// Uses the server's detected LAN IP (from OS routing table) rather than public IP.
// This ensures LAN peers can reach the relay without NAT hairpin support.
func (s *Server) getLANRelayServer(defaultRelay string, peers ...*net.UDPAddr) string {
	if defaultRelay == "" {
		defaultRelay = s.getRelayServer()
	}

	// For LAN peers, prefer the server's LAN IP only when it is actually in the
	// peers' private subnet. NAT hairpin (LAN → public IP → LAN) is unreliable
	// on many routers (#102), but Docker bridge IPs are not reachable from LAN
	// clients and must not be advertised as relay addresses (#142).
	if ip, ok := s.lanIP.Load().(string); ok && ip != "" {
		lanIP := net.ParseIP(ip)
		if !isLANRelayReachableFromPeers(lanIP, peers...) {
			log.Printf("[signal] LAN relay %s is outside peer subnet; using configured/default relay=%s", ip, defaultRelay)
			return defaultRelay
		}

		// Determine relay port: prefer admin-configured port, fall back to default.
		relayPort := s.cfg.RelayPort
		relays := s.cfg.GetRelayServers()
		if len(relays) > 0 {
			if _, portStr, err := net.SplitHostPort(relays[0]); err == nil {
				if p, err := strconv.Atoi(portStr); err == nil && p > 0 {
					relayPort = p
				}
			}
		}
		return fmt.Sprintf("%s:%d", ip, relayPort)
	}
	// LAN IP unknown — fall back to configured/default relay.
	return defaultRelay
}

func (s *Server) selectPeerRelayServer(defaultRelay string, a, b *net.UDPAddr) (relay string, sameLAN bool, samePublicIP bool) {
	if defaultRelay == "" {
		defaultRelay = s.getRelayServer()
	}
	if a == nil || b == nil {
		return defaultRelay, false, false
	}

	if s.cfg.SameNATRelay && isSamePublicIP(a, b) {
		return s.getRelayServer(), false, true
	}
	if isSameNetwork(a, b) {
		return s.getLANRelayServer(defaultRelay, a, b), true, false
	}
	return defaultRelay, false, false
}

func isLANRelayReachableFromPeers(lanIP net.IP, peers ...*net.UDPAddr) bool {
	lan4 := lanIP.To4()
	if lan4 == nil || !isPrivateIP(lan4) {
		return false
	}
	for _, peerAddr := range peers {
		if peerAddr == nil {
			continue
		}
		peer4 := peerAddr.IP.To4()
		if peer4 == nil || peer4.IsLoopback() || !isPrivateIP(peer4) {
			continue
		}
		if lan4.Equal(peer4) || (lan4[0] == peer4[0] && lan4[1] == peer4[1] && lan4[2] == peer4[2]) {
			return true
		}
	}
	return false
}

// registerPkResponse is a helper to create a RegisterPkResponse message.
func registerPkResponse(result pb.RegisterPkResponse_Result) *pb.RendezvousMessage {
	return &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RegisterPkResponse{
			RegisterPkResponse: &pb.RegisterPkResponse{
				Result: result,
			},
		},
	}
}

// isSameNetwork returns true if both addresses are on the same LAN or behind
// the same NAT. Used for LAN detection to enable direct local connections.
//
// Matches the original Rust hbbs logic:
//
//	is_local = (both private IPv4 && same /24 subnet) || (same IP)
//
// Extended: Loopback (127.x.x.x, ::1) connecting to a private IP target is
// considered "same network" because the server is local and both are LAN peers.
func isSameNetwork(a, b *net.UDPAddr) bool {
	if a == nil || b == nil {
		log.Printf("[LAN] isSameNetwork: nil address (a=%v, b=%v)", a, b)
		return false
	}

	// Normalize to IPv4 if possible (handles ::ffff:x.x.x.x mapped addresses)
	aIP := a.IP
	bIP := b.IP
	if a4 := a.IP.To4(); a4 != nil {
		aIP = a4
	}
	if b4 := b.IP.To4(); b4 != nil {
		bIP = b4
	}

	// Same IP — behind the same NAT, or same machine
	if aIP.Equal(bIP) {
		log.Printf("[LAN] isSameNetwork: same IP (%v) → true", aIP)
		return true
	}

	// Loopback detection: if initiator is 127.x or ::1 and target is private IP,
	// treat as same network. This happens when web client or local app connects
	// to localhost server while target is on LAN.
	aLoopback := aIP.IsLoopback()
	bPrivate := isPrivateIP(bIP)
	log.Printf("[LAN] isSameNetwork check: a=%v (loopback=%v), b=%v (private=%v)", aIP, aLoopback, bIP, bPrivate)

	if aLoopback && bPrivate {
		log.Printf("[LAN] isSameNetwork: loopback→private → true")
		return true
	}
	if bIP.IsLoopback() && isPrivateIP(aIP) {
		log.Printf("[LAN] isSameNetwork: private←loopback → true")
		return true
	}

	// Both private IPv4 on the same /24 subnet — same LAN
	a4 := aIP.To4()
	b4 := bIP.To4()
	if a4 != nil && b4 != nil && isPrivateIP(a4) && isPrivateIP(b4) {
		sameSubnet := a4[0] == b4[0] && a4[1] == b4[1] && a4[2] == b4[2]
		if sameSubnet {
			log.Printf("[LAN] isSameNetwork: same /24 subnet (%v, %v) → true", a4, b4)
			return true
		}
	}

	log.Printf("[LAN] isSameNetwork: no match → false")
	return false
}

// isSamePublicIP returns true when both peers connect from the exact same
// non-private IP address.  This is the classic "behind the same NAT gateway"
// scenario: many consumer/cellular routers refuse hairpin NAT, so direct LAN
// exchange between such peers silently times out.  When this returns true the
// signal handler should force the relay path (issue #121).
func isSamePublicIP(a, b *net.UDPAddr) bool {
	if a == nil || b == nil {
		return false
	}
	aIP := a.IP
	bIP := b.IP
	if a4 := aIP.To4(); a4 != nil {
		aIP = a4
	}
	if b4 := bIP.To4(); b4 != nil {
		bIP = b4
	}
	if !aIP.Equal(bIP) {
		return false
	}
	// Only treat genuinely public addresses as a hairpin scenario; same-LAN
	// peers (private IPs) keep the existing direct path.
	return !isPrivateIP(aIP) && !aIP.IsLoopback() && !aIP.IsUnspecified()
}

// isPrivateIP returns true if the IP is in a private/local range.
// Handles both 4-byte and 16-byte IP representations.
func isPrivateIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	// Normalize to 4-byte IPv4 if possible
	if ip4 := ip.To4(); ip4 != nil {
		ip = ip4
	}
	privateRanges := []struct {
		network *net.IPNet
	}{
		{mustParseCIDR("10.0.0.0/8")},
		{mustParseCIDR("172.16.0.0/12")},
		{mustParseCIDR("192.168.0.0/16")},
		{mustParseCIDR("fc00::/7")},
	}
	for _, r := range privateRanges {
		if r.network.Contains(ip) {
			return true
		}
	}
	return ip.IsLoopback() || ip.IsLinkLocalUnicast()
}

func mustParseCIDR(s string) *net.IPNet {
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		panic(err)
	}
	return n
}

// rejectIfPeerSoftDeleted rejects registration for administrator-removed peers.
// SECURITY (GHSA-3v82-3gf8-fxx8): soft-deleted IDs must not re-enroll via any
// signal path; restoration is explicit via the API/UI only.
func (s *Server) rejectIfPeerSoftDeleted(id, clientHost string) bool {
	if softDeleted, _ := s.db.IsPeerSoftDeleted(id); softDeleted {
		log.Printf("[signal] Rejected registration of deleted peer: %s from %s", id, clientHost)
		if s.auditLog != nil {
			s.auditLog.Log(audit.ActionPeerRegistrationRejected, clientHost, id, map[string]string{
				"reason": "soft_deleted",
			})
		}
		return true
	}
	return false
}

// checkEnrollmentPermission implements the Dual Key System enrollment policy.
// Returns true if the peer is allowed to register, false otherwise.
//
// Modes:
//   - "open" (default): All devices can register
//   - "managed": New devices need to be pre-approved (exist in DB) or have a token
//   - "locked": Only devices with a valid token binding can register
func (s *Server) checkEnrollmentPermission(peerID, clientIP string) bool {
	mode := s.cfg.EnrollmentMode
	if mode == "" {
		mode = config.EnrollmentModeOpen
	}

	// Open mode — always allow (backward compatible)
	if mode == config.EnrollmentModeOpen {
		return true
	}

	// Check if peer already exists in database (re-registration is always allowed)
	if existingPeer, err := s.db.GetPeer(peerID); err == nil && existingPeer != nil {
		return true
	}

	// Managed mode — allow if there's a pending token with this peer ID pre-bound
	// Admin can pre-bind tokens to specific peer IDs before they register
	if mode == config.EnrollmentModeManaged {
		if token, err := s.db.GetDeviceTokenByPeerID(peerID); err == nil && token != nil {
			if token.Status == db.TokenStatusPending || token.Status == db.TokenStatusActive {
				// Token is valid — activate and bind to peer
				log.Printf("[signal] Enrollment: peer %s matched token %s (managed mode)", peerID, token.Name)
				return true
			}
		}
		// In managed mode, unknown devices are placed into the pending
		// enrollment queue so an operator can review and approve/reject them.
		// The connection is still denied until approval.
		s.recordPendingEnrollment(peerID, clientIP, pendingEnrollmentMeta{})
		log.Printf("[signal] Enrollment: queued unknown peer %s for approval (managed mode)", peerID)
		return false
	}

	// Locked mode — only devices with a valid token binding can register
	if mode == config.EnrollmentModeLocked {
		if token, err := s.db.GetDeviceTokenByPeerID(peerID); err == nil && token != nil {
			if token.Status == db.TokenStatusPending || token.Status == db.TokenStatusActive {
				log.Printf("[signal] Enrollment: peer %s matched token %s (locked mode)", peerID, token.Name)
				return true
			}
		}
		log.Printf("[signal] Enrollment: rejected peer %s (locked mode, no valid token)", peerID)
		return false
	}

	return true
}

// pendingEnrollmentInfo mirrors the JSON schema used by the API package
// (pendingDeviceInfo) so that entries created here are readable by the
// enrollment approve/list handlers.
type pendingEnrollmentInfo struct {
	DeviceID  string `json:"device_id"`
	Hostname  string `json:"hostname"`
	Platform  string `json:"platform"`
	Version   string `json:"version"`
	IP        string `json:"ip"`
	CreatedAt string `json:"created_at"`
}

// pendingEnrollmentMeta carries optional display fields when available.
// Stock RustDesk RegisterPeer/RegisterPk do not include these; a later HTTP
// enrollment or enriching call may supply them (#351).
type pendingEnrollmentMeta struct {
	Hostname string
	Platform string
	Version  string
}

// recordPendingEnrollment stores an unknown peer in the pending enrollment
// queue (server_config key "pending_device_<id>") so operators can review it.
// Existing created_at is preserved; empty hostname/platform/version may be
// filled when later metadata arrives. Already-rejected devices are never re-queued.
func (s *Server) recordPendingEnrollment(peerID, clientIP string, meta pendingEnrollmentMeta) {
	if s.db == nil {
		return
	}

	// Never re-queue a device that was explicitly rejected.
	if v, err := s.db.GetConfig("rejected_device_" + peerID); err == nil && v != "" {
		return
	}

	key := "pending_device_" + peerID
	if v, err := s.db.GetConfig(key); err == nil && v != "" {
		var existing pendingEnrollmentInfo
		if json.Unmarshal([]byte(v), &existing) != nil {
			return
		}
		changed := false
		if existing.Hostname == "" && meta.Hostname != "" {
			existing.Hostname = meta.Hostname
			changed = true
		}
		if existing.Platform == "" && meta.Platform != "" {
			existing.Platform = meta.Platform
			changed = true
		}
		if existing.Version == "" && meta.Version != "" {
			existing.Version = meta.Version
			changed = true
		}
		if existing.IP == "" && clientIP != "" {
			existing.IP = clientIP
			changed = true
		}
		if !changed {
			return
		}
		data, mErr := json.Marshal(existing)
		if mErr != nil {
			log.Printf("[signal] recordPendingEnrollment: marshal enrich failed for %s: %v", peerID, mErr)
			return
		}
		if err := s.db.SetConfig(key, string(data)); err != nil {
			log.Printf("[signal] recordPendingEnrollment: enrich store failed for %s: %v", peerID, err)
		}
		return
	}

	info := pendingEnrollmentInfo{
		DeviceID:  peerID,
		Hostname:  meta.Hostname,
		Platform:  meta.Platform,
		Version:   meta.Version,
		IP:        clientIP,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	data, err := json.Marshal(info)
	if err != nil {
		log.Printf("[signal] recordPendingEnrollment: marshal failed for %s: %v", peerID, err)
		return
	}
	if err := s.db.SetConfig(key, string(data)); err != nil {
		log.Printf("[signal] recordPendingEnrollment: store failed for %s: %v", peerID, err)
		return
	}

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionEnrollmentPending, peerID, clientIP, map[string]string{
			"reason": "queued for approval (managed mode)",
		})
	}
	if s.eventBus != nil {
		s.eventBus.Publish(events.Event{
			Type: events.EventEnrollmentPending,
			Data: map[string]string{
				"device_id": peerID,
				"ip":        clientIP,
			},
		})
	}
}
