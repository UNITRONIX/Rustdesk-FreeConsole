//go:build fyneui

package main

// sendChatMessage delivers a chat line via CDAP.
func (u *ui) sendChatMessage(text string) {
	if err := SendChatMessage(u.engine, text); err != nil {
		u.notify(err.Error())
		return
	}
	u.chatMessages = append(u.chatMessages, "You: "+text)
}
