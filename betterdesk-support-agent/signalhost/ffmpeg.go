package signalhost

import (
	"bytes"
	"context"
	"io"
	"os/exec"
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

func encodeJPEGToH264(ctx context.Context, jpeg []byte) ([]byte, bool, error) {
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
		"-pix_fmt", "yuv420p",
		"-f", "h264", "pipe:1",
	)
	cmd.Stdin = bytes.NewReader(jpeg)
	out, err := cmd.Output()
	if err != nil {
		return nil, false, err
	}
	return out, true, nil
}
