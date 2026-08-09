package signalhost

import (
	"context"
	"io"
	"os/exec"
	"strconv"
	"sync"
	"time"

	pb "github.com/unitronix/betterdesk-server/proto"
)

type negotiatedVideoCodec uint8

const (
	videoCodecNone negotiatedVideoCodec = iota
	videoCodecH264
)

const (
	defaultStreamFPS     = 15
	minStreamFPS         = 2
	maxStreamFPS         = 30
	defaultStreamQuality = 65
	minStreamQuality     = 30
	maxStreamQuality     = 90

	encoderReconfigureInterval = 2 * time.Second
	encoderRecoveryInterval    = 6 * time.Second
	healthyWriteSamples        = 12
)

type videoSettings struct {
	fps     int
	quality int
}

// streamState holds the negotiated H.264 settings for one relay session.
// FFmpeg cannot safely reconfigure an Annex-B encoder in place, so a bounded
// restart is used to apply a change and ensure the next frame is a real IDR.
type streamState struct {
	mu sync.Mutex

	codec negotiatedVideoCodec

	targetFPS     int
	targetQuality int
	fps           int
	quality       int

	lastRestart   time.Time
	healthyWrites int
	reconfigure   chan struct{}
}

func newStreamState(codec negotiatedVideoCodec, options *pb.OptionMessage) *streamState {
	settings := requestedVideoSettings(options)
	return &streamState{
		codec:         codec,
		targetFPS:     settings.fps,
		targetQuality: settings.quality,
		fps:           settings.fps,
		quality:       settings.quality,
		reconfigure:   make(chan struct{}, 1),
	}
}

func requestedVideoSettings(options *pb.OptionMessage) videoSettings {
	settings := videoSettings{
		fps:     defaultStreamFPS,
		quality: defaultStreamQuality,
	}
	if quality, ok := requestedQuality(options); ok {
		settings.quality = quality
	}
	if fps, ok := requestedFPS(options); ok {
		settings.fps = fps
	}
	return settings
}

func requestedQuality(options *pb.OptionMessage) (int, bool) {
	if options == nil {
		return 0, false
	}
	if custom := options.GetCustomImageQuality(); custom > 0 {
		return clampStreamQuality(int(custom)), true
	}
	switch options.GetImageQuality() {
	case pb.ImageQuality_Low:
		return 40, true
	case pb.ImageQuality_Balanced:
		return defaultStreamQuality, true
	case pb.ImageQuality_Best:
		return 85, true
	default:
		return 0, false
	}
}

func requestedFPS(options *pb.OptionMessage) (int, bool) {
	if options == nil || options.GetCustomFps() <= 0 {
		return 0, false
	}
	return clampStreamFPS(int(options.GetCustomFps())), true
}

func clampStreamQuality(quality int) int {
	if quality < minStreamQuality {
		return minStreamQuality
	}
	if quality > maxStreamQuality {
		return maxStreamQuality
	}
	return quality
}

func clampStreamFPS(fps int) int {
	if fps < minStreamFPS {
		return minStreamFPS
	}
	if fps > maxStreamFPS {
		return maxStreamFPS
	}
	return fps
}

// h264CRF maps the negotiated 0-100 quality scale to libx264's CRF range.
// The exposed quality is deliberately clamped before this conversion.
func h264CRF(quality int) int {
	quality = clampStreamQuality(quality)
	return 42 - quality*28/100
}

// ffmpegStreamArgsForQuality inserts the CRF before the pixel-format output
// option. Platform-specific files retain ownership of their capture inputs.
func ffmpegStreamArgsForQuality(fps, quality int) []string {
	args := ffmpegStreamArgs(fps)
	if len(args) == 0 {
		return nil
	}

	out := make([]string, 0, len(args)+2)
	inserted := false
	for _, arg := range args {
		if arg == "-pix_fmt" && !inserted {
			out = append(out, "-crf", strconv.Itoa(h264CRF(quality)))
			inserted = true
		}
		out = append(out, arg)
	}
	if inserted {
		return out
	}

	// All supported platform arguments include -pix_fmt today. Keep a safe
	// fallback if a future capture path does not: insert before the output URL.
	if len(out) > 0 {
		last := out[len(out)-1]
		out = out[:len(out)-1]
		out = append(out, "-crf", strconv.Itoa(h264CRF(quality)), last)
	}
	return out
}

func frameInterval(fps int) time.Duration {
	return time.Second / time.Duration(clampStreamFPS(fps))
}

func (s *streamState) settings() videoSettings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return videoSettings{fps: s.fps, quality: s.quality}
}

func (s *streamState) markEncoderStarted(now time.Time) {
	s.mu.Lock()
	s.lastRestart = now
	s.healthyWrites = 0
	s.mu.Unlock()
}

func (s *streamState) applyPeerOptions(options *pb.OptionMessage, now time.Time) bool {
	quality, hasQuality := requestedQuality(options)
	fps, hasFPS := requestedFPS(options)
	if !hasQuality && !hasFPS {
		return false
	}

	s.mu.Lock()
	if !s.canReconfigureLocked(now) {
		s.mu.Unlock()
		return false
	}

	next := videoSettings{fps: s.fps, quality: s.quality}
	targetFPS, targetQuality := s.targetFPS, s.targetQuality
	if hasFPS {
		next.fps = fps
		targetFPS = fps
	}
	if hasQuality {
		next.quality = quality
		targetQuality = quality
	}
	if next.fps == s.fps && next.quality == s.quality &&
		targetFPS == s.targetFPS && targetQuality == s.targetQuality {
		s.mu.Unlock()
		return false
	}

	s.fps = next.fps
	s.quality = next.quality
	s.targetFPS = targetFPS
	s.targetQuality = targetQuality
	s.lastRestart = now
	s.healthyWrites = 0
	s.mu.Unlock()
	s.requestReconfigure()
	return true
}

// requestKeyframe starts a fresh H.264 encoder rather than marking an arbitrary
// delta frame as key. The restart rate limit prevents a peer from using refresh
// requests to repeatedly spawn encoders.
func (s *streamState) requestKeyframe(now time.Time) bool {
	s.mu.Lock()
	if !s.canReconfigureLocked(now) {
		s.mu.Unlock()
		return false
	}
	s.lastRestart = now
	s.healthyWrites = 0
	s.mu.Unlock()
	s.requestReconfigure()
	return true
}

// observeWrite feeds transport backpressure into a bounded controller. It
// changes FPS and quality only by restarting the local encoder, which keeps the
// H.264 stream decodable instead of dropping inter-frame deltas.
func (s *streamState) observeWrite(elapsed time.Duration) {
	if s.adjustForWrite(elapsed, time.Now()) {
		s.requestReconfigure()
	}
}

func (s *streamState) adjustForWrite(elapsed time.Duration, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	interval := frameInterval(s.fps)
	slowThreshold := 3 * interval
	if slowThreshold < 200*time.Millisecond {
		slowThreshold = 200 * time.Millisecond
	}
	if elapsed >= slowThreshold {
		if !s.canReconfigureLocked(now) {
			return false
		}
		nextFPS := s.fps - 2
		if nextFPS < minStreamFPS {
			nextFPS = minStreamFPS
		}
		nextQuality := s.quality - 8
		if nextQuality < minStreamQuality {
			nextQuality = minStreamQuality
		}
		if nextFPS == s.fps && nextQuality == s.quality {
			s.healthyWrites = 0
			return false
		}
		s.fps = nextFPS
		s.quality = nextQuality
		s.lastRestart = now
		s.healthyWrites = 0
		return true
	}

	if elapsed <= interval/4 {
		s.healthyWrites++
		if s.healthyWrites < healthyWriteSamples ||
			now.Sub(s.lastRestart) < encoderRecoveryInterval ||
			!s.canReconfigureLocked(now) {
			return false
		}

		nextFPS := s.fps + 1
		if nextFPS > s.targetFPS {
			nextFPS = s.targetFPS
		}
		nextQuality := s.quality + 4
		if nextQuality > s.targetQuality {
			nextQuality = s.targetQuality
		}
		if nextFPS == s.fps && nextQuality == s.quality {
			return false
		}
		s.fps = nextFPS
		s.quality = nextQuality
		s.lastRestart = now
		s.healthyWrites = 0
		return true
	}

	s.healthyWrites = 0
	return false
}

func (s *streamState) canReconfigureLocked(now time.Time) bool {
	return s.lastRestart.IsZero() || now.Sub(s.lastRestart) >= encoderReconfigureInterval
}

func (s *streamState) requestReconfigure() {
	select {
	case s.reconfigure <- struct{}{}:
	default:
	}
}

func supportedEncodingForH264(h264 bool) *pb.SupportedEncoding {
	if !h264 {
		return nil
	}
	return &pb.SupportedEncoding{H264: true}
}

// negotiateVideoCodec requires an explicit decoder capability from the peer.
// An absent or zero ability is not treated as an H.264 fallback because doing
// so can send undecodable video to clients that only support another codec.
func negotiateVideoCodec(local *pb.SupportedEncoding, peer *pb.SupportedDecoding) negotiatedVideoCodec {
	if local == nil || !local.GetH264() || peer == nil || peer.GetAbilityH264() <= 0 {
		return videoCodecNone
	}
	return videoCodecH264
}

func (codec negotiatedVideoCodec) String() string {
	switch codec {
	case videoCodecH264:
		return "h264"
	default:
		return "none"
	}
}

var h264Probe struct {
	once      sync.Once
	supported bool
}

func advertisedVideoEncoding() *pb.SupportedEncoding {
	return supportedEncodingForH264(h264EncoderSupported())
}

// h264EncoderSupported verifies the exact encoder and output format used by
// this host. Merely finding an ffmpeg binary is not enough to advertise H.264.
func h264EncoderSupported() bool {
	h264Probe.once.Do(func() {
		if len(ffmpegStreamArgs(defaultStreamFPS)) == 0 {
			return
		}
		path, err := exec.LookPath("ffmpeg")
		if err != nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, path,
			"-hide_banner", "-loglevel", "error",
			"-f", "lavfi", "-i", "color=c=black:s=16x16:r=1",
			"-frames:v", "1",
			"-c:v", "libx264",
			"-preset", "ultrafast",
			"-tune", "zerolatency",
			"-pix_fmt", "yuv420p",
			"-f", "h264", "-",
		)
		hideConsole(cmd)
		cmd.Stdout = io.Discard
		cmd.Stderr = io.Discard
		h264Probe.supported = cmd.Run() == nil
	})
	return h264Probe.supported
}
