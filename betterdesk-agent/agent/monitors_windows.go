//go:build windows

package agent

import (
	"encoding/json"
	"os/exec"
	"strings"
)

// enumerateMonitors lists displays via PowerShell's WMI bridge. The Win32
// device-context APIs exist in syscall but pulling them in for what is a
// once-per-session enumeration costs more than the PowerShell hop.
func enumerateMonitors() []MonitorInfo {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-WindowStyle", "Hidden", "-Command",
		`Get-WmiObject -Namespace root\wmi -Class WmiMonitorBasicDisplayParams |
		ForEach-Object { [pscustomobject]@{ Name = $_.InstanceName } } |
		ConvertTo-Json -Compress`)
	hideConsole(cmd)
	out, err := cmd.Output()
	if err == nil {
		s := strings.TrimSpace(string(out))
		if s != "" {
			var raw []struct{ Name string }
			if err := json.Unmarshal([]byte(s), &raw); err == nil {
				mons := make([]MonitorInfo, 0, len(raw))
				for i, r := range raw {
					mons = append(mons, MonitorInfo{
						Index:   i,
						Name:    r.Name,
						Primary: i == 0,
					})
				}
				if len(mons) > 0 {
					return mons
				}
			}
		}
	}
	return []MonitorInfo{{Index: 0, Name: "Display", Primary: true}}
}

// desktopCaptureHint returns guidance for fixing screen capture on Windows.
func desktopCaptureHint() string {
	return "Ensure ffmpeg.exe is on PATH and that the agent process has permission to capture the active desktop session. On RDP/locked sessions screen capture is blocked by Windows."
}
