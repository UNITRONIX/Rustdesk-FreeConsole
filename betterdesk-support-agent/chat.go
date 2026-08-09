package main

import "fmt"

// SendChatMessage sends a chat message through the active CDAP engine.
func SendChatMessage(engine *Engine, text string) error {
	if engine == nil {
		return fmt.Errorf("not connected")
	}
	return engine.SendChat(text)
}
