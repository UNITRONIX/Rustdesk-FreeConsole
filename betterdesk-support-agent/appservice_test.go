package main

import "testing"

func TestUISnapshotIncludesBrandContactDetails(t *testing.T) {
	t.Setenv("BETTERDESK_AGENT_DATA_DIR", t.TempDir())
	st, err := LoadState()
	if err != nil {
		t.Fatal(err)
	}
	svc := &AppService{
		brand: Branding{
			ProductName:  "Acme Support",
			SupportEmail: "support@example.test",
			SupportPhone: "+48 123 456 789",
			ContactURL:   "https://example.test/help",
		},
		state:      st,
		statusKind: statusKindReady,
		statusText: "Ready",
	}

	snapshot := svc.GetSnapshot()
	if snapshot.SupportEmail != "support@example.test" ||
		snapshot.SupportPhone != "+48 123 456 789" ||
		snapshot.ContactURL != "https://example.test/help" {
		t.Fatalf("contact fields missing from UI snapshot: %#v", snapshot)
	}
}
