package agent

import (
	"encoding/json"
	"fmt"
	"strings"
)

// SendChat delivers a chat message to operators via the CDAP gateway.
func (a *Agent) SendChat(text string) error {
	if !a.connected.Load() {
		return fmt.Errorf("not connected to gateway")
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return fmt.Errorf("message required")
	}
	return a.sendMessage("chat_message", map[string]string{
		"text": text,
	})
}

func (a *Agent) handleChatMessage(msg *Message) {
	var p struct {
		Text     string `json:"text"`
		FromName string `json:"from_name"`
		FromID   string `json:"from_id"`
	}
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		return
	}
	text := strings.TrimSpace(p.Text)
	if text == "" {
		return
	}
	from := strings.TrimSpace(p.FromName)
	if from == "" {
		from = strings.TrimSpace(p.FromID)
	}
	if from == "" {
		from = "operator"
	}
	if a.cfg.ChatMessageHandler != nil {
		a.cfg.ChatMessageHandler(from, text)
	}
}
