package signalhost

import (
	"context"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Wire codec identifiers (RustDesk PreferCodec / VideoFrame unions).
const (
	wireNone = ""
	wireH264 = "h264"
	wireH265 = "h265"
	wireVP8  = "vp8"
	wireVP9  = "vp9"
	wireAV1  = "av1"
)

const (
	hwNone         = "none"
	hwVAAPI        = "vaapi"
	hwNVENC        = "nvenc"
	hwQSV          = "qsv"
	hwAMF          = "amf"
	hwVideoToolbox = "videotoolbox"
)

type frameMode int

const (
	frameModeAnnexB frameMode = iota
	frameModeIVF
)

// encoderPlan is the concrete ffmpeg encoder for one session codec.
type encoderPlan struct {
	wire       string
	ffmpegName string
	hwAccel    string
	mode       frameMode
}

var encoderCandidates = map[string][]string{
	wireH264: {"h264_nvenc", "h264_qsv", "h264_vaapi", "h264_amf", "h264_videotoolbox", "libx264"},
	wireH265: {"hevc_nvenc", "hevc_qsv", "hevc_vaapi", "hevc_amf", "hevc_videotoolbox", "libx265"},
	wireVP9:  {"vp9_vaapi", "vp9_qsv", "libvpx-vp9"},
	wireVP8:  {"libvpx"},
	wireAV1:  {"av1_nvenc", "av1_qsv", "av1_vaapi", "av1_amf", "libsvtav1", "libaom-av1"},
}

func hwOfEncoder(name string) string {
	switch {
	case strings.HasSuffix(name, "_nvenc"):
		return hwNVENC
	case strings.HasSuffix(name, "_qsv"):
		return hwQSV
	case strings.HasSuffix(name, "_vaapi"):
		return hwVAAPI
	case strings.HasSuffix(name, "_amf"):
		return hwAMF
	case strings.HasSuffix(name, "_videotoolbox"):
		return hwVideoToolbox
	default:
		return hwNone
	}
}

type encoderProbe struct {
	once      sync.Once
	available map[string]bool
	working   sync.Map
	ffmpeg    string
}

var globalEncoderProbe = &encoderProbe{available: map[string]bool{}}

func (p *encoderProbe) load() {
	p.once.Do(func() {
		ffmpeg, err := exec.LookPath("ffmpeg")
		if err != nil {
			return
		}
		p.ffmpeg = ffmpeg
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-encoders")
		hideConsole(cmd)
		out, err := cmd.Output()
		if err != nil {
			return
		}
		for _, line := range strings.Split(string(out), "\n") {
			f := strings.Fields(strings.TrimSpace(line))
			if len(f) >= 2 && strings.HasPrefix(f[0], "V") {
				p.available[f[1]] = true
			}
		}
	})
}

func (p *encoderProbe) validate(name string) bool {
	p.load()
	if p.ffmpeg == "" || !p.available[name] {
		return false
	}
	if hwOfEncoder(name) == hwNone {
		return true
	}
	if v, ok := p.working.Load(name); ok {
		return v.(bool)
	}
	ok := p.testEncode(name)
	p.working.Store(name, ok)
	return ok
}

func (p *encoderProbe) testEncode(name string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	plan := encoderPlan{ffmpegName: name, hwAccel: hwOfEncoder(name)}
	args := []string{"-hide_banner", "-loglevel", "error"}
	args = append(args, hwTestPreInput(plan)...)
	args = append(args, "-f", "lavfi", "-i", "color=c=black:s=64x64:r=5", "-frames:v", "1")
	args = append(args, hwTestFilter(plan)...)
	args = append(args, "-c:v", name, "-f", "null", "-")
	cmd := exec.CommandContext(ctx, p.ffmpeg, args...)
	hideConsole(cmd)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	return cmd.Run() == nil
}

func hwTestPreInput(plan encoderPlan) []string {
	switch plan.hwAccel {
	case hwVAAPI:
		return []string{"-init_hw_device", "vaapi=va:" + vaapiDevice(), "-filter_hw_device", "va"}
	case hwQSV:
		return []string{"-init_hw_device", "qsv=qsv", "-filter_hw_device", "qsv"}
	default:
		return nil
	}
}

func hwTestFilter(plan encoderPlan) []string {
	switch plan.hwAccel {
	case hwVAAPI:
		return []string{"-vf", "format=nv12,hwupload"}
	case hwQSV:
		return []string{"-vf", "format=nv12,hwupload=extra_hw_frames=4"}
	default:
		return nil
	}
}

func vaapiDevice() string {
	if d := strings.TrimSpace(os.Getenv("BETTERDESK_VAAPI_DEVICE")); d != "" {
		return d
	}
	return "/dev/dri/renderD128"
}

// resolveEncoderPlan picks the best working ffmpeg encoder for a wire codec.
func resolveEncoderPlan(wire string) (encoderPlan, bool) {
	cands := encoderCandidates[wire]
	if len(cands) == 0 {
		return encoderPlan{}, false
	}
	for _, name := range cands {
		if !globalEncoderProbe.validate(name) {
			continue
		}
		mode := frameModeAnnexB
		if wire == wireVP9 || wire == wireVP8 || wire == wireAV1 {
			mode = frameModeIVF
		}
		return encoderPlan{
			wire:       wire,
			ffmpegName: name,
			hwAccel:    hwOfEncoder(name),
			mode:       mode,
		}, true
	}
	return encoderPlan{}, false
}

func canEncodeWire(wire string) bool {
	_, ok := resolveEncoderPlan(wire)
	return ok
}
