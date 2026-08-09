package signalhost

import (
	"os"
	"os/user"
	"runtime"

	bdagent "github.com/unitronix/betterdesk-agent/agent"
	pb "github.com/unitronix/betterdesk-server/proto"
)

// buildPeerInfo publishes only codecs that were actively probed for this host.
// Features such as audio, file transfer, clipboard, terminal, and multi-monitor
// remain absent until their corresponding host paths exist.
func buildPeerInfo(deviceID string, encoding *pb.SupportedEncoding) (*pb.PeerInfo, uint32, uint32) {
	displays, w, h := primaryDisplayInfo()
	username := "user"
	if u, err := user.Current(); err == nil && u.Username != "" {
		username = u.Username
	}
	hostname := deviceID
	if hn, err := os.Hostname(); err == nil && hn != "" {
		hostname = hn
	}
	return &pb.PeerInfo{
		Username:       username,
		Hostname:       hostname,
		Platform:       runtime.GOOS,
		Displays:       displays,
		CurrentDisplay: 0,
		Version:        "1.0",
		Encoding:       encoding,
	}, w, h
}

func primaryDisplayInfo() ([]*pb.DisplayInfo, uint32, uint32) {
	w, h := uint32(1920), uint32(1080)
	if jpeg, err := bdagent.CaptureScreenshotJPEG(); err == nil && len(jpeg) > 0 {
		if jw, jh := jpegSize(jpeg); jw > 0 && jh > 0 {
			w, h = uint32(jw), uint32(jh)
		}
	}
	display := &pb.DisplayInfo{
		X: 0, Y: 0,
		Width: int32(w), Height: int32(h),
		Name: "Primary", Online: true,
	}
	return []*pb.DisplayInfo{display}, w, h
}

// jpegSize reads width/height from JPEG SOF marker.
func jpegSize(data []byte) (int, int) {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 0, 0
	}
	i := 2
	for i+9 < len(data) {
		if data[i] != 0xFF {
			i++
			continue
		}
		marker := data[i+1]
		if marker == 0xC0 || marker == 0xC2 {
			h := int(data[i+5])<<8 | int(data[i+6])
			w := int(data[i+7])<<8 | int(data[i+8])
			return w, h
		}
		if i+3 >= len(data) {
			break
		}
		segLen := int(data[i+2])<<8 | int(data[i+3])
		if segLen < 2 {
			break
		}
		i += 2 + segLen
	}
	return 0, 0
}
