package signalhost

import (
	"context"
	"io"
	"log"
	"time"

	bdagent "github.com/unitronix/betterdesk-agent/agent"
	pb "github.com/unitronix/betterdesk-server/proto"
)

// streamSession sends encoded video frames and processes peer input until the connection closes.
func (h *Host) streamSession(ps *peerSession, codec negotiatedVideoCodec, options *pb.OptionMessage) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	st := newStreamState(codec, options)
	inputDone := make(chan struct{})
	go func() {
		defer close(inputDone)
		h.readPeerInput(ctx, ps, st)
		cancel()
	}()

	err := h.streamEncoded(ctx, ps, st)
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
		h.handlePeerMessage(frame, st)
	}
}

func (h *Host) streamEncoded(ctx context.Context, ps *peerSession, st *streamState) error {
	var pts int64
	for {
		codec := st.currentCodec()
		wire := codec.wire()
		if wire == wireNone {
			return nil
		}
		plan, ok := resolveEncoderPlan(wire)
		if !ok {
			if wire == wireH264 {
				return h.streamScreenshotFallback(ctx, ps, st)
			}
			log.Printf("[signalhost] no encoder for %s", wire)
			return nil
		}

		settings := st.settings()
		strategies := captureStrategies(settings.fps)
		if len(strategies) == 0 {
			if wire == wireH264 {
				return h.streamScreenshotFallback(ctx, ps, st)
			}
			return nil
		}

		var started bool
		for _, strat := range strategies {
			args := buildCaptureEncodeArgs(strat, plan, settings.fps, settings.quality)
			if len(args) == 0 {
				continue
			}
			encoderCtx, cancelEncoder := context.WithCancel(ctx)
			cmd, stdout, err := startFFmpegCapture(encoderCtx, args)
			if err != nil {
				cancelEncoder()
				log.Printf("[signalhost] ffmpeg %s/%s: %v", strat.Name, plan.ffmpegName, err)
				continue
			}
			started = true
			st.markEncoderStarted(time.Now())
			log.Printf("[signalhost] streaming codec=%s encoder=%s capture=%s", wire, plan.ffmpegName, strat.Name)

			done := make(chan error, 1)
			go func() {
				var writeErr error
				onFrame := func(au []byte, keyframe bool) {
					if writeErr != nil {
						return
					}
					startedAt := time.Now()
					if err := ps.write(videoFrameMessage(wire, au, keyframe, pts)); err != nil {
						writeErr = err
						cancelEncoder()
						return
					}
					pts++
					st.observeWrite(time.Since(startedAt))
				}
				switch plan.mode {
				case frameModeIVF:
					readIVFFrames(encoderCtx, stdout, wire, onFrame)
				default:
					if wire == wireH265 {
						readHEVCAnnexBFrames(encoderCtx, stdout, onFrame)
					} else {
						readAnnexBFrames(encoderCtx, stdout, onFrame)
					}
				}
				done <- writeErr
			}()

			select {
			case <-ctx.Done():
				cancelEncoder()
				<-done
				_ = cmd.Wait()
				return nil
			case <-st.reconfigure:
				cancelEncoder()
				writeErr := <-done
				_ = cmd.Wait()
				if writeErr != nil {
					return writeErr
				}
				if ctx.Err() != nil {
					return nil
				}
				goto restart
			case writeErr := <-done:
				cancelEncoder()
				waitErr := cmd.Wait()
				if writeErr != nil {
					return writeErr
				}
				if ctx.Err() != nil {
					return nil
				}
				if waitErr != nil {
					log.Printf("[signalhost] %s capture ended (%s): %v", wire, strat.Name, waitErr)
				}
				// try next capture strategy
			}
		}
		if !started && wire == wireH264 {
			return h.streamScreenshotFallback(ctx, ps, st)
		}
		if !started {
			return nil
		}
		// All strategies failed mid-stream — H.264 can fall back to screenshots.
		if wire == wireH264 {
			return h.streamScreenshotFallback(ctx, ps, st)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(2 * time.Second):
		}
	restart:
	}
}

func (h *Host) streamScreenshotFallback(ctx context.Context, ps *peerSession, st *streamState) error {
	var pts int64
	for {
		if st.currentCodec() != videoCodecH264 {
			return nil
		}
		settings := st.settings()
		timer := time.NewTimer(frameInterval(settings.fps))
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return nil
		case <-st.reconfigure:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			continue
		case <-timer.C:
		}

		jpeg, err := bdagent.CaptureScreenshotJPEG()
		if err != nil || len(jpeg) == 0 {
			continue
		}
		au, key, encErr := encodeJPEGToH264(ctx, jpeg, settings.quality)
		if encErr != nil || len(au) == 0 {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(2 * time.Second):
			}
			continue
		}
		started := time.Now()
		if err := ps.write(videoFrameMessage(wireH264, au, key, pts)); err != nil {
			return err
		}
		pts++
		st.observeWrite(time.Since(started))
	}
}

// readAnnexBFrames splits H.264 Annex-B stream into access units.
func readAnnexBFrames(ctx context.Context, r io.Reader, onFrame func(au []byte, keyframe bool)) {
	readAnnexB(ctx, r, false, onFrame)
}

func readHEVCAnnexBFrames(ctx context.Context, r io.Reader, onFrame func(au []byte, keyframe bool)) {
	readAnnexB(ctx, r, true, onFrame)
}

func readAnnexB(ctx context.Context, r io.Reader, hevc bool, onFrame func(au []byte, keyframe bool)) {
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
			if hevc {
				nalType := byte(0)
				if s+scLen < next {
					nalType = (nal[scLen] >> 1) & 0x3F
				}
				switch nalType {
				case 19, 20, 21: // IDR / CRA
					if auHasVCL {
						flush()
					}
					au = append(au, nal...)
					auHasVCL = true
					auIsKey = true
				case 0, 1: // TRAIL
					if auHasVCL {
						flush()
					}
					au = append(au, nal...)
					auHasVCL = true
				case 32, 33, 34, 39: // VPS/SPS/PPS/SEI
					au = append(au, nal...)
				default:
					if auHasVCL {
						flush()
					}
					au = append(au, nal...)
				}
			} else {
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
