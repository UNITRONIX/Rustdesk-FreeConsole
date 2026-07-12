package ratelimit

import "sync"

// ConnLimiter limits the number of concurrent connections per IP address.
// Used to prevent a single IP from exhausting relay resources.
type ConnLimiter struct {
	mu      sync.Mutex
	active  map[string]int32
	maxConn int32
}

// NewConnLimiter creates a connection limiter with the given max connections per IP.
func NewConnLimiter(maxPerIP int32) *ConnLimiter {
	return &ConnLimiter{
		active:  make(map[string]int32),
		maxConn: maxPerIP,
	}
}

// NewConnLimiterFromInt creates a limiter from an int, clamping to int32 range.
func NewConnLimiterFromInt(maxPerIP int) *ConnLimiter {
	const maxInt32 = 1<<31 - 1
	if maxPerIP > maxInt32 {
		maxPerIP = maxInt32
	}
	if maxPerIP < 0 {
		maxPerIP = 0
	}
	return NewConnLimiter(int32(maxPerIP))
}

// Acquire attempts to register a new connection from the given IP.
// Returns true if the connection is allowed, false if the IP is at its limit.
func (l *ConnLimiter) Acquire(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.active[ip] >= l.maxConn {
		return false
	}
	l.active[ip]++
	return true
}

// Release decrements the active connection count for the given IP.
// Must be called when a relay connection closes.
func (l *ConnLimiter) Release(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.active[ip]--
	if l.active[ip] <= 0 {
		delete(l.active, ip)
	}
}

// ActiveCount returns the number of active connections for an IP.
func (l *ConnLimiter) ActiveCount(ip string) int32 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.active[ip]
}

// TotalActive returns the total number of active connections across all IPs.
func (l *ConnLimiter) TotalActive() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	total := 0
	for _, v := range l.active {
		total += int(v)
	}
	return total
}
