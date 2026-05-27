package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// MonitorInfo describes a single display attached to the agent's machine.
// JSON shape mirrors betterdesk-server/cdap/media_control.go MonitorInfo.
type MonitorInfo struct {
	Index   int    `json:"index"`
	Name    string `json:"name"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	X       int    `json:"x"`
	Y       int    `json:"y"`
	Primary bool   `json:"primary"`
}

// CaptureStrategy describes a single capture pipeline together with a
// human-readable name used in logs. Platform-specific implementations
// return an ordered list of strategies; the first one that produces frames
// wins, the rest are tried as fallbacks.
//
// If FullCommand is non-empty the streamer runs that exact command and
// expects MJPEG bytes on stdout. Otherwise it spawns ffmpeg with Args as
// input flags and appends the standard mjpeg→stdout encoder tail.
type CaptureStrategy struct {
	Name        string
	Args        []string
	FullCommand []string
}

// ── Desktop Streamer ─────────────────────────────────────────────────────

// DesktopStreamer tracks a single active desktop streaming session.
type DesktopStreamer struct {
	sessionID string
	cancel    context.CancelFunc
	once      sync.Once
	done      chan struct{}
	frames    atomic.Int64 // total frames sent on this session
}

func newDesktopStreamer(sessionID string, cancel context.CancelFunc) *DesktopStreamer {
	return &DesktopStreamer{
		sessionID: sessionID,
		cancel:    cancel,
		done:      make(chan struct{}),
	}
}

// recordFrame is called from each capture path after a frame is sent so the
// watchdog can tell whether the pipeline is producing output.
func (d *DesktopStreamer) recordFrame() { d.frames.Add(1) }

// Stop signals the streamer to stop and waits for the goroutine to exit.
func (d *DesktopStreamer) Stop() {
	d.once.Do(func() { d.cancel() })
	<-d.done
}

// ── Handler: desktop_start ───────────────────────────────────────────────

// handleDesktopStart starts a continuous screenshot streaming session.
// Streams at the requested FPS using ffmpeg if available, otherwise
// falls back to periodic single screenshots via CaptureScreenshot().
func (a *Agent) handleDesktopStart(msg *Message) {
	if !a.cfg.Screenshot {
		_ = a.sendMessage("error", map[string]any{
			"code":    403,
			"message": "desktop capture is disabled on this device",
		})
		return
	}

	// Platform-specific permission pre-flight (macOS Screen Recording check).
	// checkScreenRecordingPermission is a no-op on non-darwin platforms.
	if err := checkScreenRecordingPermission(); err != nil {
		_ = a.sendMessage("error", map[string]any{
			"code":    403,
			"message": err.Error(),
		})
		log.Printf("[desktop] %v", err)
		return
	}

	var p struct {
		SessionID    string `json:"session_id"`
		Quality      int    `json:"quality"`
		FPS          int    `json:"fps"`
		OperatorName string `json:"operator_name"`
	}
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		return
	}

	if p.SessionID == "" {
		p.SessionID = "default"
	}
	if p.FPS <= 0 || p.FPS > 60 {
		p.FPS = 15
	}
	if p.Quality <= 0 || p.Quality > 100 {
		p.Quality = 60
	}
	if p.OperatorName == "" {
		p.OperatorName = "operator"
	}

	// ── Consent gate ─────────────────────────────────────────────────────────
	// When require_consent=true, print a request to stdout and wait up to 30s
	// for the Tauri wrapper to respond with CONSENT_GRANTED/DENIED on stdin.
	if a.cfg.RequireConsent {
		ch := make(chan bool, 1)
		a.consentWaiters.Store(p.SessionID, ch)

		// Print to stdout — the Tauri sidecar.rs stdout reader picks this up
		// and emits a "consent-request" event to the SolidJS frontend.
		fmt.Fprintf(os.Stdout, "CONSENT_REQUEST:{\"session_id\":%q,\"operator\":%q}\n",
			p.SessionID, p.OperatorName)

		// Block until response or 30-second timeout.
		var granted bool
		timer := time.NewTimer(30 * time.Second)
		select {
		case granted = <-ch:
		case <-timer.C:
			granted = false
		case <-a.ctx.Done():
			a.consentWaiters.Delete(p.SessionID)
			timer.Stop()
			return
		}
		timer.Stop()
		a.consentWaiters.Delete(p.SessionID)

		if !granted {
			_ = a.sendMessage("desktop_consent_denied", map[string]any{
				"session_id": p.SessionID,
			})
			log.Printf("[desktop] Consent denied for session %s", p.SessionID)
			return
		}
		log.Printf("[desktop] Consent granted for session %s", p.SessionID)
	}

	// Stop any existing session for this session ID.
	if old, loaded := a.desktopStreams.LoadAndDelete(p.SessionID); loaded {
		old.(*DesktopStreamer).Stop()
	}

	ctx, cancel := context.WithCancel(a.ctx)
	streamer := newDesktopStreamer(p.SessionID, cancel)
	a.desktopStreams.Store(p.SessionID, streamer)

	// Notify the Tauri wrapper so it can render the on-screen overlay
	// (border around every monitor + collapsible session widget). The
	// Tauri sidecar stdout reader translates this into a `session-active`
	// event consumed by the SessionOverlay component.
	fmt.Fprintf(os.Stdout,
		"SESSION_START:{\"session_id\":%q,\"operator\":%q,\"mode\":%q}\n",
		p.SessionID, p.OperatorName, sessionModeLabel(a.cfg.RequireConsent))

	// Send the monitor list as soon as the session is accepted so the
	// operator's toolbar can populate its dropdown before any frames
	// arrive. Errors here are non-fatal — single-monitor placeholder is
	// emitted by enumerateMonitors() on platforms without a backend.
	monitors := enumerateMonitors()
	_ = a.sendMessage("monitor_list", map[string]any{
		"session_id": p.SessionID,
		"monitors":   monitors,
		"active":     0,
	})

	// Watchdog: if the capture pipeline does not produce a single frame
	// within the grace period, send a clear error to the operator instead
	// of leaving them looking at a black canvas.
	go a.runDesktopWatchdog(ctx, streamer)

	go func() {
		defer close(streamer.done)
		defer a.desktopStreams.Delete(p.SessionID)
		// Always emit SESSION_END (matched to the SESSION_START above) when
		// the streamer goroutine exits, no matter the reason — stop request,
		// operator disconnect, or watchdog failure. The overlay state machine
		// in the Tauri wrapper depends on the symmetry of these events.
		defer fmt.Fprintf(os.Stdout,
			"SESSION_END:{\"session_id\":%q}\n", p.SessionID)
		a.streamDesktop(ctx, streamer, p.FPS, p.Quality)
	}()
}

// sessionModeLabel converts the consent flag into the human-readable label
// the overlay UI uses to colour its border. The Go side does not yet know
// the full Tauri `access_mode` enum so it reports "supervised" vs
// "unattended" only; the Tauri wrapper can refine the colour if needed.
func sessionModeLabel(requireConsent bool) string {
	if requireConsent {
		return "supervised"
	}
	return "unattended"
}

// runDesktopWatchdog emits an `error` message after 8 seconds if no frame
// has been recorded yet. This converts the silent "black screen" failure
// mode into an actionable diagnostic.
func (a *Agent) runDesktopWatchdog(ctx context.Context, s *DesktopStreamer) {
	const grace = 8 * time.Second
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return
	case <-timer.C:
		if s.frames.Load() > 0 {
			return
		}
		hint := desktopCaptureHint()
		log.Printf("[desktop] no frames produced after %s for session %s — %s", grace, s.sessionID, hint)
		_ = a.sendMessage("error", map[string]any{
			"session_id": s.sessionID,
			"code":       500,
			"message":    "Desktop capture started but produced no frames. " + hint,
		})
	}
}

// handleDesktopStop terminates a streaming session by ID.
func (a *Agent) handleDesktopStop(msg *Message) {
	var p struct {
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(msg.Payload, &p); err != nil || p.SessionID == "" {
		p.SessionID = "default"
	}

	if sess, loaded := a.desktopStreams.LoadAndDelete(p.SessionID); loaded {
		sess.(*DesktopStreamer).Stop()
		log.Printf("[desktop] Stopped session %s", p.SessionID)
	}
}

// handleMonitorSelect updates the active monitor index for a streaming
// session and re-emits the monitor list so the operator's UI reflects the
// new selection. Region-aware capture switching (cropping ffmpeg's input
// to the chosen monitor) is wired in a follow-up — for now any selected
// monitor still streams the whole virtual desktop, but the toolbar's
// active state is correct so the dropdown is usable.
func (a *Agent) handleMonitorSelect(msg *Message) {
	var p struct {
		SessionID string `json:"session_id"`
		Index     int    `json:"index"`
	}
	if err := json.Unmarshal(msg.Payload, &p); err != nil {
		return
	}
	if p.SessionID == "" {
		p.SessionID = "default"
	}
	if _, ok := a.desktopStreams.Load(p.SessionID); !ok {
		return
	}
	monitors := enumerateMonitors()
	active := p.Index
	if active < 0 || active >= len(monitors) {
		active = 0
	}
	_ = a.sendMessage("monitor_list", map[string]any{
		"session_id": p.SessionID,
		"monitors":   monitors,
		"active":     active,
	})
	log.Printf("[desktop] Active monitor for session %s set to %d (%s) — full virtual desktop still streamed; per-monitor capture coming in a follow-up.",
		p.SessionID, active, monitors[active].Name)
}

// captureAndSendScreenshot captures a single screenshot and returns a payload
// suitable for a widget command response.
func (a *Agent) captureAndSendScreenshot() (any, error) {
	data, err := CaptureScreenshot()
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"format": "jpeg",
		"size":   len(data),
		"data":   base64.StdEncoding.EncodeToString(data),
	}, nil
}

// ── Codec Offer ──────────────────────────────────────────────────────────

// handleCodecOffer responds with the agent's actual encoding capabilities.
// os_agent supports JPEG only (screenshot-based). Audio is never supported.
func (a *Agent) handleCodecOffer(msg *Message) {
	var p struct {
		SessionID string `json:"session_id"`
	}
	_ = json.Unmarshal(msg.Payload, &p)

	videoCodec := ""
	if a.cfg.Screenshot {
		videoCodec = "jpeg"
	}

	_ = a.sendMessage("codec_answer", map[string]any{
		"session_id":  p.SessionID,
		"video_codec": videoCodec,
		"audio_codec": "",
	})
}

// ── Streaming logic ──────────────────────────────────────────────────────

// streamDesktop tries ffmpeg first, falls back to periodic screenshots.
func (a *Agent) streamDesktop(ctx context.Context, s *DesktopStreamer, fps, quality int) {
	if streamWithFFmpeg(ctx, a, s, fps, quality) {
		return
	}
	streamFallback(ctx, a, s, fps, quality)
}

// streamWithFFmpeg launches ffmpeg to capture the screen and streams JPEG
// frames to the CDAP server. Returns true if ffmpeg was available and ran.
func streamWithFFmpeg(ctx context.Context, a *Agent, s *DesktopStreamer, fps, quality int) bool {
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		return false
	}

	// ffmpeg MJPEG quality scale: 2 (best) – 31 (worst), mapped from 0–100.
	mquality := 31 - (quality * 29 / 100)
	if mquality < 2 {
		mquality = 2
	}

	// captureFFmpegStrategies is platform-specific and returns an ORDERED list
	// of candidate input pipelines. We try each in turn and stop at the first
	// one that produces frames — this lets us prefer kmsgrab/pipewire on
	// Wayland (where x11grab captures only the empty XWayland root) while
	// still falling back to x11grab on classic X11.
	strategies := captureFFmpegStrategies(fps)
	if len(strategies) == 0 {
		return false
	}

	for _, strat := range strategies {
		var cmd *exec.Cmd
		if len(strat.FullCommand) > 0 {
			// Custom binary (e.g. gst-launch-1.0). Substitute %QUALITY% with
			// the requested 0–100 JPEG quality so callers don't need to know
			// the value at strategy-construction time.
			full := make([]string, len(strat.FullCommand))
			for i, a := range strat.FullCommand {
				full[i] = strings.ReplaceAll(a, "%QUALITY%", fmt.Sprintf("%d", quality))
			}
			cmd = exec.CommandContext(ctx, full[0], full[1:]...)
		} else {
			args := append([]string{"-hide_banner", "-loglevel", "error"}, strat.Args...)
			args = append(args,
				"-vcodec", "mjpeg",
				"-q:v", fmt.Sprintf("%d", mquality),
				"-f", "image2pipe",
				"-",
			)
			cmd = exec.CommandContext(ctx, ffmpegPath, args...)
		}
		stderr := &bytes.Buffer{}
		cmd.Stderr = stderr

		stdout, err := cmd.StdoutPipe()
		if err != nil {
			continue
		}
		if err := cmd.Start(); err != nil {
			log.Printf("[desktop] ffmpeg %s failed to start: %v", strat.Name, err)
			continue
		}

		log.Printf("[desktop] ffmpeg streaming via %s: fps=%d quality=%d", strat.Name, fps, quality)

		frames := 0
		metaSent := false
		readJPEGFrames(ctx, stdout, func(frame []byte) {
			frames++
			if !metaSent {
				w, h := jpegDimensions(frame)
				_ = a.sendMessage("desktop_meta", map[string]any{
					"session_id": s.sessionID,
					"format":     "jpeg",
					"width":      w,
					"height":     h,
					"binary":     true,
				})
				metaSent = true
			}
			if err := sendDesktopBinaryFrame(a, s.sessionID, frame); err == nil {
				s.recordFrame()
			}
		})

		_ = cmd.Wait()

		// If we got at least one frame, the strategy worked — we're done
		// (ctx was cancelled by the session ending normally).
		if frames > 0 || ctx.Err() != nil {
			log.Printf("[desktop] ffmpeg stream ended for session %s (%s, %d frames)", s.sessionID, strat.Name, frames)
			return true
		}

		// No frames produced — likely the capture method is unavailable.
		// Log stderr (truncated) and try the next strategy.
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 400 {
			msg = msg[:400] + "…"
		}
		log.Printf("[desktop] %s produced no frames, trying next strategy. stderr: %s", strat.Name, msg)
	}

	return false
}

// readJPEGFrames reads concatenated JPEG frames from r and calls onFrame for
// each complete frame delimited by FF D8 … FF D9.
func readJPEGFrames(ctx context.Context, r io.Reader, onFrame func([]byte)) {
	const bufSize = 256 * 1024
	buf := make([]byte, 0, bufSize)
	tmp := make([]byte, 32768)

	jpegSOI := []byte{0xFF, 0xD8}
	jpegEOI := []byte{0xFF, 0xD9}

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		n, readErr := r.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}

		// Extract all complete JPEG frames present in the buffer.
		for {
			start := bytes.Index(buf, jpegSOI)
			if start < 0 {
				buf = buf[:0]
				break
			}
			end := bytes.Index(buf[start+2:], jpegEOI)
			if end < 0 {
				// Incomplete frame — keep data in buffer.
				if start > 0 {
					buf = buf[start:]
				}
				break
			}
			end = start + 2 + end + 2 // include FF D9 bytes

			frame := make([]byte, end-start)
			copy(frame, buf[start:end])
			onFrame(frame)
			buf = buf[end:]
		}

		if readErr == io.EOF {
			return
		}
		if readErr != nil {
			log.Printf("[desktop] ffmpeg read error: %v", readErr)
			return
		}

		// Guard against unbounded buffer growth on malformed stream.
		if len(buf) > 8*1024*1024 {
			log.Printf("[desktop] buffer overflow — resetting")
			buf = buf[:0]
		}
	}
}

// streamFallback periodically captures a screenshot and sends it as a frame.
func streamFallback(ctx context.Context, a *Agent, s *DesktopStreamer, fps, _ int) {
	if fps <= 0 {
		fps = 5
	}
	interval := time.Duration(1000/fps) * time.Millisecond
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	log.Printf("[desktop] Using screenshot fallback: fps=%d interval=%v", fps, interval)

	metaSent := false
	failures := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			data, err := CaptureScreenshot()
			if err != nil {
				failures++
				if failures == 1 || failures%20 == 0 {
					log.Printf("[desktop] Screenshot failed (%d times): %v", failures, err)
				}
				if failures == 5 {
					_ = a.sendMessage("error", map[string]any{
						"session_id": s.sessionID,
						"code":       500,
						"message":    "Screenshot fallback failing repeatedly: " + err.Error() + ". " + desktopCaptureHint(),
					})
				}
				continue
			}
			failures = 0
			if !metaSent {
				w, h := jpegDimensions(data)
				_ = a.sendMessage("desktop_meta", map[string]any{
					"session_id": s.sessionID,
					"format":     "jpeg",
					"width":      w,
					"height":     h,
					"binary":     true,
				})
				metaSent = true
			}
			if err := sendDesktopBinaryFrame(a, s.sessionID, data); err == nil {
				s.recordFrame()
			}
		}
	}
}

// frameHeaderSize must match betterdesk-server/cdap/desktop.go's
// frameHeaderSize. The agent zero-pads the session ID to this size and
// prepends it to every binary JPEG frame.
const frameHeaderSize = 64

// sendDesktopBinaryFrame writes a single JPEG frame as a binary WebSocket
// message: [64 bytes session ID, NUL-padded][raw JPEG bytes].
// This avoids the ~33% base64 overhead and the JSON marshal/parse cost
// for every frame, which is the difference between 1–3 fps and 30+ fps
// on a typical helpdesk workload.
func sendDesktopBinaryFrame(a *Agent, sessionID string, jpeg []byte) error {
	if len(sessionID) > frameHeaderSize {
		sessionID = sessionID[:frameHeaderSize]
	}
	buf := make([]byte, frameHeaderSize+len(jpeg))
	copy(buf[:frameHeaderSize], []byte(sessionID))
	// Remaining bytes of the header are already zero from make().
	copy(buf[frameHeaderSize:], jpeg)
	return a.sendBinary(buf)
}

// jpegDimensions parses width and height from the first SOFn marker in a
// JPEG byte slice. Returns (0, 0) if the data isn't a parseable JPEG.
func jpegDimensions(data []byte) (int, int) {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 0, 0
	}
	i := 2
	for i+8 < len(data) {
		if data[i] != 0xFF {
			return 0, 0
		}
		marker := data[i+1]
		// SOI / EOI / restart markers have no length field.
		if marker == 0xD8 || marker == 0xD9 || (marker >= 0xD0 && marker <= 0xD7) {
			i += 2
			continue
		}
		segLen := int(data[i+2])<<8 | int(data[i+3])
		// SOF0–SOF15 except DHT (0xC4), DAC (0xCC), JPG (0xC8).
		if marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
			if i+9 < len(data) {
				h := int(data[i+5])<<8 | int(data[i+6])
				w := int(data[i+7])<<8 | int(data[i+8])
				return w, h
			}
			return 0, 0
		}
		i += 2 + segLen
	}
	return 0, 0
}
