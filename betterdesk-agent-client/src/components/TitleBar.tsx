import { Component } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { t } from "../lib/i18n";
import { getBranding } from "../lib/branding";

/**
 * Custom window title bar.
 *
 * The native window decorations are disabled (`decorations: false` in
 * tauri.conf.json) because the client-side decorations rendered by WebKitGTK
 * under Wayland frequently fail to receive pointer events, leaving the
 * minimize / close buttons completely dead. Drawing our own title bar gives us
 * full control: the buttons call the Tauri window API directly and the bar acts
 * as a drag region so the window can still be moved.
 *
 * Close hides the window to the tray (the agent must stay alive in the
 * background), matching the CloseRequested handler in lib.rs.
 */
const TitleBar: Component = () => {
  const minimize = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch {
      /* ignore */
    }
  };

  // Hide to tray instead of terminating — the agent keeps running in the
  // background for remote assistance.
  const close = async () => {
    try {
      await getCurrentWindow().hide();
    } catch {
      /* ignore */
    }
  };

  // Explicit drag fallback. The `data-tauri-drag-region` attribute is unreliable
  // under Wayland, so we start the native window drag manually on primary-button
  // press over the bar (but not over the control buttons).
  const startDrag = async (e: MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".app-titlebar-controls")) return;
    try {
      await getCurrentWindow().startDragging();
    } catch {
      /* ignore */
    }
  };

  return (
    <div class="app-titlebar" data-tauri-drag-region onMouseDown={startDrag}>
      <span class="app-titlebar-title" data-tauri-drag-region>
        {getBranding().product_name || "BetterDesk Agent"}
      </span>
      <div class="app-titlebar-controls">
        <button
          class="app-titlebar-btn"
          onClick={minimize}
          title={t("app.minimize")}
          aria-label={t("app.minimize")}
        >
          <span class="material-symbols-rounded">remove</span>
        </button>
        <button
          class="app-titlebar-btn app-titlebar-btn-close"
          onClick={close}
          title={t("app.close_window")}
          aria-label={t("app.close_window")}
        >
          <span class="material-symbols-rounded">close</span>
        </button>
      </div>
    </div>
  );
};

export default TitleBar;
