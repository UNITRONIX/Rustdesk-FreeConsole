package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

// injectOrgPeerCredentialsIntoAB decrypts org vault passwords and injects the
// RustDesk shared-AB "password" field into the in-memory GET /api/ab response only.
// Secrets are never written back to org_address_books JSON (#367).
func (s *Server) injectOrgPeerCredentialsIntoAB(r *http.Request, data string) string {
	if s.peerVault == nil || s.db == nil {
		return data
	}
	orgIDs := s.resolveUserOrgIDsForAB(r)
	if len(orgIDs) == 0 {
		return data
	}

	// peer_id → plaintext (first org wins if duplicates)
	secrets := make(map[string]string)
	for _, orgID := range orgIDs {
		if !s.orgSharedAddressBookEnabled(orgID) {
			continue
		}
		flags, err := s.db.ListOrgPeerCredentialFlags(orgID)
		if err != nil {
			log.Printf("[api] ListOrgPeerCredentialFlags org=%s: %v", orgID, err)
			continue
		}
		for _, f := range flags {
			if f == nil || f.PeerID == "" || secrets[f.PeerID] != "" {
				continue
			}
			row, err := s.db.GetOrgPeerCredential(orgID, f.PeerID)
			if err != nil || row == nil {
				continue
			}
			plain, err := s.peerVault.Open(row.Nonce, row.Ciphertext, row.KeyID)
			if err != nil {
				log.Printf("[api] peer vault open for AB inject peer=%s: %v", f.PeerID, err)
				continue
			}
			if strings.TrimSpace(plain) != "" {
				secrets[f.PeerID] = plain
			}
		}
	}
	if len(secrets) == 0 {
		return data
	}

	ab := parseAddressBookMap(data)
	peers := toPeerSlice(ab["peers"])
	changed := false
	for i, p := range peers {
		id, _ := p["id"].(string)
		if id == "" {
			continue
		}
		secret, ok := secrets[id]
		if !ok {
			continue
		}
		// Prefer shared-AB "password"; only fill when empty so personal entries win.
		if isEmptyABValue(p["password"]) {
			p["password"] = secret
			peers[i] = p
			changed = true
		}
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
