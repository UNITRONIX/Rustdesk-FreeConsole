package meshcentral

// RelayConnectSignal returns MeshCentral relay pairing signal ('c' or 'cr' when recording).
func RelayConnectSignal(recording bool) string {
	if recording {
		return "cr"
	}
	return "c"
}
