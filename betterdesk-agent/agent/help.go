package agent

import (
	"fmt"
	"os"
	"strings"
)

// RequestHelp raises a support request on the active CDAP connection.
func (a *Agent) RequestHelp(message string) error {
	if !a.connected.Load() {
		return fmt.Errorf("not connected to gateway")
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return fmt.Errorf("message required")
	}
	hostname, _ := os.Hostname()
	return a.sendMessage("help_request", map[string]string{
		"message":  message,
		"hostname": hostname,
	})
}
