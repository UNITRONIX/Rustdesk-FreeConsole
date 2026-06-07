package main

import "fmt"

// SendChatMessage sends a chat message through the active CDAP engine.
func SendChatMessage(engine *Engine, text string) error {
	if engine == nil {
		return fmt.Errorf("not connected")
	}
	return engine.SendChat(text)
}

// sendChatMessage delivers a chat line via CDAP.
func (u *ui) sendChatMessage(text string) {
	if err := SendChatMessage(u.engine, text); err != nil {
		u.notify(err.Error())
		return
	}
	u.chatMessages = append(u.chatMessages, "You: "+text)
}
