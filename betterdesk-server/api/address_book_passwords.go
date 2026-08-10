package api

import (
	"encoding/json"
	"log"
	"strings"

	"github.com/unitronix/betterdesk-server/db"
)

// accessPolicyEligibleForABPassword reports whether a sealed Access Policy
// password should be injected into GET /api/ab for authenticated clients.
// Requires unattended + passwordless server access + a sealed secret.
func accessPolicyEligibleForABPassword(policy *db.AccessPolicy) bool {
	if policy == nil {
		return false
	}
	return policy.UnattendedEnabled &&
		policy.PasswordlessServerAccess &&
		strings.TrimSpace(policy.PasswordEnc) != ""
}

// operatorAllowedForAccessPolicy mirrors connect-secret ACL: empty allow-list
// means all authenticated users; otherwise username must match (case-insensitive).
// API-key callers (apikey:…) bypass the allow-list the same way as connect-secret.
func operatorAllowedForAccessPolicy(username, allowedOperators string) bool {
	allowedOperators = strings.TrimSpace(allowedOperators)
	if allowedOperators == "" {
		return true
	}
	if strings.HasPrefix(username, "apikey:") {
		return true
	}
	for _, op := range strings.Split(allowedOperators, ",") {
		if strings.EqualFold(strings.TrimSpace(op), username) {
			return true
		}
	}
	return false
}

// injectPeerPasswordsIntoAddressBook sets peers[].password from passwordsByPeerID.
// Existing AB passwords are overwritten (passwordless server access prefers server).
func injectPeerPasswordsIntoAddressBook(data string, passwordsByPeerID map[string]string) string {
	if len(passwordsByPeerID) == 0 {
		return data
	}
	ab := parseAddressBookMap(data)
	peers := toPeerSlice(ab["peers"])
	changed := false
	for _, p := range peers {
		id, _ := p["id"].(string)
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		plain, ok := passwordsByPeerID[id]
		if !ok || plain == "" {
			continue
		}
		p["password"] = plain
		changed = true
	}
	if !changed {
		return data
	}
	ab["peers"] = peersToAny(peers)
	out, err := json.Marshal(ab)
	if err != nil {
		return data
	}
	return string(out)
}

// enrichAddressBookWithAccessPasswords injects sealed Access Policy passwords
// into address-book peers for authenticated clients when passwordless server
// access is enabled. Response-only — not persisted by this helper.
func (s *Server) enrichAddressBookWithAccessPasswords(username, data string) string {
	if s == nil || s.db == nil || s.accessSecret == nil {
		return data
	}
	ab := parseAddressBookMap(data)
	peers := toPeerSlice(ab["peers"])
	if len(peers) == 0 {
		return data
	}

	ids := make([]string, 0, len(peers))
	seen := make(map[string]bool, len(peers))
	for _, p := range peers {
		id, _ := p["id"].(string)
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return data
	}

	policies, err := s.db.GetAccessPoliciesByPeerIDs(ids)
	if err != nil {
		log.Printf("[api] GetAccessPoliciesByPeerIDs for AB enrich: %v", err)
		return data
	}
	if len(policies) == 0 {
		return data
	}

	passwords := make(map[string]string)
	for id, policy := range policies {
		if !accessPolicyEligibleForABPassword(policy) {
			continue
		}
		if !operatorAllowedForAccessPolicy(username, policy.AllowedOperators) {
			continue
		}
		plain, err := s.accessSecret.Decrypt(policy.PasswordEnc)
		if err != nil || plain == "" {
			continue
		}
		passwords[id] = plain
	}
	if len(passwords) == 0 {
		return data
	}
	return injectPeerPasswordsIntoAddressBook(data, passwords)
}
