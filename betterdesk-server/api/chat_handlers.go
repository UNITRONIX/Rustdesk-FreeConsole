// Chat REST API handlers — message persistence, contacts, groups.
//
// Endpoints:
//   GET  /api/chat/history/:conversation_id  — get message history
//   POST /api/chat/messages                  — save a new message
//   POST /api/chat/read                      — mark messages as read
//   GET  /api/chat/unread/:device_id         — get unread count
//   GET  /api/chat/contacts/:device_id       — get chat contacts (online peers)
//   POST /api/chat/groups                    — create a group
//   GET  /api/chat/groups/:member_id         — list groups for member
//   PUT  /api/chat/groups/:id                — update group
//   DELETE /api/chat/groups/:id              — delete group

package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/events"
)

// handleChatHistory returns message history for a conversation.
// GET /api/chat/history/{conversation_id}?limit=100&before=123
func (s *Server) handleChatHistory(w http.ResponseWriter, r *http.Request) {
	convID := strings.TrimPrefix(r.URL.Path, "/api/chat/history/")
	if convID == "" {
		http.Error(w, `{"error":"conversation_id required"}`, http.StatusBadRequest)
		return
	}

	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}

	var msgs []*db.ChatMessage
	var err error

	if beforeStr := r.URL.Query().Get("before"); beforeStr != "" {
		beforeID, _ := strconv.ParseInt(beforeStr, 10, 64)
		if beforeID > 0 {
			msgs, err = s.db.GetChatHistoryBefore(convID, beforeID, limit)
		} else {
			msgs, err = s.db.GetChatHistory(convID, limit)
		}
	} else {
		msgs, err = s.db.GetChatHistory(convID, limit)
	}

	if err != nil {
		log.Printf("[chat] GetChatHistory error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}

	if msgs == nil {
		msgs = []*db.ChatMessage{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"conversation_id": convID,
		"messages":        msgs,
	})
}

// handleChatSendMessage saves a new chat message.
// POST /api/chat/messages
// Body: { "conversation_id": "...", "from_id": "...", "from_name": "...", "to_id": "...", "text": "..." }
func (s *Server) handleChatSendMessage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ConversationID string `json:"conversation_id"`
		FromID         string `json:"from_id"`
		FromName       string `json:"from_name"`
		ToID           string `json:"to_id"`
		Text           string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	if body.ConversationID == "" || body.FromID == "" || body.Text == "" {
		http.Error(w, `{"error":"conversation_id, from_id, and text required"}`, http.StatusBadRequest)
		return
	}

	// Truncate text to 4096 chars
	if len(body.Text) > 4096 {
		body.Text = body.Text[:4096]
	}

	msg := &db.ChatMessage{
		ConversationID: body.ConversationID,
		FromID:         body.FromID,
		FromName:       body.FromName,
		ToID:           body.ToID,
		Text:           body.Text,
		CreatedAt:      time.Now(),
	}

	id, err := s.db.SaveChatMessage(msg)
	if err != nil {
		log.Printf("[chat] SaveChatMessage error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}

	msg.ID = id

	// Notify subscribers (e.g. the Node.js panel) so they can fan the message
	// out to operator browsers in real time.
	if s.eventBus != nil {
		s.eventBus.Publish(events.Event{
			Type: "chat_message",
			Data: map[string]string{
				"id":              strconv.FormatInt(id, 10),
				"conversation_id": msg.ConversationID,
				"from_id":         msg.FromID,
				"from_name":       msg.FromName,
				"to_id":           msg.ToID,
				"text":            msg.Text,
			},
		})
	}

	// Deliver to the target device over CDAP if it is connected. The message is
	// already persisted; CDAP delivery is best-effort for online agents.
	if body.ToID != "" && s.cdapGw != nil && s.cdapGw.IsConnected(body.ToID) {
		if err := s.cdapGw.SendChatToDevice(r.Context(), body.ToID, body.FromID, body.FromName, body.Text); err != nil {
			log.Printf("[chat] CDAP delivery to %s failed: %v", body.ToID, err)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(msg)
}

// handleChatMarkRead marks messages as read.
// POST /api/chat/read
// Body: { "conversation_id": "...", "reader_id": "..." }
func (s *Server) handleChatMarkRead(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ConversationID string `json:"conversation_id"`
		ReaderID       string `json:"reader_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	if body.ConversationID == "" || body.ReaderID == "" {
		http.Error(w, `{"error":"conversation_id and reader_id required"}`, http.StatusBadRequest)
		return
	}

	if err := s.db.MarkChatRead(body.ConversationID, body.ReaderID); err != nil {
		log.Printf("[chat] MarkChatRead error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

// handleChatUnread returns unread count for a device.
// GET /api/chat/unread/{device_id}
func (s *Server) handleChatUnread(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimPrefix(r.URL.Path, "/api/chat/unread/")
	if deviceID == "" {
		http.Error(w, `{"error":"device_id required"}`, http.StatusBadRequest)
		return
	}

	count, err := s.db.GetUnreadCount(deviceID)
	if err != nil {
		log.Printf("[chat] GetUnreadCount error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"device_id": deviceID,
		"unread":    count,
	})
}

// handleChatContacts returns online peers as chat contacts.
// GET /api/chat/contacts/{device_id}
func (s *Server) handleChatContacts(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimPrefix(r.URL.Path, "/api/chat/contacts/")

	peers, err := s.db.ListPeers(false)
	if err != nil {
		log.Printf("[chat] ListPeers error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}

	type contact struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Hostname    string `json:"hostname"`
		Online      bool   `json:"online"`
		LastSeen    int64  `json:"last_seen"`
		Unread      int    `json:"unread"`
		AvatarColor string `json:"avatar_color"`
		Role        string `json:"role"` // "device" or "operator"
	}

	var contacts []contact
	for _, p := range peers {
		if p.ID == deviceID {
			continue // exclude self
		}
		c := contact{
			ID:          p.ID,
			Name:        p.Hostname,
			Hostname:    p.Hostname,
			Online:      p.Status == "ONLINE" || p.Status == "DEGRADED",
			LastSeen:    p.LastOnline.UnixMilli(),
			AvatarColor: deviceColor(p.ID),
			Role:        "device",
		}
		if c.Name == "" {
			c.Name = p.ID
		}
		// Get unread count for this conversation
		unread, _ := s.db.GetUnreadCount(deviceID)
		c.Unread = unread
		contacts = append(contacts, c)
	}

	// Add operators as contacts
	users, err := s.db.ListUsers()
	if err == nil {
		for _, u := range users {
			if u.Role == "admin" || u.Role == "operator" {
				contacts = append(contacts, contact{
					ID:          "operator:" + u.Username,
					Name:        u.Username,
					Hostname:    "Console",
					Online:      true, // operators are always "available" from device perspective
					AvatarColor: deviceColor(u.Username),
					Role:        "operator",
				})
			}
		}
	}

	if contacts == nil {
		contacts = []contact{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"contacts": contacts,
	})
}

// handleChatCreateGroup creates a new chat group.
// POST /api/chat/groups
// Body: { "name": "...", "members": ["id1","id2"], "created_by": "..." }
func (s *Server) handleChatCreateGroup(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name      string   `json:"name"`
		Members   []string `json:"members"`
		CreatedBy string   `json:"created_by"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	if body.Name == "" || len(body.Members) == 0 {
		http.Error(w, `{"error":"name and members required"}`, http.StatusBadRequest)
		return
	}

	g := &db.ChatGroup{
		ID:        "group:" + uuid.New().String()[:8],
		Name:      body.Name,
		Members:   strings.Join(body.Members, ","),
		CreatedBy: body.CreatedBy,
		CreatedAt: time.Now(),
	}

	if err := s.db.CreateChatGroup(g); err != nil {
		log.Printf("[chat] CreateChatGroup error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(g)
}

// handleChatListGroups lists groups for a member.
// GET /api/chat/groups/{member_id}
func (s *Server) handleChatListGroups(w http.ResponseWriter, r *http.Request) {
	memberID := strings.TrimPrefix(r.URL.Path, "/api/chat/groups/")
	if memberID == "" {
		http.Error(w, `{"error":"member_id required"}`, http.StatusBadRequest)
		return
	}

	groups, err := s.db.ListChatGroups(memberID)
	if err != nil {
		log.Printf("[chat] ListChatGroups error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}

	if groups == nil {
		groups = []*db.ChatGroup{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"groups": groups,
	})
}

// handleChatUpdateGroup updates a chat group.
// PUT /api/chat/groups/{id}
func (s *Server) handleChatUpdateGroup(w http.ResponseWriter, r *http.Request) {
	groupID := strings.TrimPrefix(r.URL.Path, "/api/chat/groups/")
	if groupID == "" {
		http.Error(w, `{"error":"group id required"}`, http.StatusBadRequest)
		return
	}

	var body struct {
		Name    string   `json:"name"`
		Members []string `json:"members"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}

	g := &db.ChatGroup{
		ID:      groupID,
		Name:    body.Name,
		Members: strings.Join(body.Members, ","),
	}

	if err := s.db.UpdateChatGroup(g); err != nil {
		log.Printf("[chat] UpdateChatGroup error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"ok": true})
}

// handleChatDeleteGroup deletes a chat group.
// DELETE /api/chat/groups/{id}
func (s *Server) handleChatDeleteGroup(w http.ResponseWriter, r *http.Request) {
	groupID := strings.TrimPrefix(r.URL.Path, "/api/chat/groups/")
	if groupID == "" {
		http.Error(w, `{"error":"group id required"}`, http.StatusBadRequest)
		return
	}

	if err := s.db.DeleteChatGroup(groupID); err != nil {
		log.Printf("[chat] DeleteChatGroup error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}

	// Also delete group chat history
	_ = s.db.DeleteChatHistory(groupID)

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

// deviceColor generates a consistent HSL color from a device ID string.
func deviceColor(id string) string {
	var hash uint32
	for _, c := range id {
		hash = hash*31 + uint32(c)
	}
	hue := hash % 360
	return "hsl(" + strconv.Itoa(int(hue)) + ", 65%, 55%)"
}
