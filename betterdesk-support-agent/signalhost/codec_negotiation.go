package signalhost

import (
	"sync"
	"time"

	pb "github.com/unitronix/betterdesk-server/proto"
)

type negotiatedVideoCodec uint8

const (
	videoCodecNone negotiatedVideoCodec = iota
	videoCodecH264
	videoCodecH265
	videoCodecVP8
	videoCodecVP9
	videoCodecAV1
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

// h264CRF maps the negotiated 0-100 quality scale to libx264/libx265 CRF.
func h264CRF(quality int) int {
	quality = clampStreamQuality(quality)
	return 42 - quality*28/100
}

func frameInterval(fps int) time.Duration {
	return time.Second / time.Duration(clampStreamFPS(fps))
}

func (c negotiatedVideoCodec) wire() string {
	switch c {
	case videoCodecH264:
		return wireH264
	case videoCodecH265:
		return wireH265
	case videoCodecVP8:
		return wireVP8
	case videoCodecVP9:
		return wireVP9
	case videoCodecAV1:
		return wireAV1
	default:
		return wireNone
	}
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
	var nextCodec negotiatedVideoCodec
	hasCodec := false
	if sd := options.GetSupportedDecoding(); sd != nil {
		nextCodec = negotiateVideoCodec(advertisedVideoEncoding(), sd)
		hasCodec = nextCodec != videoCodecNone
	}
	if !hasQuality && !hasFPS && !hasCodec {
		return false
	}

	s.mu.Lock()
	if !s.canReconfigureLocked(now) {
		s.mu.Unlock()
		return false
	}

	next := videoSettings{fps: s.fps, quality: s.quality}
	targetFPS, targetQuality := s.targetFPS, s.targetQuality
	changed := false
	if hasFPS {
		next.fps = fps
		targetFPS = fps
	}
	if hasQuality {
		next.quality = quality
		targetQuality = quality
	}
	if hasCodec && nextCodec != s.codec {
		s.codec = nextCodec
		changed = true
	}
	if next.fps != s.fps || next.quality != s.quality ||
		targetFPS != s.targetFPS || targetQuality != s.targetQuality {
		s.fps = next.fps
		s.quality = next.quality
		s.targetFPS = targetFPS
		s.targetQuality = targetQuality
		changed = true
	}
	if !changed {
		s.mu.Unlock()
		return false
	}

	s.lastRestart = now
	s.healthyWrites = 0
	s.mu.Unlock()
	s.requestReconfigure()
	return true
}

func (s *streamState) currentCodec() negotiatedVideoCodec {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.codec
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

func supportedEncodingFromCaps(caps encodeCaps) *pb.SupportedEncoding {
	if !caps.h264 && !caps.h265 && !caps.vp8 && !caps.av1 {
		// VP9 is not a field on SupportedEncoding in the RustDesk schema;
		// hosts still send vp9s when negotiated. If only VP9 works, advertise
		// a non-nil encoding so PeerInfo stays valid and negotiation uses
		// local VP9 capability + peer AbilityVp9.
		if !caps.vp9 {
			return nil
		}
		return &pb.SupportedEncoding{}
	}
	return &pb.SupportedEncoding{
		H264: caps.h264,
		H265: caps.h265,
		Vp8:  caps.vp8,
		Av1:  caps.av1,
	}
}

type encodeCaps struct {
	h264 bool
	h265 bool
	vp8  bool
	vp9  bool
	av1  bool
}

func probeEncodeCaps() encodeCaps {
	return encodeCaps{
		h264: canEncodeWire(wireH264),
		h265: canEncodeWire(wireH265),
		vp8:  canEncodeWire(wireVP8),
		vp9:  canEncodeWire(wireVP9),
		av1:  canEncodeWire(wireAV1),
	}
}

var (
	advertisedCapsOnce     sync.Once
	advertisedCapsValue    encodeCaps
	advertisedCapsOverride *encodeCaps // tests only
)

func localEncodeCaps() encodeCaps {
	if advertisedCapsOverride != nil {
		return *advertisedCapsOverride
	}
	advertisedCapsOnce.Do(func() {
		advertisedCapsValue = probeEncodeCaps()
	})
	return advertisedCapsValue
}

func setEncodeCapsForTest(caps encodeCaps) func() {
	prev := advertisedCapsOverride
	cp := caps
	advertisedCapsOverride = &cp
	return func() { advertisedCapsOverride = prev }
}

func advertisedVideoEncoding() *pb.SupportedEncoding {
	return supportedEncodingFromCaps(localEncodeCaps())
}

// negotiateVideoCodec picks a mutually supported codec using PreferCodec.
// Auto order matches RdClient efficiency preference: AV1 → VP9 → H264 → VP8 → H265.
func negotiateVideoCodec(local *pb.SupportedEncoding, peer *pb.SupportedDecoding) negotiatedVideoCodec {
	return negotiateVideoCodecCaps(localEncodeCaps(), local, peer)
}

func negotiateVideoCodecCaps(caps encodeCaps, local *pb.SupportedEncoding, peer *pb.SupportedDecoding) negotiatedVideoCodec {
	if peer == nil {
		return videoCodecNone
	}
	if local == nil && !caps.vp9 && !caps.h264 && !caps.h265 && !caps.vp8 && !caps.av1 {
		return videoCodecNone
	}

	can := func(c negotiatedVideoCodec) bool {
		switch c {
		case videoCodecH264:
			return caps.h264 && peer.GetAbilityH264() > 0
		case videoCodecH265:
			return caps.h265 && peer.GetAbilityH265() > 0
		case videoCodecVP8:
			return caps.vp8 && peer.GetAbilityVp8() > 0
		case videoCodecVP9:
			return caps.vp9 && peer.GetAbilityVp9() > 0
		case videoCodecAV1:
			return caps.av1 && peer.GetAbilityAv1() > 0
		default:
			return false
		}
	}

	switch peer.GetPrefer() {
	case pb.SupportedDecoding_VP9:
		if can(videoCodecVP9) {
			return videoCodecVP9
		}
	case pb.SupportedDecoding_H264:
		if can(videoCodecH264) {
			return videoCodecH264
		}
	case pb.SupportedDecoding_H265:
		if can(videoCodecH265) {
			return videoCodecH265
		}
	case pb.SupportedDecoding_VP8:
		if can(videoCodecVP8) {
			return videoCodecVP8
		}
	case pb.SupportedDecoding_AV1:
		if can(videoCodecAV1) {
			return videoCodecAV1
		}
	}

	for _, c := range []negotiatedVideoCodec{
		videoCodecAV1, videoCodecVP9, videoCodecH264, videoCodecVP8, videoCodecH265,
	} {
		if can(c) {
			return c
		}
	}
	return videoCodecNone
}

func (codec negotiatedVideoCodec) String() string {
	w := codec.wire()
	if w == wireNone {
		return "none"
	}
	return w
}
