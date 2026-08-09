package main

import (
	"strings"
)

// formatDeviceID inserts spaces every three characters for readability.
func formatDeviceID(id string) string {
	id = strings.TrimSpace(id)
	if id == "" {
		return "—"
	}
	var b strings.Builder
	for i, r := range id {
		if i > 0 && i%3 == 0 {
			b.WriteRune(' ')
		}
		b.WriteRune(r)
	}
	return b.String()
}

func maskPassword(pw string) string {
	if pw == "" {
		return "—"
	}
	r := []rune(pw)
	if len(r) <= 2 {
		return strings.Repeat("•", len(r))
	}
	return string(r[:1]) + strings.Repeat("•", len(r)-2) + string(r[len(r)-1:])
}

func modeFromLabel(label string) string {
	switch label {
	case t("mode_unattended"):
		return AccessUnattended
	case t("mode_disabled"):
		return AccessDisabled
	default:
		return AccessSupervised
	}
}
