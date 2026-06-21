package meshcentral

import "fmt"

// TunnelOpts optional MeshCentral tunnel fields (TCP/UDP relay targets).
type TunnelOpts struct {
	TCPAddr string
	TCPPort int
	UDPAddr string
	UDPPort int
}

// CreateTcpRelayTunnel opens a TCP port relay through the MeshAgent (MeshCentral p=14).
func (g *Gateway) CreateTcpRelayTunnel(peerID, userID, relayBase, targetHost string, targetPort int) (string, string, error) {
	if targetHost == "" {
		targetHost = "127.0.0.1"
	}
	if targetPort <= 0 || targetPort > 65535 {
		return "", "", fmt.Errorf("invalid target port")
	}
	opts := &TunnelOpts{TCPAddr: targetHost, TCPPort: targetPort}
	return g.createRelayTunnel(peerID, userID, relayBase, relayProtocolTCP, "tcp_relay", false, false, opts)
}

// CreateUdpRelayTunnel opens a UDP port relay through the MeshAgent.
func (g *Gateway) CreateUdpRelayTunnel(peerID, userID, relayBase, targetHost string, targetPort int) (string, string, error) {
	if targetHost == "" {
		targetHost = "127.0.0.1"
	}
	if targetPort <= 0 || targetPort > 65535 {
		return "", "", fmt.Errorf("invalid target port")
	}
	opts := &TunnelOpts{UDPAddr: targetHost, UDPPort: targetPort}
	return g.createRelayTunnel(peerID, userID, relayBase, relayProtocolTCP, "udp_relay", false, false, opts)
}
