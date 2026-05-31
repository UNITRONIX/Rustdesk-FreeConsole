package agent

import (
	"context"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

// ── Video codec engine ─────────────────────────────────────────────────────
//
// The agent can encode the captured screen with several codecs. Two families
// exist:
//
//   • Image codecs  (mjpeg, webp) — each frame is a self-contained still that
//     the operator decodes with a plain <img> / createImageBitmap. These work
//     with the existing console decoder with NO changes and are the safe
//     default. WebP is ~30-50% smaller than MJPEG for the same quality.
//
//   • Video codecs  (h264, vp9, av1) — a real inter-frame compressed stream.
//     These need a WebCodecs VideoDecoder on the operator side. They are far
//     more bandwidth efficient and, when a GPU encoder is available, almost
//     free on CPU. They are opt-in / negotiated, never forced.
//
// Codec selection precedence (highest first):
//   1. The codec the operator explicitly negotiated via codec_offer, if the
//      agent can actually produce it.
//   2. The codec pinned in the agent config (VideoCodec != "" && != "auto").
//   3. Automatic selection based on a one-time probe of ffmpeg's encoders,
//      preferring a hardware encoder and the most efficient codec that the
//      operator can decode.
//
// Everything degrades gracefully: if a chosen encoder fails to start the
// streamer falls back to the next strategy and ultimately to MJPEG, which is
// guaranteed to work everywhere ffmpeg is installed.

// Codec identifiers used on the wire (desktop_meta.format) and in config.
const (
	CodecMJPEG = "mjpeg"
	CodecWebP  = "webp"
	CodecH264  = "h264"
	CodecVP9   = "vp9"
	CodecAV1   = "av1"
	CodecAuto  = "auto"
)

// Hardware acceleration back-ends.
const (
	HwAuto         = "auto"
	HwNone         = "none"
	HwVAAPI        = "vaapi"         // Intel/AMD on Linux
	HwNVENC        = "nvenc"         // NVIDIA, all OS
	HwQSV          = "qsv"           // Intel QuickSync
	HwAMF          = "amf"           // AMD on Windows
	HwVideoToolbox = "videotoolbox"  // Apple
)

// frameMode describes how the encoded output is delimited on the wire.
type frameMode int

const (
	// frameModeImage: image2pipe output, one self-contained still per frame
	// (JPEG SOI/EOI or WebP RIFF chunk). Decoded by the operator's <img> path.
	frameModeImage frameMode = iota
	// frameModeAnnexB: H.264/HEVC Annex-B elementary stream. Access units are
	// split on the operator-agreed boundary and tagged key/delta by scanning
	// NAL unit types (type 5 = IDR).
	frameModeAnnexB
	// frameModeIVF: VP9/AV1 in an IVF container. Each frame has a 12-byte
	// header (4-byte LE size + 8-byte PTS) we strip before forwarding.
	frameModeIVF
)

// encoderPlan is the resolved encoder for a session: the concrete ffmpeg
// arguments, the wire codec name and the framing mode.
type encoderPlan struct {
	codec       string    // wire codec: mjpeg|webp|h264|vp9|av1
	ffmpegName  string    // concrete ffmpeg -c:v value (e.g. h264_vaapi)
	hwAccel     string    // resolved hw back-end or "none"
	mode        frameMode // how output is framed
	codecString string    // WebCodecs codec string for video codecs
	// preInput holds flags that must appear BEFORE -i (hw device init).
	preInput []string
}

// ── Encoder capability probe ────────────────────────────────────────────────

// encoderCandidates maps each video codec to the ordered list of ffmpeg
// encoder names to try, hardware first. The first candidate that ffmpeg both
// lists and (for hardware) survives a 1-frame validation encode is used.
var encoderCandidates = map[string][]string{
	CodecH264: {"h264_nvenc", "h264_qsv", "h264_vaapi", "h264_amf", "h264_videotoolbox", "libx264"},
	CodecVP9:  {"vp9_vaapi", "vp9_qsv", "libvpx-vp9"},
	CodecAV1:  {"av1_nvenc", "av1_qsv", "av1_vaapi", "av1_amf", "libsvtav1", "libaom-av1"},
	CodecWebP: {"libwebp"},
	CodecMJPEG: {"mjpeg"},
}

// hwOfEncoder maps a concrete ffmpeg encoder to its hardware back-end.
func hwOfEncoder(name string) string {
	switch {
	case strings.HasSuffix(name, "_nvenc"):
		return HwNVENC
	case strings.HasSuffix(name, "_qsv"):
		return HwQSV
	case strings.HasSuffix(name, "_vaapi"):
		return HwVAAPI
	case strings.HasSuffix(name, "_amf"):
		return HwAMF
	case strings.HasSuffix(name, "_videotoolbox"):
		return HwVideoToolbox
	default:
		return HwNone
	}
}

// codecWebCodecsString returns the WebCodecs codec string the operator must
// pass to VideoDecoder.configure for the given codec.
func codecWebCodecsString(codec string) string {
	switch codec {
	case CodecH264:
		// Baseline-ish; the decoder ignores level for Annex-B with in-band SPS.
		return "avc1.42E01F"
	case CodecVP9:
		return "vp09.00.10.08"
	case CodecAV1:
		return "av01.0.04M.08"
	default:
		return ""
	}
}

// codecOrder is the efficiency preference used by automatic selection. AV1 is
// the most efficient but the slowest in software; VP9 next; H.264 is the most
// broadly hardware-accelerated and lowest latency. WebP is the safe image
// fallback that needs no operator decoder changes.
var codecOrder = []string{CodecAV1, CodecVP9, CodecH264, CodecWebP}

// encoderProbe caches which ffmpeg encoders are available and validated.
type encoderProbe struct {
	once      sync.Once
	available map[string]bool // ffmpeg lists this encoder
	working   sync.Map        // encoder name -> bool (validated, cached)
	ffmpeg    string
}

var globalProbe = &encoderProbe{available: map[string]bool{}}

// load lists ffmpeg encoders exactly once per process.
func (p *encoderProbe) load() {
	p.once.Do(func() {
		ffmpeg, err := exec.LookPath("ffmpeg")
		if err != nil {
			return
		}
		p.ffmpeg = ffmpeg
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-encoders").Output()
		if err != nil {
			return
		}
		for _, line := range strings.Split(string(out), "\n") {
			f := strings.Fields(strings.TrimSpace(line))
			// Lines look like: " V..... h264_vaapi   VAAPI H.264 encoder"
			if len(f) >= 2 && strings.HasPrefix(f[0], "V") {
				p.available[f[1]] = true
			}
		}
	})
}

// listed reports whether ffmpeg advertises the encoder at all.
func (p *encoderProbe) listed(name string) bool {
	p.load()
	return p.available[name]
}

// validate runs a 1-frame null encode to confirm a hardware encoder actually
// initialises on this machine (drivers/permissions can make a listed encoder
// fail at runtime). Software encoders are trusted without a test. Results are
// cached for the process lifetime.
func (p *encoderProbe) validate(name string) bool {
	p.load()
	if p.ffmpeg == "" || !p.available[name] {
		return false
	}
	if hwOfEncoder(name) == HwNone {
		return true // software encoder — trust it, skip the cost.
	}
	if v, ok := p.working.Load(name); ok {
		return v.(bool)
	}
	ok := p.testEncode(name)
	p.working.Store(name, ok)
	return ok
}

// testEncode encodes a single 64x64 synthetic frame to /dev/null and reports
// whether the encoder initialised successfully.
func (p *encoderProbe) testEncode(name string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()

	args := []string{"-hide_banner", "-loglevel", "error"}
	plan := encoderPlan{ffmpegName: name, hwAccel: hwOfEncoder(name)}
	args = append(args, hwTestPreInput(plan)...)
	args = append(args,
		"-f", "lavfi", "-i", "color=c=black:s=64x64:r=5",
		"-frames:v", "1",
	)
	args = append(args, hwTestFilter(plan)...)
	args = append(args, "-c:v", name, "-f", "null", "-")

	cmd := exec.CommandContext(ctx, p.ffmpeg, args...)
	return cmd.Run() == nil
}

// hwTestPreInput returns the hw-device init flags needed before -i for the
// validation encode. For lavfi sources the upload filter handles VAAPI/QSV.
func hwTestPreInput(plan encoderPlan) []string {
	switch plan.hwAccel {
	case HwVAAPI:
		return []string{"-init_hw_device", "vaapi=va:" + vaapiDevice(), "-filter_hw_device", "va"}
	case HwQSV:
		return []string{"-init_hw_device", "qsv=qsv", "-filter_hw_device", "qsv"}
	default:
		return nil
	}
}

// hwTestFilter returns the upload filter chain for the validation encode.
func hwTestFilter(plan encoderPlan) []string {
	switch plan.hwAccel {
	case HwVAAPI:
		return []string{"-vf", "format=nv12,hwupload"}
	case HwQSV:
		return []string{"-vf", "format=nv12,hwupload=extra_hw_frames=4"}
	default:
		return nil
	}
}

// vaapiDevice returns the VAAPI render node, overridable via env.
func vaapiDevice() string {
	// Most systems expose the first render node here.
	return "/dev/dri/renderD128"
}

// ── Capability advertisement ────────────────────────────────────────────────

// videoCapabilities returns the ordered list of wire codecs this agent can
// actually produce right now, given the config and a live encoder probe. The
// result feeds codec_offer so the operator only negotiates codecs we can
// deliver. Image codecs are always offered (they need ffmpeg only); video
// codecs are offered when a working encoder exists.
func (a *Agent) videoCapabilities() []string {
	if !a.cfg.Screenshot {
		return nil
	}
	caps := []string{}
	// Video codecs first (preferred), validated.
	for _, codec := range []string{CodecAV1, CodecVP9, CodecH264} {
		if a.codecAllowed(codec) && resolveEncoder(codec, a.cfg.HwAccel) != nil {
			caps = append(caps, codec)
		}
	}
	// Image codecs are always available when ffmpeg is present; webp needs
	// libwebp. MJPEG is the universal guarantee and is always last.
	if globalProbe.validate("libwebp") {
		caps = append(caps, CodecWebP)
	}
	caps = append(caps, CodecMJPEG)
	return caps
}

// codecAllowed honours an explicit per-codec pin. When VideoCodec is a concrete
// codec, only that codec (and the image fallbacks) are advertised.
func (a *Agent) codecAllowed(codec string) bool {
	pin := strings.ToLower(strings.TrimSpace(a.cfg.VideoCodec))
	if pin == "" || pin == CodecAuto {
		return true
	}
	return pin == codec
}

// resolveEncoder returns a usable encoderPlan for the requested codec under the
// given hw preference, or nil if no working encoder exists. hwPref of "" or
// "auto" lets the probe pick the best; a concrete back-end restricts to it.
func resolveEncoder(codec, hwPref string) *encoderPlan {
	hwPref = strings.ToLower(strings.TrimSpace(hwPref))
	for _, name := range encoderCandidates[codec] {
		hw := hwOfEncoder(name)
		switch hwPref {
		case "", HwAuto:
			// any
		case HwNone:
			if hw != HwNone {
				continue
			}
		default:
			if hw != hwPref && hw != HwNone {
				continue
			}
			// Allow software fallback only when no hw candidate matched; the
			// loop order already prefers hardware, so a software encoder here
			// means the user asked for a back-end this codec can't use — still
			// give them the codec via software rather than nothing.
		}
		if !globalProbe.validate(name) {
			continue
		}
		return buildPlan(codec, name)
	}
	return nil
}

// buildPlan fills in the framing mode and WebCodecs string for a resolved
// encoder name.
func buildPlan(codec, ffmpegName string) *encoderPlan {
	mode := frameModeImage
	switch codec {
	case CodecH264:
		mode = frameModeAnnexB
	case CodecVP9, CodecAV1:
		mode = frameModeIVF
	}
	return &encoderPlan{
		codec:       codec,
		ffmpegName:  ffmpegName,
		hwAccel:     hwOfEncoder(ffmpegName),
		mode:        mode,
		codecString: codecWebCodecsString(codec),
	}
}

// selectEncoder resolves the encoder to use for a session. requested is the
// codec the operator pinned (may be "" or "auto"). opCodecs is the list of
// codecs the operator can actually DECODE (from the desktop_start payload).
// It honours, in order: the operator's pinned+decodable request, the config
// pin, then automatic best-codec selection limited to what the operator can
// decode. It always succeeds because MJPEG is the universal last resort.
//
// Backward compatibility: a legacy operator that sends no codec list can only
// decode JPEG, so the result is forced to MJPEG regardless of agent ability.
func (a *Agent) selectEncoder(requested string, opCodecs []string) encoderPlan {
	hw := a.cfg.HwAccel
	want := normalizeWireCodec(requested)
	pin := normalizeWireCodec(a.cfg.VideoCodec)

	// Normalize and index the operator's decode capabilities. "jpeg" is the
	// historical wire name for MJPEG.
	canDecode := map[string]bool{}
	for _, c := range opCodecs {
		canDecode[normalizeWireCodec(c)] = true
	}
	legacyOperator := len(canDecode) == 0
	opDecodes := func(codec string) bool {
		if codec == CodecMJPEG {
			return true // every operator decodes JPEG
		}
		return canDecode[codec]
	}

	produce := func(codec string) (encoderPlan, bool) {
		if !a.codecAllowed(codec) || !opDecodes(codec) {
			return encoderPlan{}, false
		}
		switch codec {
		case CodecMJPEG:
			return imagePlan(CodecMJPEG), true
		case CodecWebP:
			if globalProbe.validate("libwebp") {
				return imagePlan(CodecWebP), true
			}
		default:
			if p := resolveEncoder(codec, hw); p != nil {
				return *p, true
			}
		}
		return encoderPlan{}, false
	}

	if legacyOperator {
		return imagePlan(CodecMJPEG)
	}

	// 1. Operator's explicit, decodable request.
	if want != "" && want != CodecAuto {
		if p, ok := produce(want); ok {
			return p
		}
	}

	// 2. Config pin (concrete codec).
	if pin != "" && pin != CodecAuto {
		if p, ok := produce(pin); ok {
			return p
		}
	}

	// 3. Automatic: most efficient video codec the operator can decode and the
	//    agent can produce (hardware preferred via candidate ordering).
	for _, codec := range codecOrder {
		if p, ok := produce(codec); ok {
			return p
		}
	}

	// 4. Universal last resort.
	return imagePlan(CodecMJPEG)
}

// normalizeWireCodec lowercases and maps the historical "jpeg" alias to
// CodecMJPEG.
func normalizeWireCodec(c string) string {
	c = strings.ToLower(strings.TrimSpace(c))
	if c == "jpeg" {
		return CodecMJPEG
	}
	return c
}

// imagePlan builds an image-codec plan (mjpeg/webp).
func imagePlan(codec string) encoderPlan {
	name := "mjpeg"
	if codec == CodecWebP {
		name = "libwebp"
	}
	return encoderPlan{codec: codec, ffmpegName: name, hwAccel: HwNone, mode: frameModeImage}
}

// ── Encoder argument construction ───────────────────────────────────────────

// encoderTail returns the ffmpeg arguments that follow the capture input for
// this plan: optional hw upload filter, the codec, codec options and the
// output muxer. quality is 0-100, fps is the target frame rate.
//
// preInput returns flags that must precede -i (hardware device init); the
// caller is responsible for inserting them before the input args.
func (plan encoderPlan) preInputArgs() []string {
	switch plan.hwAccel {
	case HwVAAPI:
		return []string{"-init_hw_device", "vaapi=va:" + vaapiDevice(), "-filter_hw_device", "va"}
	case HwQSV:
		return []string{"-init_hw_device", "qsv=qsv", "-filter_hw_device", "qsv"}
	default:
		return nil
	}
}

func (plan encoderPlan) encoderTail(fps, quality int) []string {
	if quality < 1 {
		quality = 60
	}
	if quality > 100 {
		quality = 100
	}
	if fps < 1 {
		fps = 15
	}

	switch plan.mode {
	case frameModeImage:
		return plan.imageTail(fps, quality)
	case frameModeAnnexB:
		return plan.h264Tail(fps, quality)
	case frameModeIVF:
		return plan.ivfTail(fps, quality)
	}
	return plan.imageTail(fps, quality)
}

// imageTail builds the mjpeg/webp image2pipe encoder.
func (plan encoderPlan) imageTail(fps, quality int) []string {
	if plan.codec == CodecWebP {
		// libwebp quality is 0-100 directly. -lossless 0 keeps it lossy/small.
		return []string{
			"-vf", "fps=" + itoa(fps),
			"-c:v", "libwebp",
			"-lossless", "0",
			"-quality", itoa(quality),
			"-preset", "picture",
			"-f", "image2pipe",
			"-",
		}
	}
	// MJPEG: ffmpeg q:v scale is 2 (best) – 31 (worst).
	mq := 31 - (quality * 29 / 100)
	if mq < 2 {
		mq = 2
	}
	return []string{
		"-vf", "fps=" + itoa(fps),
		"-vcodec", "mjpeg",
		"-q:v", itoa(mq),
		"-f", "image2pipe",
		"-",
	}
}

// h264Tail builds the H.264 Annex-B encoder. A short GOP and in-band SPS/PPS
// (Annex-B) let the WebCodecs decoder start without an out-of-band config.
func (plan encoderPlan) h264Tail(fps, quality int) []string {
	gop := itoa(fps * 2)
	out := []string{}
	switch plan.hwAccel {
	case HwVAAPI:
		out = append(out, "-vf", "format=nv12,hwupload")
	case HwQSV:
		out = append(out, "-vf", "format=nv12,hwupload=extra_hw_frames=8")
	}
	out = append(out, "-c:v", plan.ffmpegName)
	switch plan.hwAccel {
	case HwNVENC:
		out = append(out, "-preset", "p4", "-tune", "ll", "-rc", "vbr", "-cq", itoa(qToCQ(quality)))
	case HwVAAPI:
		out = append(out, "-rc_mode", "CQP", "-qp", itoa(qToQP(quality)))
	case HwQSV:
		out = append(out, "-global_quality", itoa(qToQP(quality)))
	case HwAMF:
		out = append(out, "-quality", "speed", "-rc", "cqp", "-qp_i", itoa(qToQP(quality)), "-qp_p", itoa(qToQP(quality)))
	case HwVideoToolbox:
		out = append(out, "-q:v", itoa(quality))
	default: // libx264
		out = append(out, "-preset", "veryfast", "-tune", "zerolatency", "-crf", itoa(qToCRF(quality)))
	}
	out = append(out,
		"-g", gop,
		"-bf", "0", // no B-frames: lowest latency, simplest AU boundaries
		"-pix_fmt", "yuv420p",
		"-bsf:v", "h264_mp4toannexb", // harmless if already annexb
		"-f", "h264",
		"-",
	)
	return out
}

// ivfTail builds the VP9/AV1 encoder muxed into IVF for easy frame splitting.
func (plan encoderPlan) ivfTail(fps, quality int) []string {
	gop := itoa(fps * 2)
	out := []string{}
	switch plan.hwAccel {
	case HwVAAPI:
		out = append(out, "-vf", "format=nv12,hwupload")
	case HwQSV:
		out = append(out, "-vf", "format=nv12,hwupload=extra_hw_frames=8")
	}
	out = append(out, "-c:v", plan.ffmpegName)

	switch plan.codec {
	case CodecVP9:
		switch plan.hwAccel {
		case HwVAAPI:
			out = append(out, "-rc_mode", "CQP", "-qp", itoa(qToQP(quality)))
		case HwQSV:
			out = append(out, "-global_quality", itoa(qToQP(quality)))
		default: // libvpx-vp9
			out = append(out, "-deadline", "realtime", "-cpu-used", "8", "-crf", itoa(qToCRF(quality)), "-b:v", "0")
		}
	case CodecAV1:
		switch plan.hwAccel {
		case HwNVENC:
			out = append(out, "-preset", "p4", "-rc", "vbr", "-cq", itoa(qToCQ(quality)))
		case HwQSV:
			out = append(out, "-global_quality", itoa(qToQP(quality)))
		case HwVAAPI:
			out = append(out, "-rc_mode", "CQP", "-qp", itoa(qToQP(quality)))
		case HwAMF:
			out = append(out, "-rc", "cqp", "-qp_i", itoa(qToQP(quality)), "-qp_p", itoa(qToQP(quality)))
		default:
			// libsvtav1 (preferred sw) vs libaom-av1.
			if plan.ffmpegName == "libsvtav1" {
				out = append(out, "-preset", "10", "-crf", itoa(qToCRF(quality)))
			} else {
				out = append(out, "-usage", "realtime", "-cpu-used", "8", "-crf", itoa(qToCRF(quality)), "-b:v", "0")
			}
		}
	}

	out = append(out,
		"-g", gop,
		"-pix_fmt", "yuv420p",
		"-f", "ivf",
		"-",
	)
	return out
}

// qToCRF / qToQP / qToCQ map a 0-100 quality slider to codec quantiser values.
// Higher slider = better quality = lower quantiser.
func qToCRF(q int) int { return clampQuant(63 - (q * 53 / 100)) } // 10 (best) – 63
func qToQP(q int) int  { return clampQuant(51 - (q * 41 / 100)) } // 10 (best) – 51
func qToCQ(q int) int  { return clampQuant(51 - (q * 41 / 100)) }

func clampQuant(v int) int {
	if v < 1 {
		return 1
	}
	if v > 63 {
		return 63
	}
	return v
}

// itoa is a tiny strconv-free int formatter for the hot encoder-arg path.
func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var b [20]byte
	i := len(b)
	for v > 0 {
		i--
		b[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

// platformDefaultHwAccel returns the most likely hardware back-end for the OS,
// used only for logging/diagnostics; actual selection is probe-driven.
func platformDefaultHwAccel() string {
	switch runtime.GOOS {
	case "windows":
		return HwNVENC
	case "darwin":
		return HwVideoToolbox
	default:
		return HwVAAPI
	}
}
