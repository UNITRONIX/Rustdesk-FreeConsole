package signalhost

// captureStrategy is one ffmpeg screen-capture input recipe.
type captureStrategy struct {
	Name string
	Args []string // input args only (may include -f/-i); no encoder tail
}

// captureStrategies returns ordered capture attempts for this platform.
// Platform files implement platformCaptureStrategies.
func captureStrategies(fps int) []captureStrategy {
	return platformCaptureStrategies(clampStreamFPS(fps))
}
