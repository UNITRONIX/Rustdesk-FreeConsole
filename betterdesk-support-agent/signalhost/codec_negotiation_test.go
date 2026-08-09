package signalhost

import (
	"testing"
	"time"

	pb "github.com/unitronix/betterdesk-server/proto"
)

func TestSupportedEncodingFromCaps(t *testing.T) {
	if got := supportedEncodingFromCaps(encodeCaps{}); got != nil {
		t.Fatalf("empty caps advertised as %#v", got)
	}
	if got := supportedEncodingFromCaps(encodeCaps{vp9: true}); got == nil {
		t.Fatal("vp9-only should still produce non-nil encoding")
	}
	got := supportedEncodingFromCaps(encodeCaps{h264: true, av1: true, h265: true, vp8: true})
	if got == nil || !got.GetH264() || !got.GetAv1() || !got.GetH265() || !got.GetVp8() {
		t.Fatalf("encoding = %#v", got)
	}
}

func TestNegotiateVideoCodecPreferAndAuto(t *testing.T) {
	caps := encodeCaps{h264: true, vp9: true, av1: true, vp8: true, h265: true}
	local := supportedEncodingFromCaps(caps)

	tests := []struct {
		name string
		peer *pb.SupportedDecoding
		want negotiatedVideoCodec
	}{
		{
			name: "missing peer",
			peer: nil,
			want: videoCodecNone,
		},
		{
			name: "prefer h264",
			peer: &pb.SupportedDecoding{AbilityH264: 1, AbilityVp9: 1, Prefer: pb.SupportedDecoding_H264},
			want: videoCodecH264,
		},
		{
			name: "prefer vp9",
			peer: &pb.SupportedDecoding{AbilityH264: 1, AbilityVp9: 1, Prefer: pb.SupportedDecoding_VP9},
			want: videoCodecVP9,
		},
		{
			name: "prefer av1",
			peer: &pb.SupportedDecoding{AbilityAv1: 1, AbilityH264: 1, Prefer: pb.SupportedDecoding_AV1},
			want: videoCodecAV1,
		},
		{
			name: "prefer vp8",
			peer: &pb.SupportedDecoding{AbilityVp8: 1, AbilityH264: 1, Prefer: pb.SupportedDecoding_VP8},
			want: videoCodecVP8,
		},
		{
			name: "prefer h265",
			peer: &pb.SupportedDecoding{AbilityH265: 1, AbilityH264: 1, Prefer: pb.SupportedDecoding_H265},
			want: videoCodecH265,
		},
		{
			name: "auto prefers av1",
			peer: &pb.SupportedDecoding{
				AbilityAv1: 1, AbilityVp9: 1, AbilityH264: 1, AbilityVp8: 1, AbilityH265: 1,
				Prefer: pb.SupportedDecoding_Auto,
			},
			want: videoCodecAV1,
		},
		{
			name: "prefer unavailable falls back",
			peer: &pb.SupportedDecoding{AbilityH264: 1, Prefer: pb.SupportedDecoding_AV1},
			want: videoCodecH264,
		},
		{
			name: "preference without ability",
			peer: &pb.SupportedDecoding{Prefer: pb.SupportedDecoding_H264},
			want: videoCodecNone,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := negotiateVideoCodecCaps(caps, local, tc.peer); got != tc.want {
				t.Fatalf("got %s, want %s", got, tc.want)
			}
		})
	}
}

func TestNegotiateRespectsLocalCaps(t *testing.T) {
	caps := encodeCaps{h264: true}
	local := supportedEncodingFromCaps(caps)
	peer := &pb.SupportedDecoding{AbilityH264: 1, AbilityAv1: 1, Prefer: pb.SupportedDecoding_AV1}
	if got := negotiateVideoCodecCaps(caps, local, peer); got != videoCodecH264 {
		t.Fatalf("got %s, want h264", got)
	}
}

func TestRequestedVideoSettingsAreBounded(t *testing.T) {
	got := requestedVideoSettings(&pb.OptionMessage{
		CustomImageQuality: 1000,
		CustomFps:          1000,
	})
	if got.quality != maxStreamQuality || got.fps != maxStreamFPS {
		t.Fatalf("unbounded request resolved to %#v", got)
	}

	got = requestedVideoSettings(&pb.OptionMessage{
		CustomImageQuality: 1,
		CustomFps:          1,
	})
	if got.quality != minStreamQuality || got.fps != minStreamFPS {
		t.Fatalf("low request resolved to %#v", got)
	}

	got = requestedVideoSettings(&pb.OptionMessage{
		CustomImageQuality: -1,
		CustomFps:          -1,
		ImageQuality:       pb.ImageQuality_Low,
	})
	if got.quality != 40 || got.fps != defaultStreamFPS {
		t.Fatalf("invalid request resolved to %#v", got)
	}
}

func TestPeerOptionChangesAreRateLimitedAndBounded(t *testing.T) {
	st := newStreamState(videoCodecH264, &pb.OptionMessage{
		CustomImageQuality: 70,
		CustomFps:          20,
	})
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	st.markEncoderStarted(start)

	if st.applyPeerOptions(&pb.OptionMessage{
		CustomImageQuality: 1000,
		CustomFps:          1000,
	}, start.Add(time.Second)) {
		t.Fatal("settings changed inside the encoder restart cooldown")
	}
	if got := st.settings(); got.quality != 70 || got.fps != 20 {
		t.Fatalf("cooldown changed settings to %#v", got)
	}

	if !st.applyPeerOptions(&pb.OptionMessage{
		CustomImageQuality: 1000,
		CustomFps:          1000,
	}, start.Add(encoderReconfigureInterval)) {
		t.Fatal("bounded settings update was not applied")
	}
	if got := st.settings(); got.quality != maxStreamQuality || got.fps != maxStreamFPS {
		t.Fatalf("bounded settings update = %#v", got)
	}
}

func TestPeerCodecPreferenceRestartsEncoder(t *testing.T) {
	restore := setEncodeCapsForTest(encodeCaps{h264: true, vp9: true})
	defer restore()

	st := newStreamState(videoCodecH264, nil)
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	st.markEncoderStarted(start.Add(-encoderReconfigureInterval))

	if !st.applyPeerOptions(&pb.OptionMessage{
		SupportedDecoding: &pb.SupportedDecoding{
			AbilityH264: 1,
			AbilityVp9:  1,
			Prefer:      pb.SupportedDecoding_VP9,
		},
	}, start) {
		t.Fatal("codec preference did not trigger reconfigure")
	}
	if st.currentCodec() != videoCodecVP9 {
		t.Fatalf("codec = %s, want vp9", st.currentCodec())
	}
}

func TestCongestionControllerStaysWithinNegotiatedLimits(t *testing.T) {
	st := newStreamState(videoCodecH264, &pb.OptionMessage{
		CustomImageQuality: 90,
		CustomFps:          30,
	})
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	st.markEncoderStarted(now.Add(-encoderReconfigureInterval))

	for i := 0; i < 20; i++ {
		now = now.Add(encoderReconfigureInterval)
		st.adjustForWrite(3*time.Second, now)
	}
	if got := st.settings(); got.quality != minStreamQuality || got.fps != minStreamFPS {
		t.Fatalf("congestion floor = %#v, want quality=%d fps=%d", got, minStreamQuality, minStreamFPS)
	}

	now = now.Add(encoderRecoveryInterval)
	for i := 0; i < healthyWriteSamples; i++ {
		now = now.Add(time.Millisecond)
		st.adjustForWrite(time.Millisecond, now)
	}
	got := st.settings()
	if got.quality <= minStreamQuality || got.fps <= minStreamFPS {
		t.Fatalf("healthy transport did not recover: %#v", got)
	}
	if got.quality > maxStreamQuality || got.fps > maxStreamFPS {
		t.Fatalf("recovery exceeded negotiated limits: %#v", got)
	}
}

func TestH264HasIDRDoesNotMislabelDeltaFrames(t *testing.T) {
	idr := []byte{0, 0, 0, 1, 0x67, 0, 0, 1, 0x65, 1}
	if !h264HasIDR(idr) {
		t.Fatal("IDR access unit was not recognized")
	}

	delta := []byte{0, 0, 0, 1, 0x67, 0, 0, 1, 0x41, 1}
	if h264HasIDR(delta) {
		t.Fatal("delta access unit was incorrectly marked as key")
	}
}

func TestBuildCaptureEncodeArgs(t *testing.T) {
	plan := encoderPlan{wire: wireH264, ffmpegName: "libx264", hwAccel: hwNone, mode: frameModeAnnexB}
	args := buildCaptureEncodeArgs(captureStrategy{
		Name: "gdigrab",
		Args: []string{"-f", "gdigrab", "-framerate", "15", "-i", "desktop"},
	}, plan, 15, 65)
	if len(args) < 8 {
		t.Fatalf("args too short: %#v", args)
	}
	joined := false
	for _, a := range args {
		if a == "libx264" {
			joined = true
		}
	}
	if !joined {
		t.Fatalf("missing encoder in %#v", args)
	}
}
