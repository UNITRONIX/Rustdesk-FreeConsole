package signalhost

import "strconv"

func (plan encoderPlan) preInputArgs() []string {
	switch plan.hwAccel {
	case hwVAAPI:
		return []string{"-init_hw_device", "vaapi=va:" + vaapiDevice(), "-filter_hw_device", "va"}
	case hwQSV:
		return []string{"-init_hw_device", "qsv=qsv", "-filter_hw_device", "qsv"}
	default:
		return nil
	}
}

func (plan encoderPlan) encoderTail(fps, quality int) []string {
	quality = clampStreamQuality(quality)
	fps = clampStreamFPS(fps)
	switch plan.mode {
	case frameModeIVF:
		return plan.ivfTail(fps, quality)
	default:
		return plan.annexBTail(fps, quality)
	}
}

func (plan encoderPlan) annexBTail(fps, quality int) []string {
	gop := strconv.Itoa(fps * 2)
	out := []string{}
	switch plan.hwAccel {
	case hwVAAPI:
		out = append(out, "-vf", "format=nv12,hwupload")
	case hwQSV:
		out = append(out, "-vf", "format=nv12,hwupload=extra_hw_frames=8")
	}
	out = append(out, "-c:v", plan.ffmpegName)
	switch plan.hwAccel {
	case hwNVENC:
		out = append(out, "-preset", "p4", "-tune", "ll", "-rc", "vbr", "-cq", strconv.Itoa(qToCQ(quality)))
	case hwVAAPI:
		out = append(out, "-rc_mode", "CQP", "-qp", strconv.Itoa(qToQP(quality)))
	case hwQSV:
		out = append(out, "-global_quality", strconv.Itoa(qToQP(quality)))
	case hwAMF:
		out = append(out, "-quality", "speed", "-rc", "cqp", "-qp_i", strconv.Itoa(qToQP(quality)), "-qp_p", strconv.Itoa(qToQP(quality)))
	case hwVideoToolbox:
		out = append(out, "-q:v", strconv.Itoa(quality))
	default:
		if plan.wire == wireH265 {
			out = append(out, "-preset", "ultrafast", "-tune", "zerolatency", "-crf", strconv.Itoa(h264CRF(quality)))
		} else {
			out = append(out, "-preset", "ultrafast", "-tune", "zerolatency", "-crf", strconv.Itoa(h264CRF(quality)))
		}
	}
	mux := "h264"
	bsf := "h264_mp4toannexb"
	if plan.wire == wireH265 {
		mux = "hevc"
		bsf = "hevc_mp4toannexb"
	}
	out = append(out,
		"-g", gop,
		"-bf", "0",
		"-pix_fmt", "yuv420p",
		"-bsf:v", bsf,
		"-f", mux,
		"-",
	)
	return out
}

func (plan encoderPlan) ivfTail(fps, quality int) []string {
	gop := strconv.Itoa(fps * 2)
	out := []string{}
	switch plan.hwAccel {
	case hwVAAPI:
		out = append(out, "-vf", "format=nv12,hwupload")
	case hwQSV:
		out = append(out, "-vf", "format=nv12,hwupload=extra_hw_frames=8")
	}
	out = append(out, "-c:v", plan.ffmpegName)
	switch plan.wire {
	case wireVP9:
		switch plan.hwAccel {
		case hwVAAPI:
			out = append(out, "-rc_mode", "CQP", "-qp", strconv.Itoa(qToQP(quality)))
		case hwQSV:
			out = append(out, "-global_quality", strconv.Itoa(qToQP(quality)))
		default:
			out = append(out, "-deadline", "realtime", "-cpu-used", "8", "-crf", strconv.Itoa(qToCRF(quality)), "-b:v", "0")
		}
	case wireVP8:
		out = append(out, "-deadline", "realtime", "-cpu-used", "8", "-b:v", strconv.Itoa(qualityToBitrate(quality)))
	case wireAV1:
		switch plan.hwAccel {
		case hwNVENC:
			out = append(out, "-preset", "p4", "-rc", "vbr", "-cq", strconv.Itoa(qToCQ(quality)))
		case hwQSV:
			out = append(out, "-global_quality", strconv.Itoa(qToQP(quality)))
		case hwVAAPI:
			out = append(out, "-rc_mode", "CQP", "-qp", strconv.Itoa(qToQP(quality)))
		case hwAMF:
			out = append(out, "-rc", "cqp", "-qp_i", strconv.Itoa(qToQP(quality)), "-qp_p", strconv.Itoa(qToQP(quality)))
		default:
			if plan.ffmpegName == "libsvtav1" {
				out = append(out, "-preset", "10", "-crf", strconv.Itoa(qToCRF(quality)))
			} else {
				out = append(out, "-usage", "realtime", "-cpu-used", "8", "-crf", strconv.Itoa(qToCRF(quality)), "-b:v", "0")
			}
		}
	}
	out = append(out, "-g", gop, "-pix_fmt", "yuv420p", "-f", "ivf", "-")
	return out
}

func qToCRF(q int) int { return clampQuant(63 - (q * 53 / 100)) }
func qToQP(q int) int  { return clampQuant(51 - (q * 41 / 100)) }
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

func qualityToBitrate(quality int) int {
	// ~250 kbps–4 Mbps for VP8 realtime.
	return 250_000 + quality*37_500
}
