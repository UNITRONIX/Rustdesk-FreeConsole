package relay

import (
	"bytes"
	"context"
	"io"
	"log"
	"net"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/unitronix/betterdesk-server/codec"
	"github.com/unitronix/betterdesk-server/config"
)

// startMixedRelay bridges a native TCP relay peer (BytesCodec frames) with a
// WebSocket Mode peer (one raw payload per binary message). Used when panel
// Web Remote proxies to :21117 while the target connects on :21119 (#397).
// Naive byte copy between transports corrupts the E2E handshake (#290).
func (s *Server) startMixedRelay(tcpConn net.Conn, ws *websocket.Conn, tcpAddr, wsAddr, uuid string) {
	if s.sessionLimiter != nil {
		ips := make([]string, 0, 2)
		for _, addr := range []string{tcpAddr, wsAddr} {
			ip, _, err := net.SplitHostPort(addr)
			if err != nil {
				ip = addr
			}
			if !s.sessionLimiter.Acquire(ip) {
				log.Printf("[relay] Active session limit exceeded for %s (UUID %s)", ip, relayUUIDLogID(uuid))
				tcpConn.Close()
				_ = ws.Close(websocket.StatusNormalClosure, "")
				return
			}
			ips = append(ips, ip)
		}
		defer func() {
			for _, ip := range ips {
				s.sessionLimiter.Release(ip)
			}
		}()
	}

	s.ActiveSessions.Add(1)
	s.TotalRelayed.Add(1)

	log.Printf("[relay] Pair established: %s <-> %s (UUID: %s, transport=mixed)",
		tcpAddr, wsAddr, relayUUIDLogID(uuid))

	if s.onRelayStart != nil {
		s.onRelayStart(uuid)
	}

	var paceTCP, paceWS io.Writer
	if s.bwLimiter != nil {
		_ = s.bwLimiter.WrapReader(bytes.NewReader(nil))
		_ = s.bwLimiter.WrapReader(bytes.NewReader(nil))
		paceTCP = s.bwLimiter.WrapWriter(io.Discard)
		paceWS = s.bwLimiter.WrapWriter(io.Discard)
	}

	idle := config.RelayIdleTimeout
	ws.SetReadLimit(MaxWSRelayMessage)

	done := make(chan struct{})
	var once sync.Once

	go func() {
		copyTCPFramesToWS(s.ctx, tcpConn, ws, paceWS, idle)
		once.Do(func() { close(done) })
	}()
	go func() {
		copyWSToTCPFrames(s.ctx, ws, tcpConn, paceTCP, idle)
		once.Do(func() { close(done) })
	}()

	<-done

	if s.onRelayEnd != nil {
		s.onRelayEnd(uuid)
	}

	tcpConn.Close()
	_ = ws.Close(websocket.StatusNormalClosure, "")

	if s.bwLimiter != nil {
		s.bwLimiter.SessionDone()
		s.bwLimiter.SessionDone()
	}

	s.ActiveSessions.Add(-1)
	log.Printf("[relay] Session ended: UUID %s (active: %d)", relayUUIDLogID(uuid), s.ActiveSessions.Load())
}

// copyTCPFramesToWS reads BytesCodec frames from TCP and writes each payload
// as a single WebSocket binary message.
func copyTCPFramesToWS(ctx context.Context, tcp net.Conn, ws *websocket.Conn, pace io.Writer, idle time.Duration) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		payload, err := codec.ReadRawBytesMax(tcp, idle, codec.MaxPeerFrameSize)
		if err != nil {
			return
		}
		if pace != nil && len(payload) > 0 {
			_, _ = pace.Write(payload)
		}
		writeCtx, cancel := context.WithTimeout(ctx, idle)
		err = ws.Write(writeCtx, websocket.MessageBinary, payload)
		cancel()
		if err != nil {
			return
		}
	}
}

// copyWSToTCPFrames reads WebSocket binary messages and writes each as a
// BytesCodec-framed TCP payload.
func copyWSToTCPFrames(ctx context.Context, ws *websocket.Conn, tcp net.Conn, pace io.Writer, idle time.Duration) {
	for {
		readCtx, cancel := context.WithTimeout(ctx, idle)
		typ, data, err := ws.Read(readCtx)
		cancel()
		if err != nil {
			return
		}
		if typ != websocket.MessageBinary {
			continue
		}
		if pace != nil && len(data) > 0 {
			_, _ = pace.Write(data)
		}
		if err := tcp.SetWriteDeadline(time.Now().Add(idle)); err != nil {
			return
		}
		if err := codec.WriteRawBytesMax(tcp, data, codec.MaxPeerFrameSize); err != nil {
			_ = tcp.SetWriteDeadline(time.Time{})
			return
		}
		_ = tcp.SetWriteDeadline(time.Time{})
	}
}
