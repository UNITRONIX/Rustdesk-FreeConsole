// ws-register-test sends a RegisterPeer heartbeat over the signal WebSocket.
// Usage: ws-register-test <ws-url> <peer-id>
package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/coder/websocket"
	pb "github.com/unitronix/betterdesk-server/proto"
	"google.golang.org/protobuf/proto"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintf(os.Stderr, "usage: %s <ws-url> <peer-id>\n", os.Args[0])
		os.Exit(2)
	}
	wsURL := os.Args[1]
	peerID := os.Args[2]

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	dialOpts := &websocket.DialOptions{}
	if strings.HasPrefix(wsURL, "wss://") {
		dialOpts.HTTPClient = &http.Client{
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // test utility
			},
		}
	}
	ws, _, err := websocket.Dial(ctx, wsURL, dialOpts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "dial: %v\n", err)
		os.Exit(1)
	}
	defer ws.CloseNow()

	reg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RegisterPeer{
			RegisterPeer: &pb.RegisterPeer{
				Id:     peerID,
				Serial: 1,
			},
		},
	}
	data, err := proto.Marshal(reg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal: %v\n", err)
		os.Exit(1)
	}
	if err := ws.Write(ctx, websocket.MessageBinary, data); err != nil {
		fmt.Fprintf(os.Stderr, "write: %v\n", err)
		os.Exit(1)
	}

	readCtx, readCancel := context.WithTimeout(ctx, 5*time.Second)
	defer readCancel()
	_, respData, err := ws.Read(readCtx)
	if err != nil {
		fmt.Println("REJECTED: no response (", err, ")")
		os.Exit(0)
	}

	resp := &pb.RendezvousMessage{}
	if err := proto.Unmarshal(respData, resp); err != nil {
		fmt.Fprintf(os.Stderr, "unmarshal: %v\n", err)
		os.Exit(1)
	}
	if rpr := resp.GetRegisterPeerResponse(); rpr != nil {
		fmt.Printf("ACCEPTED: request_pk=%v\n", rpr.GetRequestPk())
		os.Exit(0)
	}
	fmt.Printf("UNKNOWN_RESPONSE: %+v\n", resp)
}
