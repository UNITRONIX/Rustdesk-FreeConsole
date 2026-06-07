package main

import (
	"fmt"
	"net/http"
)

type chatHistoryMessage struct {
	FromName string `json:"from_name"`
	FromID   string `json:"from_id"`
	Text     string `json:"text"`
}

type chatHistoryResponse struct {
	Messages []chatHistoryMessage `json:"messages"`
}

// LoadChatHistory fetches prior messages for this device's conversation.
func LoadChatHistory(b Branding, st *AppState) ([]string, error) {
	deviceID, _, _, _ := st.Snapshot()
	url := fmt.Sprintf("%s/chat/history/%s?limit=50", apiBaseURL(b), deviceID)
	var resp chatHistoryResponse
	code, err := apiJSON(http.MethodGet, url, nil, &resp)
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("chat history HTTP %d", code)
	}
	out := make([]string, 0, len(resp.Messages))
	for _, m := range resp.Messages {
		from := m.FromName
		if from == "" {
			from = m.FromID
		}
		if from == deviceID {
			from = "You"
		}
		out = append(out, from+": "+m.Text)
	}
	return out, nil
}
