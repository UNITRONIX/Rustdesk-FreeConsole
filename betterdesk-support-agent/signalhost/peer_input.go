package signalhost

import (
	"log"

	bdagent "github.com/unitronix/betterdesk-agent/agent"
	pb "github.com/unitronix/betterdesk-server/proto"
)

func handlePeerMessage(msg *pb.Message, st *streamState) {
	if me := msg.GetMouseEvent(); me != nil {
		injectMouse(me)
		return
	}
	if ke := msg.GetKeyEvent(); ke != nil {
		injectKey(ke)
		return
	}
	if misc := msg.GetMisc(); misc != nil {
		if misc.GetRefreshVideo() || misc.GetRefreshVideoDisplay() != 0 {
			if st != nil {
				st.forceKeyframe.Store(true)
			}
			log.Printf("[signalhost] refresh video requested")
		}
		return
	}
	if msg.GetTestDelay() != nil {
		return
	}
}

func injectMouse(me *pb.MouseEvent) {
	if me == nil {
		return
	}
	mask := me.GetMask()
	x, y := int(me.GetX()), int(me.GetY())
	buttonID := mask >> 3
	eventType := mask & 7

	evt := &bdagent.InputEvent{X: x, Y: y}
	switch eventType {
	case 0:
		evt.Type = "mouse_move"
	case 1:
		evt.Type = "mouse_down"
		evt.Button = rustDeskButton(buttonID)
	case 2:
		evt.Type = "mouse_up"
		evt.Button = rustDeskButton(buttonID)
	case 3:
		evt.Type = "mouse_scroll"
		evt.DeltaY = y
		if y == 0 {
			evt.DeltaY = -1
		}
	default:
		evt.Type = "mouse_move"
	}
	if err := bdagent.InjectInputEvent(evt); err != nil {
		log.Printf("[signalhost] mouse inject: %v", err)
	}
}

func rustDeskButton(id int32) int {
	switch id {
	case 2:
		return 3 // right
	case 4:
		return 2 // middle
	default:
		return 1 // left
	}
}

func injectKey(ke *pb.KeyEvent) {
	if ke == nil {
		return
	}
	pressed := ke.GetDown() || ke.GetPress()
	evt := &bdagent.InputEvent{Pressed: pressed}

	switch u := ke.GetUnion().(type) {
	case *pb.KeyEvent_ControlKey:
		if pressed {
			evt.Type = "key_press"
		} else {
			evt.Type = "key_release"
		}
		evt.Key = controlKeyName(u.ControlKey)
	case *pb.KeyEvent_Chr:
		evt.Type = "text"
		evt.Text = string(rune(u.Chr))
	case *pb.KeyEvent_Unicode:
		evt.Type = "text"
		evt.Text = string(rune(u.Unicode))
	case *pb.KeyEvent_Seq:
		evt.Type = "text"
		evt.Text = u.Seq
	default:
		return
	}
	if err := bdagent.InjectInputEvent(evt); err != nil {
		log.Printf("[signalhost] key inject: %v", err)
	}
}

func controlKeyName(key pb.ControlKey) string {
	switch key {
	case pb.ControlKey_Backspace:
		return "BackSpace"
	case pb.ControlKey_Tab:
		return "Tab"
	case pb.ControlKey_Return:
		return "Return"
	case pb.ControlKey_Escape:
		return "Escape"
	case pb.ControlKey_Delete:
		return "Delete"
	case pb.ControlKey_Home:
		return "Home"
	case pb.ControlKey_End:
		return "End"
	case pb.ControlKey_PageUp:
		return "Page_Up"
	case pb.ControlKey_PageDown:
		return "Page_Down"
	case pb.ControlKey_UpArrow:
		return "Up"
	case pb.ControlKey_DownArrow:
		return "Down"
	case pb.ControlKey_LeftArrow:
		return "Left"
	case pb.ControlKey_RightArrow:
		return "Right"
	case pb.ControlKey_F1:
		return "F1"
	case pb.ControlKey_F2:
		return "F2"
	case pb.ControlKey_F3:
		return "F3"
	case pb.ControlKey_F4:
		return "F4"
	case pb.ControlKey_F5:
		return "F5"
	case pb.ControlKey_F6:
		return "F6"
	case pb.ControlKey_F7:
		return "F7"
	case pb.ControlKey_F8:
		return "F8"
	case pb.ControlKey_F9:
		return "F9"
	case pb.ControlKey_F10:
		return "F10"
	case pb.ControlKey_F11:
		return "F11"
	case pb.ControlKey_F12:
		return "F12"
	case pb.ControlKey_Shift:
		return "Shift_L"
	case pb.ControlKey_Control:
		return "Control_L"
	case pb.ControlKey_Alt:
		return "Alt_L"
	case pb.ControlKey_Meta:
		return "Super_L"
	case pb.ControlKey_Space:
		return "space"
	default:
		return key.String()
	}
}
