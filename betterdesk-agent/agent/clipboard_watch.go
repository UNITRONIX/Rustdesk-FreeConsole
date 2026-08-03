package agent

import (
	"context"
	"log"
	"time"
)

const (
	clipboardPollInterval = 500 * time.Millisecond
	maxClipboardPushBytes = 512 * 1024 // 512 KiB text cap for push updates
)

// startClipboardWatch polls the OS clipboard during an active desktop session
// and emits clipboard_update so the operator browser can sync remote → local.
func (a *Agent) startClipboardWatch(sessionID string) {
	if !a.cfg.Clipboard || sessionID == "" {
		return
	}
	a.stopClipboardWatch(sessionID)

	ctx, cancel := context.WithCancel(a.ctx)
	a.clipboardWatch.Store(sessionID, cancel)

	go func() {
		defer a.clipboardWatch.Delete(sessionID)
		ticker := time.NewTicker(clipboardPollInterval)
		defer ticker.Stop()

		var lastSent string
		if v, ok := a.lastClipSet.Load(sessionID); ok {
			if s, ok := v.(string); ok {
				lastSent = s
			}
		}

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if a.sessionFlags(sessionID).isClipboardDisabled() {
					continue
				}
				text := a.clipboard.Get()
				if text == "" || text == lastSent {
					continue
				}
				if len(text) > maxClipboardPushBytes {
					log.Printf("[clipboard] skip push: %d bytes exceeds limit", len(text))
					lastSent = text
					continue
				}
				lastSent = text
				a.lastClipSet.Store(sessionID, text)
				if err := a.sendMessage("clipboard_update", map[string]any{
					"session_id": sessionID,
					"format":     "text",
					"data":       text,
				}); err != nil {
					log.Printf("[clipboard] clipboard_update failed: %v", err)
				}
			}
		}
	}()
}

func (a *Agent) stopClipboardWatch(sessionID string) {
	if sessionID == "" {
		return
	}
	if v, ok := a.clipboardWatch.LoadAndDelete(sessionID); ok {
		if cancel, ok := v.(context.CancelFunc); ok {
			cancel()
		}
	}
}
