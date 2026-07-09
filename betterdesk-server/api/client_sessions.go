package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/unitronix/betterdesk-server/db"
)

const (
	configClientSessionExpiryDays = "client_session_expiry_days"
	configClientSessionSliding    = "client_session_sliding"
	configClientSessionMaxDays    = "client_session_max_days"

	defaultClientSessionExpiryDays = 7
	defaultClientSessionMaxDays    = 30
)

var opaqueClientTokenRegexp = regexp.MustCompile(`^[a-f0-9]{64}$`)

func isOpaqueClientToken(token string) bool {
	return opaqueClientTokenRegexp.MatchString(strings.ToLower(token))
}

func hashClientToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func generateOpaqueClientToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate client token: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

func (s *Server) clientSessionExpiryDays() int {
	if v, err := s.db.GetConfig(configClientSessionExpiryDays); err == nil && v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 365 {
			return n
		}
	}
	if s.cfg != nil && s.cfg.ClientSessionExpiryDays > 0 {
		return s.cfg.ClientSessionExpiryDays
	}
	return defaultClientSessionExpiryDays
}

func (s *Server) clientSessionSliding() bool {
	if v, err := s.db.GetConfig(configClientSessionSliding); err == nil && v != "" {
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "1", "true", "yes", "on":
			return true
		case "0", "false", "no", "off":
			return false
		}
	}
	if s.cfg != nil {
		return s.cfg.ClientSessionSliding
	}
	return true
}

func (s *Server) clientSessionMaxDays() int {
	if v, err := s.db.GetConfig(configClientSessionMaxDays); err == nil && v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 365 {
			return n
		}
	}
	if s.cfg != nil && s.cfg.ClientSessionMaxDays > 0 {
		return s.cfg.ClientSessionMaxDays
	}
	return defaultClientSessionMaxDays
}

func formatClientSessionTime(t time.Time) string {
	return t.UTC().Format("2006-01-02 15:04:05")
}

func parseClientSessionTime(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, fmt.Errorf("empty time")
	}
	if t, err := time.Parse("2006-01-02 15:04:05", value); err == nil {
		return t.UTC(), nil
	}
	return time.Parse(time.RFC3339, value)
}

func (s *Server) issueClientSession(user *db.User, clientID, clientUUID, clientIP string) (string, error) {
	if user == nil {
		return "", fmt.Errorf("user required")
	}
	if err := s.db.RevokeClientSessionsForDevice(user.ID, clientID, clientUUID); err != nil {
		return "", err
	}

	plainToken, err := generateOpaqueClientToken()
	if err != nil {
		return "", err
	}

	now := time.Now().UTC()
	expiresAt := now.Add(time.Duration(s.clientSessionExpiryDays()) * 24 * time.Hour)

	sess := &db.ClientSession{
		TokenHash:  hashClientToken(plainToken),
		UserID:     user.ID,
		ClientID:   clientID,
		ClientUUID: clientUUID,
		ExpiresAt:  formatClientSessionTime(expiresAt),
		LastUsed:   formatClientSessionTime(now),
		IPAddress:  clientIP,
	}
	if err := s.db.CreateClientSession(sess); err != nil {
		return "", err
	}
	return plainToken, nil
}

func (s *Server) authenticateClientSession(token string) (username, role string, ok bool) {
	if !isOpaqueClientToken(token) {
		return "", "", false
	}

	sess, err := s.db.GetClientSessionByTokenHash(hashClientToken(token))
	if err != nil || sess == nil {
		return "", "", false
	}

	user, err := s.db.GetUserByID(sess.UserID)
	if err != nil || user == nil {
		return "", "", false
	}

	if s.clientSessionSliding() {
		now := time.Now().UTC()
		createdAt, err := parseClientSessionTime(sess.CreatedAt)
		if err != nil {
			createdAt = now
		}
		maxDeadline := createdAt.Add(time.Duration(s.clientSessionMaxDays()) * 24 * time.Hour)
		newExpiry := now.Add(time.Duration(s.clientSessionExpiryDays()) * 24 * time.Hour)
		if newExpiry.After(maxDeadline) {
			newExpiry = maxDeadline
		}
		if err := s.db.TouchClientSession(sess.ID, formatClientSessionTime(newExpiry), formatClientSessionTime(now)); err != nil {
			// Non-fatal — session is still valid for this request.
		}
	} else {
		now := time.Now().UTC()
		_ = s.db.TouchClientSession(sess.ID, sess.ExpiresAt, formatClientSessionTime(now))
	}

	return user.Username, user.Role, true
}

func (s *Server) revokeClientSessionToken(token string) {
	if token == "" || !isOpaqueClientToken(token) {
		return
	}
	_ = s.db.RevokeClientSessionByTokenHash(hashClientToken(token))
}

func bearerTokenFromRequest(r *http.Request) string {
	bearer := r.Header.Get("Authorization")
	if len(bearer) <= 7 || !strings.EqualFold(bearer[:7], "Bearer ") {
		return ""
	}
	return strings.TrimSpace(bearer[7:])
}
