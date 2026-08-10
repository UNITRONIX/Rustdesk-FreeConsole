package api

import (
	"encoding/json"
)

// stripSecretsFromOrgAddressBook removes password/hash fields before persisting
// org shared AB JSON so secrets stay only in org_peer_credentials (#367).
func stripSecretsFromOrgAddressBook(data string) string {
	ab := parseAddressBookMap(data)
	peers := toPeerSlice(ab["peers"])
	changed := false
	for i, p := range peers {
		if _, ok := p["password"]; ok {
			delete(p, "password")
			changed = true
		}
		if _, ok := p["hash"]; ok {
			delete(p, "hash")
			changed = true
		}
		peers[i] = p
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
