package signalhost

import (
	"context"
	"io"
	"log"
	"sync"
	"sync/atomic"
	"time"

	bdagent "github.com/unitronix/betterdesk-agent/agent"
	pb "github.com/unitronix/betterdesk-server/proto"
)

const streamFPS = 15

type streamState struct {
	forceKeyframe atomic.Bool
}

// streamSession sends H.264 frames and processes peer input until the connection closes.
func (h *Host) streamSession(ps *peerSession) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	st := &streamState{}
	inputDone := make(chan struct{})
	go func() {
		defer close(inputDone)
		h.readPeerInput(ctx, ps, st)
	}()

	err := h.streamH264(ctx, ps, st)
	cancel()
	<-inputDone
	return err
}

func (h *Host) readPeerInput(ctx context.Context, ps *peerSession, st *streamState) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		frame, err := ps.read(60 * time.Second)
		if err != nil {
			if err != io.EOF {
				log.Printf("[signalhost] input read: %v", err)
			}
			return
		}
		handlePeerMessage(frame, st)
	}
}

func (h *Host) streamH264(ctx context.Context, ps *peerSession, st *streamState) error {
	args := ffmpegStreamArgs(streamFPS)
	if len(args) == 0 {
		return h.streamScreenshotFallback(ctx, ps, st)
	}

	cmd, stdout, err := startFFmpegCapture(ctx, args)
	if err != nil {
		log.Printf("[signalhost] ffmpeg: %v", err)
		return h.streamScreenshotFallback(ctx, ps, st)
	}
	defer func() { _ = cmd.Wait() }()

	var pts int64
	var writeMu sync.Mutex
	readAnnexBFrames(ctx, stdout, func(au []byte, keyframe bool) {
		if st.forceKeyframe.Swap(false) {
			keyframe = true
		}
		vf := videoFrameH264(au, keyframe, pts)
		writeMu.Lock()
		err := ps.write(vf)
		writeMu.Unlock()
		if err != nil {
			log.Printf("[signalhost] video frame: %v", err)
		}
		pts++
	})
	return nil
}

func (h *Host) streamScreenshotFallback(ctx context.Context, ps *peerSession, st *streamState) error {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	var pts int64
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			jpeg, err := bdagent.CaptureScreenshotJPEG()
			if err != nil || len(jpeg) == 0 {
				continue
			}
			au, key, encErr := encodeJPEGToH264(ctx, jpeg)
			if encErr != nil || len(au) == 0 {
				continue
			}
			if st.forceKeyframe.Load() {
				key = true
				st.forceKeyframe.Store(false)
			}
			if err := ps.write(videoFrameH264(au, key, pts)); err != nil {
				return err
			}
			pts++
		}
	}
}

func videoFrameH264(data []byte, key bool, pts int64) *pb.Message {
	return &pb.Message{Union: &pb.Message_VideoFrame{VideoFrame: &pb.VideoFrame{
		Display: 0,
		Union: &pb.VideoFrame_H264S{H264S: &pb.EncodedVideoFrames{
			Frames: []*pb.EncodedVideoFrame{{Data: data, Key: key, Pts: pts}},
		}},
	}}}
}

// readAnnexBFrames splits H.264 Annex-B stream into access units.
func readAnnexBFrames(ctx context.Context, r io.Reader, onFrame func(au []byte, keyframe bool)) {
	buf := make([]byte, 0, 512*1024)
	tmp := make([]byte, 65536)
	var au []byte
	auHasVCL := false
	auIsKey := false

	flush := func() {
		if len(au) > 0 && auHasVCL {
			out := make([]byte, len(au))
			copy(out, au)
			onFrame(out, auIsKey)
		}
		au = au[:0]
		auHasVCL = false
		auIsKey = false
	}

	for {
		select {
		case <-ctx.Done():
			flush()
			return
		default:
		}
		n, readErr := r.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		for {
			s := indexStartCode(buf, 0)
			if s < 0 {
				break
			}
			scLen := startCodeLen(buf, s)
			next := indexStartCode(buf, s+scLen)
			if next < 0 {
				if s > 0 {
					buf = buf[s:]
				}
				break
			}
			nal := buf[s:next]
			nalType := byte(0)
			if s+scLen < next {
				nalType = nal[scLen] & 0x1F
			}
			switch nalType {
			case 1:
				if auHasVCL {
					flush()
				}
				au = append(au, nal...)
				auHasVCL = true
			case 5:
				if auHasVCL {
					flush()
				}
				au = append(au, nal...)
				auHasVCL = true
				auIsKey = true
			case 7, 8, 6:
				au = append(au, nal...)
			default:
				if auHasVCL {
					flush()
				}
				au = append(au, nal...)
			}
			buf = buf[next:]
		}
		if readErr != nil {
			flush()
			return
		}
	}
}

func indexStartCode(buf []byte, from int) int {
	for i := from; i+3 < len(buf); i++ {
		if buf[i] == 0 && buf[i+1] == 0 {
			if buf[i+2] == 1 {
				return i
			}
			if i+3 < len(buf) && buf[i+2] == 0 && buf[i+3] == 1 {
				return i
			}
		}
	}
	return -1
}

func startCodeLen(buf []byte, at int) int {
	if at+3 < len(buf) && buf[at+2] == 1 {
		return 3
	}
	return 4
}
