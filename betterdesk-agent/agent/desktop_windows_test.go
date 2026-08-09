//go:build windows

package agent

import "testing"

func TestWindowsCaptureKeepsGDIGRABPrimaryWithoutDXGI(t *testing.T) {
	strategies := windowsCaptureFFmpegStrategies(15, false)
	if len(strategies) != 1 {
		t.Fatalf("got %d capture strategies, want 1", len(strategies))
	}
	if strategies[0].Name != "gdigrab" {
		t.Fatalf("capture strategy = %q, want gdigrab", strategies[0].Name)
	}
}

func TestWindowsCaptureAddsDXGIFallbackWhenAvailable(t *testing.T) {
	strategies := windowsCaptureFFmpegStrategies(15, true)
	if len(strategies) != 2 {
		t.Fatalf("got %d capture strategies, want 2", len(strategies))
	}
	if strategies[0].Name != "gdigrab" {
		t.Fatalf("primary capture strategy = %q, want gdigrab", strategies[0].Name)
	}
	if strategies[1].Name != "ddagrab(DXGI fallback)" {
		t.Fatalf("fallback capture strategy = %q, want DXGI ddagrab", strategies[1].Name)
	}
	if got, want := strategies[1].Args[3], "ddagrab=output_idx=0:framerate=15:draw_mouse=1,hwdownload,format=bgra"; got != want {
		t.Fatalf("ddagrab source = %q, want %q", got, want)
	}
}

func TestFFmpegFilterListed(t *testing.T) {
	output := []byte(" ... ddagrab           V->V       Grab Windows desktop via Desktop Duplication API.\n")
	if !ffmpegFilterListed(output, "ddagrab") {
		t.Fatal("expected ddagrab filter to be detected")
	}
	if ffmpegFilterListed(output, "gdigrab") {
		t.Fatal("unexpected unrelated filter detection")
	}
}

func TestFFmpegHasDXGIFallbackFilters(t *testing.T) {
	output := []byte(`
 ... ddagrab           V->V       Grab Windows desktop via Desktop Duplication API.
 ... format            V->V       Convert the input video to one of the specified pixel formats.
 ... hwdownload        V->V       Download a hardware frame to a normal frame.
`)
	if !ffmpegHasDXGIFallbackFilters(output) {
		t.Fatal("expected complete DXGI fallback filter set")
	}
	if ffmpegHasDXGIFallbackFilters([]byte(" ... ddagrab V->V\n ... format V->V\n")) {
		t.Fatal("expected missing hwdownload filter to reject DXGI fallback")
	}
}
