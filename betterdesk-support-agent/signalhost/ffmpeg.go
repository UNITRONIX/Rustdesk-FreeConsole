package signalhost

import (
	"bytes"
	"context"
	"io"
	"os/exec"
	"strconv"
)

func startFFmpegCapture(ctx context.Context, args []string) (*exec.Cmd, io.ReadCloser, error) {
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, nil, err
	}
	cmd := exec.CommandContext(ctx, path, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}
	return cmd, stdout, nil
}

func encodeJPEGToH264(ctx context.Context, jpeg []byte, quality int) ([]byte, bool, error) {
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, false, err
	}
	cmd := exec.CommandContext(ctx, path,
		"-hide_banner", "-loglevel", "error",
		"-f", "image2pipe", "-i", "pipe:0",
		"-frames:v", "1",
		"-c:v", "libx264",
		"-preset", "ultrafast",
		"-tune", "zerolatency",
		"-crf", strconv.Itoa(h264CRF(quality)),
		"-pix_fmt", "yuv420p",
		"-f", "h264", "pipe:1",
	)
	cmd.Stdin = bytes.NewReader(jpeg)
	out, err := cmd.Output()
	if err != nil {
		return nil, false, err
	}
	return out, h264HasIDR(out), nil
}

// h264HasIDR verifies that an encoded access unit actually contains an IDR
// NAL. A fresh fallback encoder is expected to produce one, but the wire key
// flag must describe the payload rather than an assumption about ffmpeg.
func h264HasIDR(data []byte) bool {
	for offset := 0; ; {
		start := indexStartCode(data, offset)
		if start < 0 {
			return false
		}
		startLen := startCodeLen(data, start)
		if start+startLen >= len(data) {
			return false
		}
		if data[start+startLen]&0x1F == 5 {
			return true
		}
		offset = start + startLen
	}
}
