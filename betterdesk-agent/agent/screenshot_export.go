package agent

// CaptureScreenshotJPEG captures the primary display as JPEG bytes.
func CaptureScreenshotJPEG() ([]byte, error) {
	return captureScreenshotPlatform()
}
