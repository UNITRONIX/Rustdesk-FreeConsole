package signalhost

// buildCaptureEncodeArgs assembles ffmpeg argv: capture input + encoder plan.
func buildCaptureEncodeArgs(capture captureStrategy, plan encoderPlan, fps, quality int) []string {
	if len(capture.Args) == 0 || plan.ffmpegName == "" {
		return nil
	}
	args := []string{"-hide_banner", "-loglevel", "error"}
	args = append(args, plan.preInputArgs()...)
	args = append(args, capture.Args...)
	args = append(args, plan.encoderTail(fps, quality)...)
	return args
}
