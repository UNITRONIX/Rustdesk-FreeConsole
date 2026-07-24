import {
  Component,
  createSignal,
  onMount,
  onCleanup,
  Show,
  For,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { t } from "../lib/i18n";

interface ActiveSession {
  session_id: string;
  operator: string;
  mode: string; // "supervised" | "unattended"
  started_at: string; // ISO-8601
}

/**
 * SessionOverlay — TV-style on-screen indicator shown while an operator is
 * actively viewing this device. Renders a coloured border across the viewport
 * and a collapsible widget in the bottom-right corner with operator name,
 * elapsed time, and a Disconnect button.
 *
 * Border colour:
 *  - amber  → supervised (user accepted via consent dialog)
 *  - red    → unattended (operator connected without consent)
 *
 * Data source: Tauri events `session-active` / `session-ended` emitted by
 * `sidecar.rs` when the Go agent prints `SESSION_START:` / `SESSION_END:`
 * to stdout. We also poll `get_active_sessions` on mount to recover from
 * page reloads / late mounts.
 */
const SessionOverlay: Component = () => {
  const [sessions, setSessions] = createSignal<ActiveSession[]>([]);
  const [collapsed, setCollapsed] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());

  let unlistenStart: UnlistenFn | undefined;
  let unlistenEnd: UnlistenFn | undefined;
  let tick: number | undefined;

  const refreshFromBackend = async () => {
    try {
      const list = await invoke<ActiveSession[]>("get_active_sessions");
      setSessions(list);
    } catch (e) {
      console.warn("[overlay] get_active_sessions failed:", e);
    }
  };

  const upsertSession = (s: ActiveSession) => {
    setSessions((prev) => {
      const filtered = prev.filter((p) => p.session_id !== s.session_id);
      return [...filtered, s];
    });
  };

  const removeSession = (id: string) => {
    setSessions((prev) => prev.filter((p) => p.session_id !== id));
  };

  const disconnect = async (id: string) => {
    try {
      await invoke("disconnect_active_session", { sessionId: id });
    } catch (e) {
      console.error("[overlay] disconnect failed:", e);
    }
    // Remove optimistically; SESSION_END from sidecar will confirm.
    removeSession(id);
  };

  const formatElapsed = (startedAt: string): string => {
    const started = Date.parse(startedAt);
    if (Number.isNaN(started)) return "—";
    const secs = Math.max(0, Math.floor((now() - started) / 1000));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const primaryMode = (): "supervised" | "unattended" => {
    return sessions().some((s) => s.mode === "unattended")
      ? "unattended"
      : "supervised";
  };

  onMount(async () => {
    unlistenStart = await listen<string>("session-active", (event) => {
      try {
        const data = JSON.parse(event.payload);
        upsertSession({
          session_id: String(data.session_id ?? ""),
          operator: String(data.operator ?? ""),
          mode: String(data.mode ?? "supervised"),
          started_at: new Date().toISOString(),
        });
      } catch (e) {
        console.error("[overlay] bad session-active payload:", e);
      }
    });

    unlistenEnd = await listen<string>("session-ended", (event) => {
      try {
        const data = JSON.parse(event.payload);
        if (data.session_id) removeSession(String(data.session_id));
      } catch (e) {
        console.error("[overlay] bad session-ended payload:", e);
      }
    });

    await refreshFromBackend();
    tick = window.setInterval(() => setNow(Date.now()), 1000);
  });

  onCleanup(() => {
    unlistenStart?.();
    unlistenEnd?.();
    if (tick !== undefined) clearInterval(tick);
  });

  return (
    <Show when={sessions().length > 0}>
      {/* The on-screen border around the primary monitor is drawn by a
          dedicated native click-through Tauri window (see
          `src-tauri/src/session_overlay.rs`). The in-app UI below only
          provides the collapsible session widget. */}

      <div
        class="session-overlay-widget"
        classList={{
          "session-overlay-widget--collapsed": collapsed(),
          "session-overlay-widget--unattended": primaryMode() === "unattended",
        }}
      >
        <button
          type="button"
          class="session-overlay-toggle"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={
            collapsed() ? t("session.expand") : t("session.collapse")
          }
        >
          <span class="material-symbols-rounded">
            {collapsed() ? "chevron_left" : "chevron_right"}
          </span>
        </button>

        <Show when={!collapsed()}>
          <div class="session-overlay-body">
            <div class="session-overlay-header">
              <span class="material-symbols-rounded session-overlay-icon">
                screen_share
              </span>
              <span class="session-overlay-title">
                {t("session.active_title")}
              </span>
            </div>

            <For each={sessions()}>
              {(s) => (
                <div class="session-overlay-row">
                  <div class="session-overlay-info">
                    <div class="session-overlay-operator">
                      <strong>{s.operator || "—"}</strong>
                    </div>
                    <div class="session-overlay-meta">
                      <span class={`session-overlay-mode session-overlay-mode--${s.mode}`}>
                        {s.mode === "unattended"
                          ? t("session.unattended")
                          : t("session.supervised")}
                      </span>
                      <span class="session-overlay-elapsed">
                        {t("session.elapsed")} {formatElapsed(s.started_at)}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    class="btn btn-danger btn-sm session-overlay-disconnect"
                    onClick={() => disconnect(s.session_id)}
                  >
                    <span class="material-symbols-rounded">link_off</span>
                    {t("session.disconnect")}
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
};

export default SessionOverlay;
