package signalhost

import (
	"context"
	"log"
	"net"
	"time"

	"github.com/unitronix/betterdesk-server/codec"
	pb "github.com/unitronix/betterdesk-server/proto"
)

const (
	heartbeatInterval = 12 * time.Second
	udpTimeout        = 3 * time.Second
)

func (h *Host) runLoop(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		if err := h.runUDP(ctx); err != nil {
			log.Printf("[signalhost] loop error: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}

func (h *Host) runUDP(ctx context.Context) error {
	id, err := loadIdentity(h.cfg.DataDir, "")
	if err != nil {
		return err
	}

	conn, err := net.Dial("udp", h.cfg.SignalAddr)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Time{})

	var serial int32
	sendRegister := func() error {
		msg := &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_RegisterPeer{
				RegisterPeer: &pb.RegisterPeer{Id: h.cfg.DeviceID, Serial: serial},
			},
		}
		serial++
		data, err := codec.EncodeUDP(msg)
		if err != nil {
			return err
		}
		_, err = conn.Write(data)
		return err
	}

	if err := sendRegister(); err != nil {
		return err
	}
	_ = conn.SetReadDeadline(time.Now().Add(udpTimeout))
	buf := make([]byte, 4096)
	if n, err := conn.Read(buf); err == nil {
		h.handleUDPMessage(conn, id, buf[:n])
	}

	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := sendRegister(); err != nil {
				return err
			}
		default:
		}

		_ = conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
		n, err := conn.Read(buf)
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() {
				continue
			}
			return err
		}
		h.handleUDPMessage(conn, id, buf[:n])
	}
}

func (h *Host) handleUDPMessage(conn net.Conn, id *identity, data []byte) {
	msg, err := codec.DecodeUDP(data)
	if err != nil {
		return
	}
	switch u := msg.Union.(type) {
	case *pb.RendezvousMessage_RegisterPeerResponse:
		if u.RegisterPeerResponse.GetRequestPk() {
			h.sendRegisterPk(conn, id)
		}
	case *pb.RendezvousMessage_RelayResponse:
		rr := u.RelayResponse
		if rr.GetUuid() != "" && rr.GetRelayServer() != "" {
			go h.handleIncomingRelay(rr.GetRelayServer(), rr.GetUuid())
		}
	case *pb.RendezvousMessage_RequestRelay:
		rr := u.RequestRelay
		relay := rr.GetRelayServer()
		if relay == "" {
			relay = h.cfg.RelayAddr
		}
		if rr.GetUuid() != "" {
			go h.handleIncomingRelay(relay, rr.GetUuid())
		}
	}
}

func (h *Host) sendRegisterPk(conn net.Conn, id *identity) {
	uuidBytes := h.cfg.UUID
	if len(uuidBytes) == 0 {
		uuidBytes = id.uuid
	}
	msg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RegisterPk{
			RegisterPk: &pb.RegisterPk{
				Id:   h.cfg.DeviceID,
				Uuid: uuidBytes,
				Pk:   id.pkBytes(),
			},
		},
	}
	data, err := codec.EncodeUDP(msg)
	if err != nil {
		return
	}
	_, _ = conn.Write(data)
}
