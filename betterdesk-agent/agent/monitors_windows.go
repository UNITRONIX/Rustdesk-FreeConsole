//go:build windows

package agent

import (
	"encoding/json"
	"os/exec"
	"strings"
)

// enumerateMonitors lists displays and their virtual-desktop bounds. Screen is
// the only PowerShell-accessible API here that exposes the geometry needed to
// explain what the capture source is sharing; WMI only exposes display names.
func enumerateMonitors() []MonitorInfo {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-WindowStyle", "Hidden", "-Command",
		`Add-Type -AssemblyName System.Windows.Forms;
		[System.Windows.Forms.Screen]::AllScreens |
		ForEach-Object { [pscustomobject]@{
			Name = $_.DeviceName
			Width = $_.Bounds.Width
			Height = $_.Bounds.Height
			X = $_.Bounds.X
			Y = $_.Bounds.Y
			Primary = $_.Primary
		} } |
		ConvertTo-Json -Compress`)
	hideConsole(cmd)
	out, err := cmd.Output()
	if err == nil {
		s := strings.TrimSpace(string(out))
		if s != "" {
			type screen struct {
				Name    string
				Width   int
				Height  int
				X       int
				Y       int
				Primary bool
			}
			var raw []screen
			if err := json.Unmarshal([]byte(s), &raw); err != nil {
				var one screen
				if json.Unmarshal([]byte(s), &one) == nil && one.Name != "" {
					raw = []screen{one}
				}
			}
			mons := make([]MonitorInfo, 0, len(raw))
			for i, r := range raw {
				if r.Width <= 0 || r.Height <= 0 {
					continue
				}
				mons = append(mons, MonitorInfo{
					Index: i, Name: r.Name, Width: r.Width, Height: r.Height,
					X: r.X, Y: r.Y, Primary: r.Primary,
				})
			}
			if len(mons) > 0 {
				return mons
			}
		}
	}
	return []MonitorInfo{{Index: 0, Name: "Display", Primary: true}}
}

// desktopCaptureHint returns guidance for fixing screen capture on Windows.
func desktopCaptureHint() string {
	return "Ensure ffmpeg.exe is on PATH and that the agent process has permission to capture the active desktop session. On RDP/locked sessions screen capture is blocked by Windows."
}
