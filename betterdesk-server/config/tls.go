// Package config — TLS utilities for BetterDesk server.
// Provides a shared TLS configuration loader and a dual-mode listener that
// accepts both plain TCP and TLS on the same port (first-byte detection).
package config

import (
	"bufio"
	"crypto/tls"
	"fmt"
	"net"
	"time"
)

// TLSHandshakeTimeout is the maximum time allowed for a TLS handshake.
const TLSHandshakeTimeout = 10 // seconds (used as time.Duration in callers)

// LoadTLSConfig loads a TLS certificate/key pair and returns a *tls.Config
// with secure defaults. This is the single source of truth for all TLS
// configuration across signal, relay, and API servers.
func LoadTLSConfig(certFile, keyFile string) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("load TLS keypair: %w", err)
	}
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
	}, nil
}

// tlsRecordTypeHandshake is the first byte of a TLS ClientHello message.
// Protobuf-encoded RustDesk RendezvousMessage never starts with 0x16,
// making this byte reliable for auto-detecting TLS vs. plain connections.
const tlsRecordTypeHandshake byte = 0x16

// DualModeListener wraps a net.Listener to auto-detect TLS vs. plain TCP.
//
// On Accept(), it peeks at the first byte of each connection:
//   - 0x16 (TLS ClientHello) → connection is wrapped with tls.Server
//   - anything else → connection is returned as plain TCP
//
// This allows both legacy plain clients and new TLS clients to connect
// on the same port without requiring separate listener ports.
type DualModeListener struct {
	inner  net.Listener
	tlsCfg *tls.Config
}

// NewDualModeListener creates a listener that auto-detects TLS connections.
// The tlsCfg is used for connections identified as TLS.
func NewDualModeListener(ln net.Listener, cfg *tls.Config) net.Listener {
	return &DualModeListener{inner: ln, tlsCfg: cfg}
}

// NewTLSOnlyListener wraps a listener with TLS without the legacy plaintext
// fallback. The HTTP server performs the handshake on first read, allowing
// its existing header timeout to bound incomplete handshakes.
func NewTLSOnlyListener(ln net.Listener, cfg *tls.Config) net.Listener {
	return tls.NewListener(ln, cfg)
}

// dualModePeekTimeout is the maximum time to wait for the client's first byte
// when detecting TLS vs plain TCP. RustDesk clients that are logged in call
// secure_tcp which READs first (waiting for the server's KeyExchange). If we
// block on Peek indefinitely, we deadlock: server waits for client's first
// byte, client waits for server's KeyExchange. A short timeout breaks the
// deadlock — if no byte arrives, we assume a plain TCP client that expects the
// server to send first (NegotiateSecureTCP will do exactly that).
const dualModePeekTimeout = 200 * time.Millisecond

// Accept waits for and returns the next connection.
// If the first byte is a TLS handshake record, the connection is upgraded.
// If the client does not send a first byte within dualModePeekTimeout, the
// connection is returned as plain TCP (the client likely expects the server
// to initiate the NaCl key exchange).
func (d *DualModeListener) Accept() (net.Conn, error) {
	conn, err := d.inner.Accept()
	if err != nil {
		return nil, err
	}

	// Set a short deadline for the peek so logged-in RustDesk clients
	// (which wait for the server's KeyExchange first) don't deadlock.
	conn.SetReadDeadline(time.Now().Add(dualModePeekTimeout))

	// Peek at the first byte to determine protocol
	br := bufio.NewReaderSize(conn, 1)
	first, err := br.Peek(1)

	// Clear the deadline regardless of outcome
	conn.SetReadDeadline(time.Time{})

	if err != nil {
		// Timeout → client did not send first byte in time.
		// This is expected for logged-in RustDesk clients that call
		// secure_tcp (they read first, waiting for server's KeyExchange).
		// Return the raw connection so NegotiateSecureTCP can send first.
		if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
			return conn, nil
		}
		conn.Close()
		return nil, err
	}

	peeked := &peekedConn{Conn: conn, reader: br}

	if first[0] == tlsRecordTypeHandshake {
		// TLS ClientHello detected — upgrade to TLS
		return tls.Server(peeked, d.tlsCfg), nil
	}

	// Plain TCP — return as-is with buffered reader
	return peeked, nil
}

// Close closes the underlying listener.
func (d *DualModeListener) Close() error { return d.inner.Close() }

// Addr returns the listener's network address.
func (d *DualModeListener) Addr() net.Addr { return d.inner.Addr() }

// peekedConn wraps a net.Conn with a bufio.Reader to preserve peeked bytes.
// After Peek(), the buffered reader holds the peeked data; Read() returns
// it transparently before reading new data from the underlying connection.
type peekedConn struct {
	net.Conn
	reader *bufio.Reader
}

// Read reads from the buffered reader (returns peeked bytes first).
func (p *peekedConn) Read(b []byte) (int, error) {
	return p.reader.Read(b)
}
