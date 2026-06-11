package api

import (
	"errors"
	"testing"
)

func TestMergeAddressBookJSON(t *testing.T) {
	t.Parallel()

	base := `{"peers":[{"id":"111","alias":"Mine","tags":["Home"]}],"tags":["Home"],"tag_colors":{}}`
	overlay := `{"peers":[{"id":"111","alias":"OrgName","tags":["Office"]},{"id":"222","alias":"Shared"}],"tags":["Office","Shared"]}`

	got := mergeAddressBookJSON(base, overlay)
	wantPeers := 2
	ab := parseAddressBookMap(got)
	peers := toPeerSlice(ab["peers"])
	if len(peers) != wantPeers {
		t.Fatalf("peer count = %d, want %d; data=%s", len(peers), wantPeers, got)
	}
	if peers[0]["alias"] != "Mine" {
		t.Fatalf("base peer alias should win, got %v", peers[0]["alias"])
	}
	tags := toStringSlice(ab["tags"])
	if len(tags) != 3 {
		t.Fatalf("tag union = %v, want 3 tags", tags)
	}
	if _, ok := ab["tag_colors"]; !ok {
		t.Fatal("expected tag_colors preserved from base")
	}
}

func TestMergeAddressBookJSONEmptyOverlay(t *testing.T) {
	t.Parallel()
	base := `{"peers":[{"id":"1"}],"tags":[]}`
	if got := mergeAddressBookJSON(base, "{}", ""); got != base {
		t.Fatalf("expected unchanged base, got %s", got)
	}
}

func TestOrgSharedAddressBookEnabledFromValue(t *testing.T) {
	t.Parallel()

	dbErr := errors.New("database is locked")

	tests := []struct {
		name  string
		value string
		err   error
		want  bool
	}{
		{name: "db error fail closed", err: dbErr, want: false},
		{name: "missing setting defaults enabled", err: errors.New("org setting not found: org1/shared_address_book_enabled"), want: true},
		{name: "explicit true", value: "true", want: true},
		{name: "explicit false", value: "false", want: false},
		{name: "empty defaults enabled", value: "", want: true},
		{name: "whitespace false", value: " FALSE ", want: false},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := orgSharedAddressBookEnabledFromValue(tc.value, tc.err); got != tc.want {
				t.Fatalf("orgSharedAddressBookEnabledFromValue(%q, err=%v) = %v, want %v", tc.value, tc.err, got, tc.want)
			}
		})
	}
}
