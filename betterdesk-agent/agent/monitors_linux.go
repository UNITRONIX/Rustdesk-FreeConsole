//go:build linux

package agent

import (
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// enumerateMonitors returns the list of displays attached to this machine.
// It tries the most common Linux backends in order: xrandr (X11/XWayland),
// wlr-randr (wlroots compositors such as Sway/Hyprland), swaymsg (Sway),
// and finally a single-virtual-monitor fallback.
//
// The returned indexes are dense from 0; the agent uses them when handling
// `monitor_select` to choose the capture region.
func enumerateMonitors() []MonitorInfo {
	if mons := monitorsXrandr(); len(mons) > 0 {
		return mons
	}
	if mons := monitorsWlrRandr(); len(mons) > 0 {
		return mons
	}
	if mons := monitorsSwaymsg(); len(mons) > 0 {
		return mons
	}
	return []MonitorInfo{{Index: 0, Name: "Display", Width: 0, Height: 0, Primary: true}}
}

// monitorsXrandr parses `xrandr --listmonitors` output of the form:
//
//	Monitors: 2
//	 0: +*HDMI-1 1920/477x1080/268+0+0  HDMI-1
//	 1:  DP-1 2560/600x1440/340+1920+0  DP-1
//
// The leading `*` marks the primary monitor.
func monitorsXrandr() []MonitorInfo {
	if _, err := exec.LookPath("xrandr"); err != nil {
		return nil
	}
	out, err := exec.Command("xrandr", "--listmonitors").Output()
	if err != nil {
		return nil
	}

	// Match: <num>: <flags><name> <w>/<wmm>x<h>/<hmm>+<x>+<y>  <output>
	re := regexp.MustCompile(`^\s*(\d+):\s+([+*]+)?(\S+)\s+(\d+)/\d+x(\d+)/\d+\+(\-?\d+)\+(\-?\d+)\s+(\S+)`)
	var out2 []MonitorInfo
	for _, line := range strings.Split(string(out), "\n") {
		m := re.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		idx, _ := strconv.Atoi(m[1])
		flags := m[2]
		w, _ := strconv.Atoi(m[4])
		h, _ := strconv.Atoi(m[5])
		x, _ := strconv.Atoi(m[6])
		y, _ := strconv.Atoi(m[7])
		out2 = append(out2, MonitorInfo{
			Index:   idx,
			Name:    m[8],
			Width:   w,
			Height:  h,
			X:       x,
			Y:       y,
			Primary: strings.Contains(flags, "*"),
		})
	}
	return out2
}

// monitorsWlrRandr parses `wlr-randr` output. Each output starts with the
// name on its own line; we read the "current" mode and the position from
// the indented properties.
func monitorsWlrRandr() []MonitorInfo {
	if _, err := exec.LookPath("wlr-randr"); err != nil {
		return nil
	}
	out, err := exec.Command("wlr-randr").Output()
	if err != nil {
		return nil
	}
	var (
		mons    []MonitorInfo
		current MonitorInfo
		have    bool
	)
	flush := func() {
		if have {
			current.Index = len(mons)
			mons = append(mons, current)
		}
		current = MonitorInfo{}
		have = false
	}
	modeRe := regexp.MustCompile(`(\d+)x(\d+)\s+px.*current`)
	posRe := regexp.MustCompile(`Position:\s+(\-?\d+),(\-?\d+)`)
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
			flush()
			fields := strings.Fields(line)
			if len(fields) > 0 {
				current.Name = fields[0]
				have = true
			}
			continue
		}
		if m := modeRe.FindStringSubmatch(line); m != nil {
			current.Width, _ = strconv.Atoi(m[1])
			current.Height, _ = strconv.Atoi(m[2])
		}
		if m := posRe.FindStringSubmatch(line); m != nil {
			current.X, _ = strconv.Atoi(m[1])
			current.Y, _ = strconv.Atoi(m[2])
		}
	}
	flush()
	if len(mons) > 0 {
		mons[0].Primary = true
	}
	return mons
}

// monitorsSwaymsg parses `swaymsg -t get_outputs` (best-effort). We avoid
// pulling in a JSON dependency tree by relying on tiny field captures.
func monitorsSwaymsg() []MonitorInfo {
	if _, err := exec.LookPath("swaymsg"); err != nil {
		return nil
	}
	out, err := exec.Command("swaymsg", "-t", "get_outputs", "--raw").Output()
	if err != nil {
		return nil
	}
	nameRe := regexp.MustCompile(`"name"\s*:\s*"([^"]+)"`)
	rectRe := regexp.MustCompile(`"rect"\s*:\s*\{\s*"x"\s*:\s*(\-?\d+)\s*,\s*"y"\s*:\s*(\-?\d+)\s*,\s*"width"\s*:\s*(\d+)\s*,\s*"height"\s*:\s*(\d+)`)
	primRe := regexp.MustCompile(`"primary"\s*:\s*(true|false)`)

	names := nameRe.FindAllStringSubmatch(string(out), -1)
	rects := rectRe.FindAllStringSubmatch(string(out), -1)
	prims := primRe.FindAllStringSubmatch(string(out), -1)
	if len(names) == 0 || len(names) != len(rects) {
		return nil
	}
	mons := make([]MonitorInfo, 0, len(names))
	for i := range names {
		x, _ := strconv.Atoi(rects[i][1])
		y, _ := strconv.Atoi(rects[i][2])
		w, _ := strconv.Atoi(rects[i][3])
		h, _ := strconv.Atoi(rects[i][4])
		primary := false
		if i < len(prims) {
			primary = prims[i][1] == "true"
		}
		mons = append(mons, MonitorInfo{
			Index:   i,
			Name:    names[i][1],
			Width:   w,
			Height:  h,
			X:       x,
			Y:       y,
			Primary: primary,
		})
	}
	return mons
}

// desktopCaptureHint returns a short, user-actionable string describing what
// to install to make screen capture work on this Linux machine.
func desktopCaptureHint() string {
	if isWaylandSession() {
		readiness := detectWaylandPortalReadiness()
		switch {
		case readiness.Portal && readiness.PipeWire:
			return "Wayland Portal and PipeWire are available, but this build does not yet implement the required OpenPipeWireRemote file-descriptor bridge. Live portal capture is disabled; install grim or wayshot for screenshot fallback, or use an X11 session."
		case readiness.Portal:
			return "Wayland Portal is available but PipeWire is not reachable in this session. Live portal capture is disabled; install grim or wayshot for screenshot fallback, or use an X11 session."
		case readiness.PipeWire:
			return "PipeWire is available but no XDG Desktop Portal service was detected. Live Wayland capture is disabled; install grim or wayshot for screenshot fallback, or use an X11 session."
		default:
			return "No usable XDG Desktop Portal/PipeWire pair was detected for this Wayland session. Install grim or wayshot for screenshot fallback, or use an X11 session."
		}
	}
	if !hasX11Display() {
		return "No graphical X11 display is available to this agent process. Start it in the logged-in desktop session with $DISPLAY set."
	}
	return "Install ffmpeg or scrot/grim/imagemagick (e.g. 'sudo apt install ffmpeg' or 'sudo dnf install ffmpeg') and ensure $DISPLAY is set."
}
