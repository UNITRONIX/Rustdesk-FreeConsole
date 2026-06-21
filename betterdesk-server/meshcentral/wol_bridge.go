package meshcentral

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/unitronix/betterdesk-server/db"
)

var macAddrRe = regexp.MustCompile(`(?i)(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}`)

// MeshMACFromPeerConfig extracts the first MAC from stored mesh agent telemetry.
func MeshMACFromPeerConfig(database db.Database, peerID string) string {
	for _, key := range []string{"mesh_last_msg_" + peerID, "mesh_coreinfo_" + peerID} {
		raw, _ := database.GetConfig(key)
		if raw == "" {
			continue
		}
		if mac := macFromMeshJSON(raw); mac != "" {
			return mac
		}
	}
	return ""
}

func macFromMeshJSON(raw string) string {
	if m := macAddrRe.FindString(raw); m != "" {
		return normalizeMAC(m)
	}
	var obj map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &obj); err != nil {
		return ""
	}
	return findMacValue(obj)
}

func findMacValue(v interface{}) string {
	switch t := v.(type) {
	case string:
		if m := macAddrRe.FindString(t); m != "" {
			return normalizeMAC(m)
		}
	case map[string]interface{}:
		for _, key := range []string{"mac", "macs", "macaddress", "hwaddr"} {
			if val, ok := t[key]; ok {
				if mac := findMacValue(val); mac != "" {
					return mac
				}
			}
		}
		for _, val := range t {
			if mac := findMacValue(val); mac != "" {
				return mac
			}
		}
	case []interface{}:
		for _, item := range t {
			if mac := findMacValue(item); mac != "" {
				return mac
			}
		}
	}
	return ""
}

func normalizeMAC(mac string) string {
	mac = strings.TrimSpace(mac)
	mac = strings.ReplaceAll(mac, "-", ":")
	return strings.ToLower(mac)
}
