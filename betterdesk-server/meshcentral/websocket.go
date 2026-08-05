package meshcentral

import "github.com/coder/websocket"

// webSocketAcceptOptions preserves the WebSocket library's same-host origin
// checks by default and permits explicitly configured browser origins. Clients
// without an Origin header, such as MeshAgent, remain protocol-compatible.
func (g *Gateway) webSocketAcceptOptions() *websocket.AcceptOptions {
	opts := &websocket.AcceptOptions{}
	if g != nil && g.cfg != nil {
		opts.OriginPatterns = g.cfg.GetAllowedWSOrigins()
	}
	return opts
}
