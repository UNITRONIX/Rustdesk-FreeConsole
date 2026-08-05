package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"os/exec"
	"runtime"
	"sync"
)

// AudioStreamer captures system audio and sends frames over CDAP.
type AudioStreamer struct {
	sessionID string
	cancel    context.CancelFunc
	done      chan struct{}
	once      sync.Once
}

func newAudioStreamer(sessionID string, cancel context.CancelFunc) *AudioStreamer {
	return &AudioStreamer{
		sessionID: sessionID,
		cancel:    cancel,
		done:      make(chan struct{}),
	}
}

func (a *AudioStreamer) Stop() {
	a.once.Do(func() { a.cancel() })
	<-a.done
}

// audioCodecCapability reports the only audio codec the agent can safely
// advertise. The current platform capture commands are best-effort probes and
// emit muxed Ogg chunks, not the packetized Opus media contract CDAP expects.
// Until a backend produces that contract reliably and is declared in the
// manifest, audio remains unavailable rather than being falsely negotiated.
func (a *Agent) audioCodecCapability() string {
	return CodecNone
}

func (a *Agent) handleAudioStart(msg *Message) {
	var p struct {
		SessionID string `json:"session_id"`
	}
	_ = json.Unmarshal(msg.Payload, &p)
	if p.SessionID == "" {
		p.SessionID = "default"
	}
	if a.audioCodecCapability() == CodecNone {
		log.Printf("[audio] audio_start rejected: audio is not supported by this agent build")
		_ = a.sendMessage("audio_end", map[string]any{
			"session_id": p.SessionID,
			"reason":     "audio capability unavailable",
		})
		return
	}

	if old, loaded := a.audioStreams.LoadAndDelete(p.SessionID); loaded {
		old.(*AudioStreamer).Stop()
	}

	ctx, cancel := context.WithCancel(a.ctx)
	streamer := newAudioStreamer(p.SessionID, cancel)
	a.audioStreams.Store(p.SessionID, streamer)

	go func() {
		defer close(streamer.done)
		defer a.audioStreams.Delete(p.SessionID)
		a.streamAudio(ctx, streamer)
	}()
}

func (a *Agent) handleAudioStop(msg *Message) {
	var p struct {
		SessionID string `json:"session_id"`
	}
	_ = json.Unmarshal(msg.Payload, &p)
	if p.SessionID == "" {
		p.SessionID = "default"
	}
	if sess, loaded := a.audioStreams.LoadAndDelete(p.SessionID); loaded {
		sess.(*AudioStreamer).Stop()
	}
}

func (a *Agent) streamAudio(ctx context.Context, s *AudioStreamer) {
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		log.Printf("[audio] ffmpeg not found")
		return
	}
	args := audioCaptureArgs()
	if len(args) == 0 {
		log.Printf("[audio] no capture backend for %s", runtime.GOOS)
		return
	}
	args = append([]string{"-hide_banner", "-loglevel", "error"}, args...)
	args = append(args,
		"-ac", "1",
		"-ar", "48000",
		"-c:a", "libopus",
		"-b:a", "64k",
		"-f", "ogg",
		"-",
	)
	cmd := exec.CommandContext(ctx, ffmpegPath, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return
	}
	if err := cmd.Start(); err != nil {
		log.Printf("[audio] start failed: %v", err)
		return
	}
	buf := make([]byte, 4096)
	for {
		n, rerr := stdout.Read(buf)
		if n > 0 {
			_ = a.sendMessage("audio_frame", map[string]any{
				"session_id": s.sessionID,
				"codec":      "opus",
				"data":       base64.StdEncoding.EncodeToString(buf[:n]),
			})
		}
		if rerr != nil {
			if rerr != io.EOF {
				log.Printf("[audio] read: %v", rerr)
			}
			break
		}
		select {
		case <-ctx.Done():
			_ = cmd.Process.Kill()
			return
		default:
		}
	}
	_ = cmd.Wait()
}
