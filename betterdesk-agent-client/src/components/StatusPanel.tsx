import { Component, Show, createSignal, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n";
import { getBranding } from "../lib/branding";
import { frontendLog } from "../lib/logger";

interface AgentStatus {
  registered: boolean;
  connected: boolean;
  server_address: string;
  device_id: string;
  hostname: string;
  platform: string;
  version: string;
  uptime_secs: number;
  last_sync: string;
}

interface SidecarStatus {
  running: boolean;
  pid: number;
  restart_count: number;
  state: string;
  binary_path: string;
  cdap_url: string;
}

const StatusPanel: Component = () => {
  const [status, setStatus] = createSignal<AgentStatus | null>(null);
  const [sidecar, setSidecar] = createSignal<SidecarStatus | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [copyFeedback, setCopyFeedback] = createSignal(false);
  const [diagFeedback, setDiagFeedback] = createSignal<"" | "ok" | "error">("");
  const [sidecarAction, setSidecarAction] = createSignal<"" | "busy">(""); 
  const [sidecarError, setSidecarError] = createSignal("");
  const [isAdmin, setIsAdmin] = createSignal(false);
  const [showAdvanced, setShowAdvanced] = createSignal(false);
  const [unattendedPassword, setUnattendedPassword] = createSignal("");
  const [pwCopyFeedback, setPwCopyFeedback] = createSignal(false);
  const [accessMode, setAccessMode] = createSignal<string>("");
  let initialSnapshotLogged = false;

  let pollInterval: ReturnType<typeof setInterval>;

  const fetchStatus = async () => {
    try {
      const s = await invoke<AgentStatus>("get_agent_status");
      setStatus(s);
    } catch (error) {
      frontendLog("warn", "status", "get_agent_status failed", error);
      // Keep last known status
    }
    try {
      const sc = await invoke<SidecarStatus>("get_sidecar_status");
      setSidecar(sc);
    } catch (error) {
      frontendLog("warn", "status", "get_sidecar_status failed", error);
      // Not critical
    }

    if (!initialSnapshotLogged && (status() || sidecar())) {
      frontendLog("info", "status", "Initial status snapshot loaded", {
        registered: status()?.registered ?? false,
        connected: status()?.connected ?? false,
        sidecarState: sidecar()?.state ?? "unknown",
        sidecarRunning: sidecar()?.running ?? false,
      });
      initialSnapshotLogged = true;
    }

    setLoading(false);
  };

  onMount(() => {
    frontendLog("debug", "status", "Status panel mounted");
    invoke<boolean>("is_os_admin")
      .then(setIsAdmin)
      .catch((error) => frontendLog("warn", "status", "is_os_admin failed", error));
    // The permanent unattended-access password is shown on the card whenever
    // the effective access policy is "unattended" (set in Settings) or the
    // deployment branding enables it. In supervised mode the operator must be
    // accepted via the consent dialog, so no password is displayed.
    invoke<{ access_mode?: string }>("get_agent_settings")
      .then((s) => {
        const mode = s?.access_mode ?? "";
        setAccessMode(mode);
        if (mode === "unattended" || getBranding().allow_unattended) {
          invoke<string>("get_unattended_password")
            .then(setUnattendedPassword)
            .catch((error) =>
              frontendLog("warn", "status", "get_unattended_password failed", error)
            );
        }
      })
      .catch((error) => frontendLog("warn", "status", "get_agent_settings failed", error));
    fetchStatus();
    pollInterval = setInterval(fetchStatus, 5000);
  });

  onCleanup(() => clearInterval(pollInterval));

  const copyId = async () => {
    const s = status();
    if (!s) return;
    try {
      await invoke("copy_to_clipboard", { text: s.device_id });
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch {}
  };

  const copyPassword = async () => {
    const pw = unattendedPassword();
    if (!pw) return;
    try {
      await invoke("copy_to_clipboard", { text: pw });
      setPwCopyFeedback(true);
      setTimeout(() => setPwCopyFeedback(false), 2000);
    } catch {}
  };

  // Footer affordances mirroring the Console generator preview: a settings gear
  // (navigates to the gated Settings panel) and a power button (asks the App
  // shell to show the quit / sudo dialog).
  const openSettings = () => {
    if (typeof window !== "undefined") window.location.hash = "/settings";
  };

  const requestQuit = () => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("agent:request-quit"));
    }
  };

  // Joins the branded support channels exactly like the generator preview
  // (email • phone • url, omitting any that are blank).
  const contactLine = (): string => {
    const b = getBranding();
    return [b.support_email, b.support_phone, b.contact_url]
      .filter((v) => !!v)
      .join(" • ");
  };

  // Navigates to the in-app help request form.
  const openHelp = () => {
    if (typeof window !== "undefined") window.location.hash = "/help";
  };

  // Opens the dedicated support chat in its own native window.
  const openChat = async () => {
    try {
      frontendLog("info", "status", "Opening support chat window");
      await invoke("open_chat_window");
    } catch (error) {
      frontendLog("error", "status", "open_chat_window failed", error);
    }
  };

  // Formats the device ID into spaced groups for readability. Numeric IDs are
  // grouped in threes (e.g. "123 456 789"); non-numeric IDs are returned as-is.
  const formatDeviceId = (id: string): string => {
    if (!id) return "—";
    if (/^\d+$/.test(id)) {
      return id.replace(/(\d{3})(?=\d)/g, "$1 ");
    }
    return id;
  };

  const reconnect = async () => {
    try {
      frontendLog("info", "status", "Manual reconnect requested");
      await invoke("reconnect_agent");
      await fetchStatus();
    } catch (error) {
      frontendLog("error", "status", "reconnect_agent failed", error);
    }
  };

  const startSidecar = async () => {
    setSidecarAction("busy");
    setSidecarError("");
    try {
      frontendLog("info", "status.sidecar", "Starting CDAP sidecar");
      await invoke("start_sidecar");
      setTimeout(fetchStatus, 1000);
    } catch (error) {
      frontendLog("error", "status.sidecar", "start_sidecar failed", error);
      setSidecarError(String(error));
    }
    setSidecarAction("");
  };

  const stopSidecar = async () => {
    setSidecarAction("busy");
    setSidecarError("");
    try {
      frontendLog("info", "status.sidecar", "Stopping CDAP sidecar");
      await invoke("stop_sidecar");
      setTimeout(fetchStatus, 500);
    } catch (error) {
      frontendLog("error", "status.sidecar", "stop_sidecar failed", error);
    }
    setSidecarAction("");
  };

  const restartSidecar = async () => {
    setSidecarAction("busy");
    setSidecarError("");
    try {
      frontendLog("info", "status.sidecar", "Restarting CDAP sidecar");
      await invoke("restart_sidecar");
      setTimeout(fetchStatus, 1000);
    } catch (error) {
      frontendLog("error", "status.sidecar", "restart_sidecar failed", error);
      setSidecarError(String(error));
    }
    setSidecarAction("");
  };

  const sendDiagnostics = async () => {
    try {
      frontendLog("info", "status", "Diagnostics upload requested");
      await invoke("send_diagnostics");
      setDiagFeedback("ok");
      setTimeout(() => setDiagFeedback(""), 3000);
    } catch (error) {
      frontendLog("error", "status", "send_diagnostics failed", error);
      setDiagFeedback("error");
      setTimeout(() => setDiagFeedback(""), 3000);
    }
  };

  const formatUptime = (secs: number): string => {
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${h}h ${m}m`;
  };

  return (
    <div class="page-content ap-page">
      {loading() ? (
        <div class="loading-state">
          <span class="material-symbols-rounded spin">sync</span>
          <span>{t("common.loading")}</span>
        </div>
      ) : (
        <>
          {/* ── Branded support card (matches Console generator preview) ── */}
          <div class="ap-card">
            <div class="ap-header">
              <div class="ap-logo">
                {getBranding().logo_data_url ? (
                  <img src={getBranding().logo_data_url} alt="" />
                ) : (
                  <span class="material-symbols-rounded">support_agent</span>
                )}
              </div>
              <div class="ap-brand">
                <div class="ap-brand-name">
                  {getBranding().company_name || getBranding().product_name || "BetterDesk"}
                </div>
                <div class="ap-brand-text">
                  {getBranding().tagline || getBranding().product_name || "BetterDesk Agent"}
                </div>
              </div>
            </div>

            <div class="ap-body">
              <div class="ap-status">
                <span class={`ap-status-dot ${status()?.connected ? "" : "offline"}`} />
                <span class="ap-status-text">
                  {status()?.connected
                    ? t("status.ready")
                    : status()?.registered
                    ? t("status.card_connecting")
                    : t("status.disconnected")}
                </span>
              </div>

              <div class="ap-id-row">
                <span class="ap-id-label">{t("status.your_id")}</span>
                <div class="ap-id-value-row">
                  <span class="ap-id-value">{formatDeviceId(status()?.device_id || "")}</span>
                  <button class="ap-copy-btn" onClick={copyId} title={t("status.copy_id")}>
                    <span class="material-symbols-rounded">
                      {copyFeedback() ? "check" : "content_copy"}
                    </span>
                  </button>
                </div>
                <Show when={copyFeedback()}>
                  <span class="ap-copied">{t("status.id_copied")}</span>
                </Show>
              </div>

              <Show when={(accessMode() === "unattended" || getBranding().allow_unattended) && unattendedPassword()}>
                <div class="ap-pw-row">
                  <span class="ap-id-label">{t("status.password")}</span>
                  <div class="ap-id-value-row">
                    <span class="ap-id-value ap-pw">{unattendedPassword()}</span>
                    <button
                      class="ap-copy-btn"
                      onClick={copyPassword}
                      title={t("status.copy_password")}
                    >
                      <span class="material-symbols-rounded">
                        {pwCopyFeedback() ? "check" : "content_copy"}
                      </span>
                    </button>
                  </div>
                  <Show when={pwCopyFeedback()}>
                    <span class="ap-copied">{t("status.password_copied")}</span>
                  </Show>
                </div>
              </Show>

              <button class="ap-help" onClick={openHelp}>
                <span class="material-symbols-rounded">contact_support</span>
                {t("status.request_help")}
              </button>

              <button class="ap-chat" onClick={openChat}>
                <span class="material-symbols-rounded">chat</span>
                {t("status.chat_with_support")}
              </button>

              <Show when={!status()?.connected}>
                <button class="ap-secondary" onClick={reconnect}>
                  <span class="material-symbols-rounded">refresh</span>
                  {t("status.reconnect")}
                </button>
              </Show>
            </div>

            <div class="ap-footer">
              <button
                class="ap-icon-btn"
                onClick={openSettings}
                title={t("status.settings_admin")}
              >
                <span class="material-symbols-rounded">settings</span>
              </button>
              <Show when={contactLine()} fallback={<div class="ap-contact" />}>
                <div class="ap-contact" title={contactLine()}>
                  {contactLine()}
                </div>
              </Show>
              <button
                class="ap-icon-btn"
                onClick={requestQuit}
                title={t("status.quit_admin")}
              >
                <span class="material-symbols-rounded">power_settings_new</span>
              </button>
            </div>
          </div>

          {/* ── Advanced / technical details (admin-only, collapsible) ── */}
          <Show when={isAdmin()}>
            <button
              class="ap-advanced-toggle"
              onClick={() => setShowAdvanced(!showAdvanced())}
            >
              <span class="material-symbols-rounded">
                {showAdvanced() ? "expand_less" : "expand_more"}
              </span>
              {t("status.advanced_details")}
            </button>
          </Show>

          <Show when={isAdmin() && showAdvanced()}>
            <div class="ap-advanced">
              <div class="info-grid">
                <div class="info-card">
                  <div class="info-label">{t("status.device_id")}</div>
                  <div class="info-value">
                    <code>{status()?.device_id || "—"}</code>
                  </div>
                </div>

                <div class="info-card">
                  <div class="info-label">{t("status.server")}</div>
                  <div class="info-value">{status()?.server_address || "—"}</div>
                </div>

                <div class="info-card">
                  <div class="info-label">{t("status.hostname")}</div>
                  <div class="info-value">{status()?.hostname || "—"}</div>
                </div>

                <div class="info-card">
                  <div class="info-label">{t("status.platform")}</div>
                  <div class="info-value">{status()?.platform || "—"}</div>
                </div>

                <div class="info-card">
                  <div class="info-label">{t("status.version")}</div>
                  <div class="info-value">{status()?.version || "—"}</div>
                </div>

                <div class="info-card">
                  <div class="info-label">{t("status.uptime")}</div>
                  <div class="info-value">
                    {status()?.uptime_secs ? formatUptime(status()!.uptime_secs) : "—"}
                  </div>
                </div>

                <div class="info-card">
                  <div class="info-label">{t("status.last_sync")}</div>
                  <div class="info-value">{status()?.last_sync || "—"}</div>
                </div>
              </div>

              {/* ── CDAP Sidecar Status ── */}
              <div class="section-header">
                <span class="material-symbols-rounded">settings_suggest</span>
                {t("status.sidecar_title")}
              </div>
              <div class="sidecar-card">
                <div class="sidecar-status-row">
                  <span class={`status-dot ${sidecar()?.running ? "dot-green" : "dot-red"}`} />
                  <span class="sidecar-state">
                    {sidecar()?.running
                      ? t("status.sidecar_running")
                      : sidecar()?.state === "not_configured"
                      ? t("status.sidecar_not_configured")
                      : t("status.sidecar_stopped")}
                  </span>
                  {sidecar()?.pid ? (
                    <span class="sidecar-pid">PID {sidecar()!.pid}</span>
                  ) : null}
                  {(sidecar()?.restart_count ?? 0) > 0 ? (
                    <span class="sidecar-restarts" title={t("status.sidecar_restarts_hint")}>
                      <span class="material-symbols-rounded" style="font-size:14px">refresh</span>
                      {sidecar()!.restart_count}
                    </span>
                  ) : null}
                </div>

                {sidecar()?.cdap_url && (
                  <div class="sidecar-detail">
                    <span class="material-symbols-rounded">hub</span>
                    <code>{sidecar()!.cdap_url}</code>
                  </div>
                )}

                {sidecar()?.binary_path && (
                  <div class="sidecar-detail sidecar-path">
                    <span class="material-symbols-rounded">terminal</span>
                    <span title={sidecar()!.binary_path}>
                      {sidecar()!.binary_path.split(/[/\\]/).pop()}
                    </span>
                  </div>
                )}

                <Show
                  when={isAdmin()}
                  fallback={<div class="sidecar-managed-hint">{t("status.sidecar_managed_hint")}</div>}
                >
                  <div class="sidecar-actions">
                    {!sidecar()?.running ? (
                      <button
                        class="btn btn-primary btn-sm"
                        onClick={startSidecar}
                        disabled={sidecarAction() === "busy"}
                      >
                        <span class="material-symbols-rounded">play_arrow</span>
                        {t("status.sidecar_start")}
                      </button>
                    ) : (
                      <>
                        <button
                          class="btn btn-secondary btn-sm"
                          onClick={restartSidecar}
                          disabled={sidecarAction() === "busy"}
                        >
                          <span class="material-symbols-rounded">refresh</span>
                          {t("status.sidecar_restart")}
                        </button>
                        <button
                          class="btn btn-danger btn-sm"
                          onClick={stopSidecar}
                          disabled={sidecarAction() === "busy"}
                        >
                          <span class="material-symbols-rounded">stop</span>
                          {t("status.sidecar_stop")}
                        </button>
                      </>
                    )}
                  </div>
                </Show>

                <Show when={sidecarError()}>
                  <div class="form-error">{sidecarError()}</div>
                </Show>
              </div>

              <button class="ap-secondary ap-diag" onClick={sendDiagnostics}>
                <span class="material-symbols-rounded">
                  {diagFeedback() === "ok"
                    ? "check"
                    : diagFeedback() === "error"
                    ? "error"
                    : "bug_report"}
                </span>
                {diagFeedback() === "ok"
                  ? t("status.diagnostics_sent")
                  : diagFeedback() === "error"
                  ? t("status.diagnostics_error")
                  : t("status.send_diagnostics")}
              </button>
            </div>
          </Show>
        </>
      )}
    </div>
  );
};

export default StatusPanel;
