// ws-register-test sends RegisterPeer or RegisterPk over the signal WebSocket.
//
// Usage:
//
//	ws-register-test <ws-url> <peer-id> [--mode=register-peer|register-pk] [--delay-ms=0]
package main

import (
	"context"
	"crypto/tls"
	"flag"
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
	mode := flag.String("mode", "register-pk", "registration message: register-peer or register-pk")
	delayMS := flag.Int("delay-ms", 0, "milliseconds to wait after connect before sending (simulates RustDesk desktop timer)")
	flag.Parse()

	args := flag.Args()
	if len(args) != 2 {
		fmt.Fprintf(os.Stderr, "usage: %s [--mode=register-pk|register-peer] [--delay-ms=N] <ws-url> <peer-id>\n", os.Args[0])
		os.Exit(2)
	}
	wsURL := args[0]
	peerID := args[1]

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	dialOpts := &websocket.DialOptions{}
	if strings.HasPrefix(wsURL, "wss://") && os.Getenv("WS_REGISTER_TEST_INSECURE") == "1" {
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

	if *delayMS > 0 {
		select {
		case <-ctx.Done():
			fmt.Fprintf(os.Stderr, "delay: %v\n", ctx.Err())
			os.Exit(1)
		case <-time.After(time.Duration(*delayMS) * time.Millisecond):
		}
	}

	var reg *pb.RendezvousMessage
	switch strings.ToLower(strings.TrimSpace(*mode)) {
	case "register-peer", "peer":
		reg = &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_RegisterPeer{
				RegisterPeer: &pb.RegisterPeer{
					Id:     peerID,
					Serial: 1,
				},
			},
		}
	case "register-pk", "pk":
		reg = &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_RegisterPk{
				RegisterPk: &pb.RegisterPk{
					Id:   peerID,
					Uuid: []byte("ws-register-test-uuid"),
					Pk:   make([]byte, 32),
				},
			},
		}
	default:
		fmt.Fprintf(os.Stderr, "unknown mode %q (use register-peer or register-pk)\n", *mode)
		os.Exit(2)
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

	resp := readProtoSkippingKeepAlive(ctx, ws)
	if rpr := resp.GetRegisterPeerResponse(); rpr != nil {
		fmt.Printf("ACCEPTED: RegisterPeerResponse request_pk=%v\n", rpr.GetRequestPk())
		os.Exit(0)
	}
	if rpk := resp.GetRegisterPkResponse(); rpk != nil {
		fmt.Printf("ACCEPTED: RegisterPkResponse result=%v keep_alive=%d\n", rpk.GetResult(), rpk.GetKeepAlive())
		os.Exit(0)
	}
	fmt.Printf("UNKNOWN_RESPONSE: %+v\n", resp)
}

func readProtoSkippingKeepAlive(ctx context.Context, ws *websocket.Conn) *pb.RendezvousMessage {
	readCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	for {
		_, respData, err := ws.Read(readCtx)
		if err != nil {
			fmt.Printf("REJECTED: no response (%v)\n", err)
			os.Exit(0)
		}
		if len(respData) == 0 {
			continue
		}
		resp := &pb.RendezvousMessage{}
		if err := proto.Unmarshal(respData, resp); err != nil {
			fmt.Fprintf(os.Stderr, "unmarshal: %v\n", err)
			os.Exit(1)
		}
		return resp
	}
}
