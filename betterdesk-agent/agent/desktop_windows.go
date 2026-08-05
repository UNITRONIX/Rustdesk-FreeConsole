//go:build windows

package agent

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// captureDevice returns the ffmpeg input format for screen capture on Windows.
func captureDevice() string {
	return "gdigrab"
}

// captureInput returns the ffmpeg input source (the primary desktop).
func captureInput() string {
	return "desktop"
}

// captureFFmpegInputArgs returns ffmpeg input arguments for Windows screen capture.
func captureFFmpegInputArgs(fps int) []string {
	return []string{
		"-f", "gdigrab",
		"-framerate", fmt.Sprintf("%d", fps),
		"-i", "desktop",
	}
}

// captureFFmpegStrategies preserves gdigrab as the stable primary source and
// adds ddagrab only as a runtime-probed DXGI fallback. Windows.Graphics.Capture
// needs a native D3D11 frame bridge, so it is intentionally not represented by
// an ffmpeg strategy until that bridge exists.
func captureFFmpegStrategies(fps int, _ *DesktopStreamer) []CaptureStrategy {
	return windowsCaptureFFmpegStrategies(fps, ffmpegSupportsDDAGrab())
}

func windowsCaptureFFmpegStrategies(fps int, dxgiAvailable bool) []CaptureStrategy {
	strategies := []CaptureStrategy{{
		Name: "gdigrab",
		Args: captureFFmpegInputArgs(fps),
	}}
	if !dxgiAvailable {
		return strategies
	}

	// ddagrab is FFmpeg's Desktop Duplication (DXGI) source filter. Keep it
	// behind gdigrab because it captures one output at a time and support for
	// the filter varies across otherwise stock Windows FFmpeg builds. ddagrab
	// outputs D3D11 frames, so download them before the existing software
	// encoder path. The streamer accepts it only after it has produced frames.
	return append(strategies, CaptureStrategy{
		Name: "ddagrab(DXGI fallback)",
		Args: []string{
			"-f", "lavfi",
			"-i", fmt.Sprintf("ddagrab=output_idx=0:framerate=%d:draw_mouse=1,hwdownload,format=bgra", fps),
		},
	})
}

var (
	ddagrabProbeOnce sync.Once
	ddagrabAvailable bool
)

// ffmpegSupportsDDAGrab reports whether the FFmpeg binary on PATH exposes the
// ddagrab filter. It is a bounded capability probe only; acquiring frames is
// still the final compatibility check in the normal strategy fallback loop.
func ffmpegSupportsDDAGrab() bool {
	ddagrabProbeOnce.Do(func() {
		path, err := exec.LookPath("ffmpeg")
		if err != nil {
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, path, "-hide_banner", "-filters").CombinedOutput()
		if err != nil || ctx.Err() != nil {
			return
		}
		ddagrabAvailable = ffmpegHasDXGIFallbackFilters(out)
	})
	return ddagrabAvailable
}

func ffmpegHasDXGIFallbackFilters(output []byte) bool {
	return ffmpegFilterListed(output, "ddagrab") &&
		ffmpegFilterListed(output, "hwdownload") &&
		ffmpegFilterListed(output, "format")
}

func ffmpegFilterListed(output []byte, filter string) bool {
	for _, field := range strings.Fields(string(output)) {
		if field == filter {
			return true
		}
	}
	return false
}
