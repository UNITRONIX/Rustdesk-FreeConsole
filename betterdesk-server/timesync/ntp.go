// Package timesync monitors server clock accuracy against NTP sources.
package timesync

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"time"
)

const ntpEpochOffset = 2208988800 // seconds between 1900-01-01 and 1970-01-01

// QueryNTP performs a single NTP v4 client query and returns the estimated
// offset between the local clock and the remote server (local - remote).
func QueryNTP(server string, timeout time.Duration) (offset time.Duration, stratum uint8, err error) {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	addr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(server, "123"))
	if err != nil {
		return 0, 0, fmt.Errorf("timesync: resolve %s: %w", server, err)
	}

	conn, err := net.DialUDP("udp", nil, addr)
	if err != nil {
		return 0, 0, fmt.Errorf("timesync: dial %s: %w", server, err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))

	// NTP request: LI=0, VN=4, Mode=3 (client)
	req := make([]byte, 48)
	req[0] = 0x23

	t1 := time.Now()
	if _, err := conn.Write(req); err != nil {
		return 0, 0, fmt.Errorf("timesync: write: %w", err)
	}

	resp := make([]byte, 48)
	n, err := conn.Read(resp)
	if err != nil {
		return 0, 0, fmt.Errorf("timesync: read: %w", err)
	}
	if n < 48 {
		return 0, 0, errors.New("timesync: short NTP response")
	}

	t4 := time.Now()
	stratum = resp[1]

	t2 := ntpTimestampToTime(resp[32:40])
	t3 := ntpTimestampToTime(resp[40:48])
	if t2.IsZero() || t3.IsZero() {
		return 0, stratum, errors.New("timesync: invalid NTP timestamps")
	}

	// Standard NTP offset: ((t2 - t1) + (t3 - t4)) / 2
	offset = (t2.Sub(t1) + t3.Sub(t4)) / 2
	return offset, stratum, nil
}

func ntpTimestampToTime(b []byte) time.Time {
	if len(b) < 8 {
		return time.Time{}
	}
	secs := binary.BigEndian.Uint32(b[0:4])
	frac := binary.BigEndian.Uint32(b[4:8])
	if secs == 0 {
		return time.Time{}
	}
	unix := int64(secs) - ntpEpochOffset
	nano := (int64(frac) * 1e9) >> 32
	return time.Unix(unix, nano).UTC()
}
