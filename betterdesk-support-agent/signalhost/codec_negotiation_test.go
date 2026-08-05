package signalhost

import (
	"testing"
	"time"

	pb "github.com/unitronix/betterdesk-server/proto"
)

func TestSupportedEncodingOnlyAdvertisesValidatedH264(t *testing.T) {
	if got := supportedEncodingForH264(false); got != nil {
		t.Fatalf("unsupported encoder advertised as %#v", got)
	}

	got := supportedEncodingForH264(true)
	if got == nil || !got.GetH264() {
		t.Fatalf("H.264 capability = %#v, want H.264", got)
	}
	if got.GetH265() || got.GetVp8() || got.GetAv1() || got.GetI444() != nil {
		t.Fatalf("unexpected unsupported codec advertisement: %#v", got)
	}
}

func TestNegotiateVideoCodecRequiresMutualH264(t *testing.T) {
	local := supportedEncodingForH264(true)

	tests := []struct {
		name  string
		local *pb.SupportedEncoding
		peer  *pb.SupportedDecoding
		want  negotiatedVideoCodec
	}{
		{
			name:  "missing local capability",
			local: nil,
			peer:  &pb.SupportedDecoding{AbilityH264: 1},
			want:  videoCodecNone,
		},
		{
			name:  "missing peer capability",
			local: local,
			peer:  nil,
			want:  videoCodecNone,
		},
		{
			name:  "preference without ability",
			local: local,
			peer:  &pb.SupportedDecoding{Prefer: pb.SupportedDecoding_H264},
			want:  videoCodecNone,
		},
		{
			name:  "mutual h264 despite another preference",
			local: local,
			peer:  &pb.SupportedDecoding{AbilityH264: 1, Prefer: pb.SupportedDecoding_AV1},
			want:  videoCodecH264,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := negotiateVideoCodec(tc.local, tc.peer); got != tc.want {
				t.Fatalf("negotiateVideoCodec() = %s, want %s", got, tc.want)
			}
		})
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
