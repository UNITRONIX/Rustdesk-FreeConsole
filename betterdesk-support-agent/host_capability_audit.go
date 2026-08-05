package main

const (
	hostCapabilityAuditTransportCDAP   = "cdap"
	hostCapabilityAuditTransportSignal = "signal"
)

// auditHostCapabilityPolicy records the fixed policy outcome only. The
// records cannot contain credentials, grant presentations, clipboard content,
// terminal data, chat text, or arbitrary remote input.
func auditHostCapabilityPolicy(transport string, policy hostCapabilityPolicy) {
	appLogInfo("host_capability_policy", "host capability policy evaluated", map[string]any{
		"transport": normalizeHostCapabilityAuditTransport(transport),
		"features":  policy.auditRecords(),
	})
}

func normalizeHostCapabilityAuditTransport(transport string) string {
	switch transport {
	case hostCapabilityAuditTransportCDAP, hostCapabilityAuditTransportSignal:
		return transport
	default:
		return "unknown"
	}
}
