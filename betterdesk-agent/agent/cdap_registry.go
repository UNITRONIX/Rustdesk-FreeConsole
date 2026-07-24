package agent

// CDAPMessageRegistry lists message families handled by the Go sidecar.
// Add new capability handlers here and in agent.go dispatch — Tauri UI
// stays thin via IPC unless a new consent/overlay surface is required.
var CDAPMessageRegistry = []string{
	"heartbeat",
	"manifest",
	"terminal_open", "terminal_data", "terminal_close",
	"file_list", "file_read", "file_write", "file_delete", "file_mkdir",
	"clipboard_get", "clipboard_set",
	"desktop_start", "desktop_stop", "desktop_frame",
	"codec_offer", "codec_answer", "keyframe_request", "quality_update", "quality_report",
	"monitor_list", "monitor_select",
	"consent_request", "consent_response",
	"screenshot",
	"command_run", "command_result",
	"audio_start", "audio_stop",
}
