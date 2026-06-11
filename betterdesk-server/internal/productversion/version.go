// Package productversion exposes the embedded BetterDesk product semver.
package productversion

import (
	_ "embed"
	"strings"
)

//go:embed VERSION
var embedded []byte

// Product returns the embedded product version (X.Y.Z) or "dev" when unset.
func Product() string {
	v := strings.TrimSpace(string(embedded))
	if v == "" {
		return "dev"
	}
	return v
}
