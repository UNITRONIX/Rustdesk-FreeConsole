package signal

import (
	"log"

	"github.com/unitronix/betterdesk-server/events"
	pb "github.com/unitronix/betterdesk-server/proto"
)

func (s *Server) startPeerIDChangeListener() {
	if s.eventBus == nil {
		return
	}

	sub := s.eventBus.Subscribe(events.EventPeerIDChanged)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer s.eventBus.Unsubscribe(sub)

		for {
			select {
			case <-s.ctx.Done():
				return
			case ev, ok := <-sub.Ch:
				if !ok {
					return
				}
				data := ev.Data
				if data == nil || data["source"] != "panel" {
					continue
				}
				oldID := data["old_id"]
				newID := data["new_id"]
				if oldID == "" || newID == "" || oldID == newID {
					continue
				}
				s.notifyPeerIDChange(oldID, newID)
			}
		}
	}()
}

func (s *Server) notifyPeerIDChange(oldID, newID string) {
	msg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_PeerDiscovery{
			PeerDiscovery: &pb.PeerDiscovery{
				Cmd:  "change_id",
				Id:   newID,
				Misc: oldID,
			},
		},
	}

	// After panel/API rename the in-memory entry is keyed by newID; the client
	// may still heartbeat under oldID until redirect logic maps it.
	s.sendToPeer(newID, msg)
	s.sendToPeer(oldID, msg)
	log.Printf("[signal] Notified connected peer of panel ID change %s -> %s", oldID, newID)
}
