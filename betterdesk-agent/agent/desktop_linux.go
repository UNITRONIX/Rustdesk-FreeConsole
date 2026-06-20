//go:build linux

package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/godbus/dbus/v5"
)

// isWaylandSession returns true when running under a Wayland compositor.
func isWaylandSession() bool {
	if os.Getenv("WAYLAND_DISPLAY") != "" {
		return true
	}
	if strings.EqualFold(os.Getenv("XDG_SESSION_TYPE"), "wayland") {
		return true
	}
	return false
}

// hasX11Display returns true when an X11 display is available.
// This includes XWayland sessions running inside Wayland compositors.
func hasX11Display() bool {
	return os.Getenv("DISPLAY") != ""
}

// x11Display returns the X11 DISPLAY value, defaulting to ":0".
func x11Display() string {
	if v := os.Getenv("DISPLAY"); v != "" {
		return v
	}
	return ":0"
}

// captureDevice returns the ffmpeg input format (used only by screenshot fallback).
func captureDevice() string {
	if isWaylandSession() && !hasX11Display() {
		return "pipewire"
	}
	return "x11grab"
}

// captureInput returns the ffmpeg input source (used only by screenshot fallback).
func captureInput() string {
	if isWaylandSession() && !hasX11Display() {
		return "0"
	}
	return x11Display()
}

// captureFFmpegInputArgs is kept for backwards compatibility with code paths
// that want a single best-guess input. Streaming uses captureFFmpegStrategies.
func captureFFmpegInputArgs(fps int) []string {
	if isWaylandSession() && !hasX11Display() {
		return []string{
			"-f", "pipewire",
			"-i", "0",
			"-vf", fmt.Sprintf("fps=%d", fps),
		}
	}
	return []string{
		"-f", "x11grab",
		"-framerate", fmt.Sprintf("%d", fps),
		"-i", x11Display(),
	}
}

// captureFFmpegStrategies returns an ordered list of ffmpeg capture pipelines
// for the current Linux session. The streamer tries them in order until one
// produces frames.
//
// Order on Wayland (KDE / GNOME / sway):
//  1. xdg-desktop-portal ScreenCast → pipewire (NATIVE, captures everything)
//  2. kmsgrab (DRM, requires CAP_SYS_ADMIN or root)
//  3. x11grab on :0 (XWayland — usually shows only X11 windows or a blank
//     root, but better than nothing as a last resort)
//
// Order on X11:
//  1. x11grab on $DISPLAY
//
// Order on bare TTY:
//  1. kmsgrab
func captureFFmpegStrategies(fps int, streamer *DesktopStreamer) []CaptureStrategy {
	var out []CaptureStrategy

	if isWaylandSession() {
		// 1. Native Wayland via xdg-desktop-portal → PipeWire.
		if node, _, portal, err := openScreenCastPortal(); err == nil {
			if streamer != nil {
				streamer.setPortalCleanup(portal.close)
			}
			// Prefer gst-launch-1.0 — its pipewiresrc plugin is shipped with
			// every standard Wayland install (gstreamer1-plugins-good +
			// gstreamer1-plugin-pipewire). ffmpeg's `-f pipewire` demuxer is
			// rarely compiled in (Fedora/Nobara/Debian don't ship it) so we
			// avoid that path entirely on Wayland.
			if gst, err := exec.LookPath("gst-launch-1.0"); err == nil {
				out = append(out, CaptureStrategy{
					Name: fmt.Sprintf("gst-pipewire(node=%d)", node),
					FullCommand: []string{
						gst, "-q",
						"pipewiresrc", fmt.Sprintf("path=%d", node), "do-timestamp=true",
						"!", "videoconvert",
						"!", "videorate",
						"!", fmt.Sprintf("video/x-raw,framerate=%d/1", fps),
						"!", "jpegenc", "quality=%QUALITY%",
						"!", "fdsink", "fd=1",
					},
					PortalBacked: true,
				})
			}
			// ffmpeg pipewire (only works if ffmpeg was built --enable-libpipewire).
			out = append(out, CaptureStrategy{
				Name: fmt.Sprintf("ffmpeg-pipewire(node=%d)", node),
				Args: []string{
					"-f", "pipewire",
					"-i", fmt.Sprintf("%d", node),
					"-vf", fmt.Sprintf("fps=%d", fps),
				},
				PortalBacked: true,
			})
			_ = portal // restore token persistence is a follow-up
		}

		// 2. KMS direct capture (requires permissions; usually root).
		if hasKMSAccess() {
			out = append(out, CaptureStrategy{
				Name: "kmsgrab",
				Args: []string{
					"-f", "kmsgrab",
					"-framerate", fmt.Sprintf("%d", fps),
					"-i", "-",
				},
			})
		}

		// 3. XWayland fallback (rarely useful but cheap to try).
		if hasX11Display() {
			out = append(out, CaptureStrategy{
				Name: "x11grab(XWayland)",
				Args: []string{
					"-f", "x11grab",
					"-framerate", fmt.Sprintf("%d", fps),
					"-i", x11Display(),
				},
			})
		}
		return out
	}

	// Pure X11 session.
	if hasX11Display() {
		out = append(out, CaptureStrategy{
			Name: "x11grab",
			Args: []string{
				"-f", "x11grab",
				"-framerate", fmt.Sprintf("%d", fps),
				"-i", x11Display(),
			},
		})
	}

	// Bare TTY / kiosk: kmsgrab is the only option.
	if hasKMSAccess() {
		out = append(out, CaptureStrategy{
			Name: "kmsgrab",
			Args: []string{
				"-f", "kmsgrab",
				"-framerate", fmt.Sprintf("%d", fps),
				"-i", "-",
			},
		})
	}
	return out
}

// hasKMSAccess returns true when ffmpeg's kmsgrab device is likely usable
// (i.e. /dev/dri/card0 exists and is readable). It does NOT verify CAP_SYS_ADMIN
// because requesting that capability requires running ffmpeg first.
func hasKMSAccess() bool {
	for _, path := range []string{"/dev/dri/card0", "/dev/dri/card1"} {
		if f, err := os.Open(path); err == nil {
			_ = f.Close()
			return true
		}
	}
	return false
}

// ── xdg-desktop-portal ScreenCast ────────────────────────────────────────
//
// The portal flow is:
//   1. CreateSession  → returns a session handle
//   2. SelectSources  → declares we want a monitor and persistence mode
//   3. Start          → user is prompted; on success returns PipeWire streams
//   4. OpenPipeWireRemote → returns an FD we can hand to ffmpeg
//
// Each portal call returns a request handle; the actual response arrives
// asynchronously on a Response signal. We block on a per-request channel
// with a short timeout so the streamer fails fast when the portal is missing
// or the user denies consent.

// portalCallTimeout caps the total round-trip for a single portal call.
const portalCallTimeout = 12 * time.Second

// portalScreenCastSession tracks an active xdg-desktop-portal ScreenCast
// session so it can be closed when the remote desktop stream ends.
type portalScreenCastSession struct {
	sessionPath dbus.ObjectPath
}

func (p *portalScreenCastSession) close() {
	if p == nil || p.sessionPath == "" {
		return
	}
	conn, err := dbus.SessionBus()
	if err != nil {
		log.Printf("[desktop] portal CloseSession: session bus: %v", err)
		return
	}
	portal := conn.Object(
		"org.freedesktop.portal.Desktop",
		dbus.ObjectPath("/org/freedesktop/portal/desktop"),
	)
	if err := portal.Call(
		"org.freedesktop.portal.ScreenCast.CloseSession", 0, p.sessionPath,
	).Err; err != nil {
		log.Printf("[desktop] portal CloseSession: %v", err)
		return
	}
	log.Printf("[desktop] portal screencast session closed (%s)", p.sessionPath)
}

// openScreenCastPortal opens an xdg-desktop-portal ScreenCast session,
// negotiates a single monitor stream, and returns the PipeWire node ID for
// ffmpeg's `-f pipewire -i <node>` input plus a handle for CloseSession.
//
// Returns an error if the portal is unreachable, the user denies the prompt,
// or any step in the handshake times out. The caller is expected to fall
// back to another capture strategy in that case.
func openScreenCastPortal() (uint32, string, *portalScreenCastSession, error) {
	conn, err := dbus.SessionBus()
	if err != nil {
		return 0, "", nil, fmt.Errorf("dbus session: %w", err)
	}

	portal := conn.Object(
		"org.freedesktop.portal.Desktop",
		dbus.ObjectPath("/org/freedesktop/portal/desktop"),
	)

	// 1. CreateSession ----------------------------------------------------
	sessionHandleToken := newPortalToken()
	createReqToken := newPortalToken()
	createReqPath := requestPath(conn, createReqToken)

	createCh := subscribePortalResponse(conn, createReqPath)
	defer unsubscribePortalResponse(conn, createReqPath)

	createOpts := map[string]dbus.Variant{
		"handle_token":         dbus.MakeVariant(createReqToken),
		"session_handle_token": dbus.MakeVariant(sessionHandleToken),
	}

	var createReply dbus.ObjectPath
	if err := portal.Call(
		"org.freedesktop.portal.ScreenCast.CreateSession", 0, createOpts,
	).Store(&createReply); err != nil {
		return 0, "", nil, fmt.Errorf("CreateSession: %w", err)
	}

	createResp, err := waitPortalResponse(createCh, portalCallTimeout)
	if err != nil {
		return 0, "", nil, fmt.Errorf("CreateSession response: %w", err)
	}
	sessionHandleVar, ok := createResp["session_handle"]
	if !ok {
		return 0, "", nil, fmt.Errorf("CreateSession: no session_handle")
	}
	sessionHandle, ok := sessionHandleVar.Value().(string)
	if !ok || sessionHandle == "" {
		return 0, "", nil, fmt.Errorf("CreateSession: bad session_handle type")
	}
	sessionPath := dbus.ObjectPath(sessionHandle)
	portalHandle := &portalScreenCastSession{sessionPath: sessionPath}

	// 2. SelectSources ----------------------------------------------------
	selectReqToken := newPortalToken()
	selectReqPath := requestPath(conn, selectReqToken)

	selectCh := subscribePortalResponse(conn, selectReqPath)
	defer unsubscribePortalResponse(conn, selectReqPath)

	// types: 1 = MONITOR, 2 = WINDOW, 4 = VIRTUAL  (bitmask)
	// cursor_mode: 1 = HIDDEN, 2 = EMBEDDED, 4 = METADATA
	// persist_mode: 0 = no, 1 = transient (until logout), 2 = permanent
	selectOpts := map[string]dbus.Variant{
		"handle_token": dbus.MakeVariant(selectReqToken),
		"types":        dbus.MakeVariant(uint32(1)),
		"multiple":     dbus.MakeVariant(false),
		"cursor_mode":  dbus.MakeVariant(uint32(2)),
		"persist_mode": dbus.MakeVariant(uint32(0)),
	}

	if err := portal.Call(
		"org.freedesktop.portal.ScreenCast.SelectSources", 0,
		sessionPath, selectOpts,
	).Store(&createReply); err != nil {
		return 0, "", nil, fmt.Errorf("SelectSources: %w", err)
	}
	if _, err := waitPortalResponse(selectCh, portalCallTimeout); err != nil {
		return 0, "", nil, fmt.Errorf("SelectSources response: %w", err)
	}

	// 3. Start ------------------------------------------------------------
	startReqToken := newPortalToken()
	startReqPath := requestPath(conn, startReqToken)

	startCh := subscribePortalResponse(conn, startReqPath)
	defer unsubscribePortalResponse(conn, startReqPath)

	startOpts := map[string]dbus.Variant{
		"handle_token": dbus.MakeVariant(startReqToken),
	}

	if err := portal.Call(
		"org.freedesktop.portal.ScreenCast.Start", 0,
		sessionPath, "", startOpts,
	).Store(&createReply); err != nil {
		return 0, "", nil, fmt.Errorf("Start: %w", err)
	}
	startResp, err := waitPortalResponse(startCh, portalCallTimeout)
	if err != nil {
		return 0, "", nil, fmt.Errorf("Start response: %w", err)
	}

	streamsVar, ok := startResp["streams"]
	if !ok {
		return 0, "", nil, fmt.Errorf("Start: no streams in response")
	}
	streams, ok := streamsVar.Value().([][]interface{})
	if !ok {
		// Some portal versions wrap streams as []interface{} of structs.
		alt, _ := streamsVar.Value().([]interface{})
		for _, s := range alt {
			if pair, ok := s.([]interface{}); ok && len(pair) >= 1 {
				if node, ok := pair[0].(uint32); ok {
					rt, _ := startResp["restore_token"].Value().(string)
					return node, rt, portalHandle, nil
				}
			}
		}
		// Some bindings unmarshal as []struct{ uint32; map[string]variant }
		if raw, err := json.Marshal(streamsVar.Value()); err == nil {
			return 0, "", nil, fmt.Errorf("Start: unsupported streams shape (%s)", raw)
		}
		return 0, "", nil, fmt.Errorf("Start: unsupported streams shape")
	}
	if len(streams) == 0 {
		return 0, "", nil, fmt.Errorf("Start: empty streams")
	}
	first := streams[0]
	if len(first) < 1 {
		return 0, "", nil, fmt.Errorf("Start: bad stream tuple")
	}
	node, ok := first[0].(uint32)
	if !ok {
		return 0, "", nil, fmt.Errorf("Start: bad node type")
	}

	restoreToken := ""
	if rt, ok := startResp["restore_token"]; ok {
		if s, ok := rt.Value().(string); ok {
			restoreToken = s
		}
	}

	return node, restoreToken, portalHandle, nil
}

// newPortalToken returns a unique per-call handle token.
func newPortalToken() string {
	return fmt.Sprintf("bd_%d", time.Now().UnixNano())
}

// requestPath computes the org.freedesktop.portal.Request object path
// the portal will emit a Response signal on for a given token.
func requestPath(conn *dbus.Conn, token string) dbus.ObjectPath {
	// The bus name is sender-specific; portal mangles it according to the spec.
	sender := strings.ReplaceAll(strings.TrimPrefix(conn.Names()[0], ":"), ".", "_")
	return dbus.ObjectPath(fmt.Sprintf(
		"/org/freedesktop/portal/desktop/request/%s/%s", sender, token,
	))
}

// subscribePortalResponse adds a match rule and returns a channel that
// receives the Response signal payload for the given request path.
func subscribePortalResponse(conn *dbus.Conn, path dbus.ObjectPath) chan map[string]dbus.Variant {
	ch := make(chan map[string]dbus.Variant, 1)

	rule := fmt.Sprintf(
		"type='signal',interface='org.freedesktop.portal.Request',member='Response',path='%s'",
		path,
	)
	if call := conn.BusObject().Call(
		"org.freedesktop.DBus.AddMatch", 0, rule,
	); call.Err != nil {
		close(ch)
		return ch
	}

	sigCh := make(chan *dbus.Signal, 4)
	conn.Signal(sigCh)

	go func() {
		defer conn.RemoveSignal(sigCh)
		for sig := range sigCh {
			if sig.Path != path {
				continue
			}
			if sig.Name != "org.freedesktop.portal.Request.Response" {
				continue
			}
			if len(sig.Body) < 2 {
				close(ch)
				return
			}
			results, _ := sig.Body[1].(map[string]dbus.Variant)
			ch <- results
			close(ch)
			return
		}
	}()
	return ch
}

// unsubscribePortalResponse removes the match rule installed by subscribePortalResponse.
func unsubscribePortalResponse(conn *dbus.Conn, path dbus.ObjectPath) {
	rule := fmt.Sprintf(
		"type='signal',interface='org.freedesktop.portal.Request',member='Response',path='%s'",
		path,
	)
	_ = conn.BusObject().Call("org.freedesktop.DBus.RemoveMatch", 0, rule).Err
}

// waitPortalResponse blocks on ch up to timeout and returns the response map.
func waitPortalResponse(ch chan map[string]dbus.Variant, timeout time.Duration) (map[string]dbus.Variant, error) {
	select {
	case resp, ok := <-ch:
		if !ok {
			return nil, fmt.Errorf("portal channel closed")
		}
		return resp, nil
	case <-time.After(timeout):
		return nil, fmt.Errorf("timeout after %v", timeout)
	}
}

// (kept to avoid unused-import errors when the build tags evolve)
var _ = context.Background
var _ = exec.Command
