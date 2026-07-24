package codec

import (
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/coder/websocket"
	pb "github.com/unitronix/betterdesk-server/proto"
	"google.golang.org/protobuf/proto"
)

// WSDebugFrames enables verbose logging of the first WS frames on each connection.
// Set env WS_DEBUG_FRAMES=1 to enable.
func WSDebugFrames() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("WS_DEBUG_FRAMES")))
	return v == "1" || v == "true" || v == "yes"
}

func describeWSFrameType(typ websocket.MessageType) string {
	switch typ {
	case websocket.MessageBinary:
		return "binary"
	case websocket.MessageText:
		return "text"
	default:
		return fmt.Sprintf("type=%v", typ)
	}
}

func describeRendezvousPayload(data []byte) string {
	if len(data) == 0 {
		return "keepalive(empty)"
	}
	msg := &pb.RendezvousMessage{}
	if err := proto.Unmarshal(data, msg); err != nil {
		return fmt.Sprintf("protobuf(parse_error:%v)", err)
	}
	switch {
	case msg.GetRegisterPeer() != nil:
		return fmt.Sprintf("RegisterPeer(id=%s)", msg.GetRegisterPeer().GetId())
	case msg.GetRegisterPk() != nil:
		return fmt.Sprintf("RegisterPk(id=%s)", msg.GetRegisterPk().GetId())
	case msg.GetRegisterPeerResponse() != nil:
		return fmt.Sprintf("RegisterPeerResponse(request_pk=%v)", msg.GetRegisterPeerResponse().GetRequestPk())
	case msg.GetRegisterPkResponse() != nil:
		return fmt.Sprintf("RegisterPkResponse(result=%v)", msg.GetRegisterPkResponse().GetResult())
	case msg.GetHc() != nil:
		return fmt.Sprintf("HealthCheck(token=%q)", msg.GetHc().GetToken())
	case msg.GetKeyExchange() != nil:
		return "KeyExchange"
	default:
		return "RendezvousMessage(other)"
	}
}

func hexPrefix(data []byte, max int) string {
	if len(data) == 0 {
		return ""
	}
	if len(data) > max {
		data = data[:max]
	}
	return hex.EncodeToString(data)
}

func (c *WSConn) logFirstReadFrame(typ websocket.MessageType, data []byte) {
	if !WSDebugFrames() || c.gotRead {
		return
	}
	c.gotRead = true
	log.Printf("[signal] WS debug first recv from %s: %s len=%d kind=%s hex=%s",
		c.Addr, describeWSFrameType(typ), len(data), describeRendezvousPayload(data), hexPrefix(data, 32))
}

func (c *WSConn) logFirstWriteFrame(data []byte) {
	if !WSDebugFrames() || c.gotWrite {
		return
	}
	c.gotWrite = true
	log.Printf("[signal] WS debug first send to %s: binary len=%d kind=%s hex=%s",
		c.Addr, len(data), describeRendezvousPayload(data), hexPrefix(data, 32))
}

// SessionSummary returns connection stats for EOF diagnostics.
func (c *WSConn) SessionSummary() (since time.Duration, readFrames, writeFrames int, readAny, writeAny bool) {
	if c.connectedAt.IsZero() {
		return 0, c.framesRead, c.framesWrite, c.gotRead, c.gotWrite
	}
	return time.Since(c.connectedAt), c.framesRead, c.framesWrite, c.gotRead, c.gotWrite
}
