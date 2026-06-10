package api

import "testing"

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
