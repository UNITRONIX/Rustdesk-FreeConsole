package signalhost

import pb "github.com/unitronix/betterdesk-server/proto"

func videoFrameMessage(wire string, data []byte, key bool, pts int64) *pb.Message {
	frames := &pb.EncodedVideoFrames{
		Frames: []*pb.EncodedVideoFrame{{Data: data, Key: key, Pts: pts}},
	}
	vf := &pb.VideoFrame{Display: 0}
	switch wire {
	case wireH265:
		vf.Union = &pb.VideoFrame_H265S{H265S: frames}
	case wireVP8:
		vf.Union = &pb.VideoFrame_Vp8S{Vp8S: frames}
	case wireVP9:
		vf.Union = &pb.VideoFrame_Vp9S{Vp9S: frames}
	case wireAV1:
		vf.Union = &pb.VideoFrame_Av1S{Av1S: frames}
	default:
		vf.Union = &pb.VideoFrame_H264S{H264S: frames}
	}
	return &pb.Message{Union: &pb.Message_VideoFrame{VideoFrame: vf}}
}
