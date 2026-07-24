import { Component, createSignal, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t, setLocale, getLocale, getAvailableLocales, getLocaleDisplayName } from "../lib/i18n";
import SudoAuthDialog from "./SudoAuthDialog";

interface AgentSettings {
  server_address: string;
  api_key: string;
  cdap_port: number;
  allow_screen_capture: boolean;
  require_consent: boolean;
  /** "supervised" | "unattended" | "disabled" — authoritative source for the
   *  remote-desktop access policy. `require_consent` is kept in sync by the
   *  Rust backend for legacy code paths. */
  access_mode: "supervised" | "unattended" | "disabled";
  allow_terminal: boolean;
  allow_file_browser: boolean;
  allow_clipboard: boolean;
  auto_start_sidecar: boolean;
  /** "auto" | "mjpeg" | "webp" | "h264" | "vp9" | "av1" */
  video_codec: string;
  /** "auto" | "none" | "vaapi" | "nvenc" | "qsv" | "amf" | "videotoolbox" */
  hw_accel: string;
  autostart: boolean;       // matches Rust AgentSettings.autostart
  start_minimized: boolean;
  language: string;
}

interface SettingsPanelProps {
  /** Whether the current OS user has administrator / root privileges. */
  isAdmin: boolean;
}

const SettingsPanel: Component<SettingsPanelProps> = (props) => {
  const hasSessionAuth = () => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.sessionStorage.getItem("betterdesk-agent-settings-auth") === "1";
  };

  // Non-admin users must authenticate via sudo before accessing settings.
  const [authed, setAuthed] = createSignal(props.isAdmin || hasSessionAuth());
  const [settings, setSettings] = createSignal<AgentSettings>({
    server_address: "",
    api_key: "",
    cdap_port: 21122,
    allow_screen_capture: true,
    require_consent: true,
    access_mode: "supervised",
    allow_terminal: true,
    allow_file_browser: true,
    allow_clipboard: true,
    auto_start_sidecar: true,
    video_codec: "auto",
    hw_accel: "auto",
    autostart: true,
    start_minimized: true,
    language: "en",
  });
  const [testResult, setTestResult] = createSignal<"ok" | "fail" | null>(null);
  const [version, setVersion] = createSignal("1.0.0");
  // Permanent unattended-access password management.
  const [permanentPassword, setPermanentPassword] = createSignal("");
  const [pwInput, setPwInput] = createSignal("");
  const [pwShown, setPwShown] = createSignal(false);
  const [pwCopied, setPwCopied] = createSignal(false);
  const [pwFeedback, setPwFeedback] = createSignal<"" | "saved" | string>("");

  const loadPermanentPassword = async () => {
    try {
      const pw = await invoke<string>("get_unattended_password");
      setPermanentPassword(pw);
    } catch {}
  };

  const copyPermanentPassword = async () => {
    try {
      await invoke("copy_to_clipboard", { text: permanentPassword() });
      setPwCopied(true);
      setTimeout(() => setPwCopied(false), 1500);
    } catch {}
  };

  const regeneratePassword = async () => {
    try {
      const pw = await invoke<string>("regenerate_unattended_password");
      setPermanentPassword(pw);
      setPwFeedback("saved");
      setTimeout(() => setPwFeedback(""), 2000);
    } catch {}
  };

  const saveCustomPassword = async () => {
    const value = pwInput().trim();
    if (value.length < 6) {
      setPwFeedback(t("settings.password_too_short"));
      return;
    }
    try {
      await invoke("set_unattended_password", { password: value });
      setPermanentPassword(value);
      setPwInput("");
      setPwFeedback("saved");
      setTimeout(() => setPwFeedback(""), 2000);
    } catch (e) {
      setPwFeedback(typeof e === "string" ? e : t("settings.password_save_failed"));
    }
  };

  onMount(async () => {
    try {
      const s = await invoke<AgentSettings>("get_agent_settings");
      setSettings(s);
      if (s.access_mode === "unattended") {
        await loadPermanentPassword();
      }
    } catch {}
    try {
      const v = await invoke<string>("get_agent_version");
      setVersion(v);
    } catch {}
  });

  const updateSetting = async <K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) => {
    const updated = { ...settings(), [key]: value };
    setSettings(updated);
    try {
      await invoke("save_agent_settings", { settings: updated });
    } catch {}

    if (key === "access_mode" && value === "unattended") {
      await loadPermanentPassword();
    }

    if (key === "language" && typeof value === "string") {
      setLocale(value);
    }
  };

  const testConnection = async () => {
    setTestResult(null);
    try {
      await invoke("test_server_connection", { address: settings().server_address });
      setTestResult("ok");
    } catch {
      setTestResult("fail");
    }
    setTimeout(() => setTestResult(null), 3000);
  };

  const restartService = async () => {
    try {
      await invoke("restart_agent_service");
    } catch {}
  };

  const unregister = async () => {
    const confirmed = confirm(t("settings.unregister_confirm"));
    if (!confirmed) return;
    try {
      await invoke("unregister_device");
      window.location.reload();
    } catch {}
  };

  // Navigate back to the status panel (used by cancel button in auth dialog).
  const goBack = () => {
    if (typeof window !== "undefined") {
      window.location.hash = "/";
    }
  };

  return (
    <Show
      when={authed()}
      fallback={
        <SudoAuthDialog
          subtitle={t("auth.settings_subtitle")}
          onCancel={goBack}
          onSuccess={() => {
            if (typeof window !== "undefined") {
              window.sessionStorage.setItem("betterdesk-agent-settings-auth", "1");
            }
            setAuthed(true);
          }}
        />
      }
    >
    <div class="page-content">
      <div class="page-header">
        <button class="page-back-btn" onClick={goBack} title={t("common.back")}>
          <span class="material-symbols-rounded">arrow_back</span>
        </button>
        <h2 class="page-title">{t("settings.title")}</h2>
      </div>

      {/* Connection */}
      <section class="settings-section">
        <h3 class="settings-section-title">{t("settings.section_connection")}</h3>
        <div class="settings-row">
          <label class="form-label">{t("settings.server_address")}</label>
          <div class="settings-input-row">
            <input
              type="text"
              class="form-input"
              value={settings().server_address}
              onInput={(e) => updateSetting("server_address", e.currentTarget.value)}
            />
            <button class="btn btn-secondary btn-sm" onClick={testConnection}>
              {t("settings.test_connection")}
            </button>
          </div>
          <Show when={testResult() === "ok"}>
            <div class="form-success">{t("settings.connection_ok")}</div>
          </Show>
          <Show when={testResult() === "fail"}>
            <div class="form-error">{t("settings.connection_failed")}</div>
          </Show>
        </div>
      </section>

      {/* CDAP Agent */}
      <section class="settings-section">
        <h3 class="settings-section-title">{t("settings.section_cdap")}</h3>

        <div class="settings-row">
          <label class="form-label">{t("settings.api_key")}</label>
          <input
            type="password"
            class="form-input"
            value={settings().api_key}
            placeholder={t("settings.api_key_placeholder")}
            onInput={(e) => updateSetting("api_key", e.currentTarget.value)}
          />
          <div class="form-hint">{t("settings.api_key_hint")}</div>
        </div>

        <div class="settings-row">
          <label class="form-label">{t("settings.cdap_port")}</label>
          <input
            type="number"
            class="form-input form-input-sm"
            min={1024}
            max={65535}
            value={settings().cdap_port}
            onInput={(e) => updateSetting("cdap_port", parseInt(e.currentTarget.value, 10) || 21122)}
          />
        </div>

        <div class="settings-toggle-row">
          <div>
            <div class="settings-toggle-label">{t("settings.auto_start_sidecar")}</div>
            <div class="settings-toggle-hint">{t("settings.auto_start_sidecar_hint")}</div>
          </div>
          <label class="toggle-switch">
            <input
              type="checkbox"
              checked={settings().auto_start_sidecar}
              onChange={(e) => updateSetting("auto_start_sidecar", e.currentTarget.checked)}
            />
            <span class="toggle-slider" />
          </label>
        </div>
      </section>

      {/* Privacy / Capabilities */}
      <section class="settings-section">
        <h3 class="settings-section-title">{t("settings.section_privacy")}</h3>

        <div class="settings-toggle-row">
          <div>
            <div class="settings-toggle-label">{t("settings.allow_screen_capture")}</div>
            <div class="settings-toggle-hint">{t("settings.allow_screen_capture_hint")}</div>
          </div>
          <label class="toggle-switch">
            <input
              type="checkbox"
              checked={settings().allow_screen_capture}
              onChange={(e) => updateSetting("allow_screen_capture", e.currentTarget.checked)}
            />
            <span class="toggle-slider" />
          </label>
        </div>

        <Show when={settings().allow_screen_capture}>
          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-label">{t("settings.video_codec")}</div>
              <div class="settings-toggle-hint">{t("settings.video_codec_hint")}</div>
            </div>
            <select
              class="settings-select"
              value={settings().video_codec}
              onChange={(e) => updateSetting("video_codec", e.currentTarget.value)}
            >
              <option value="auto">{t("settings.video_codec_auto")}</option>
              <option value="webp">WebP</option>
              <option value="h264">H.264</option>
              <option value="vp9">VP9</option>
              <option value="av1">AV1</option>
              <option value="mjpeg">MJPEG</option>
            </select>
          </div>

          <div class="settings-toggle-row">
            <div>
              <div class="settings-toggle-label">{t("settings.hw_accel")}</div>
              <div class="settings-toggle-hint">{t("settings.hw_accel_hint")}</div>
            </div>
            <select
              class="settings-select"
              value={settings().hw_accel}
              onChange={(e) => updateSetting("hw_accel", e.currentTarget.value)}
            >
              <option value="auto">{t("settings.hw_accel_auto")}</option>
              <option value="none">{t("settings.hw_accel_none")}</option>
              <option value="vaapi">VA-API</option>
              <option value="nvenc">NVENC</option>
              <option value="qsv">Intel QSV</option>
              <option value="amf">AMD AMF</option>
              <option value="videotoolbox">VideoToolbox</option>
            </select>
          </div>
        </Show>

        <div class="settings-toggle-row">
          <div>
            <div class="settings-toggle-label">{t("access_mode.label")}</div>
            <div class="settings-toggle-hint">{t("access_mode.description")}</div>
          </div>
        </div>
        <div class="settings-access-mode">
          {(["supervised", "unattended", "disabled"] as const).map((mode) => (
            <label class="settings-access-mode-option">
              <input
                type="radio"
                name="access_mode"
                value={mode}
                checked={settings().access_mode === mode}
                onChange={() => {
                  updateSetting("access_mode", mode);
                  updateSetting("require_consent", mode === "supervised");
                }}
              />
              <div class="settings-access-mode-text">
                <div class="settings-access-mode-title">
                  {t(`access_mode.${mode}`)}
                </div>
                <div class="settings-access-mode-desc">
                  {t(`access_mode.${mode}_desc`)}
                </div>
              </div>
            </label>
          ))}
        </div>

        <Show when={settings().access_mode === "unattended"}>
          <div class="settings-pw-block">
            <div class="settings-toggle-label">{t("settings.permanent_password")}</div>
            <div class="settings-toggle-hint">{t("settings.permanent_password_hint")}</div>
            <div class="settings-pw-current">
              <span class="settings-pw-value">
                {pwShown() ? permanentPassword() || "—" : "••••••••"}
              </span>
              <button
                class="settings-pw-icon-btn"
                title={pwShown() ? t("settings.password_hide") : t("settings.password_show")}
                onClick={() => setPwShown(!pwShown())}
              >
                <span class="material-symbols-rounded">
                  {pwShown() ? "visibility_off" : "visibility"}
                </span>
              </button>
              <button
                class="settings-pw-icon-btn"
                title={t("settings.copy_password")}
                onClick={copyPermanentPassword}
              >
                <span class="material-symbols-rounded">
                  {pwCopied() ? "check" : "content_copy"}
                </span>
              </button>
              <button class="settings-pw-regen-btn" onClick={regeneratePassword}>
                {t("settings.regenerate_password")}
              </button>
            </div>
            <div class="settings-pw-set">
              <input
                type="text"
                class="form-input"
                placeholder={t("settings.custom_password_placeholder")}
                value={pwInput()}
                onInput={(e) => setPwInput(e.currentTarget.value)}
              />
              <button class="settings-pw-save-btn" onClick={saveCustomPassword}>
                {t("settings.save_password")}
              </button>
            </div>
            <Show when={pwFeedback()}>
              <div class="settings-pw-feedback">
                {pwFeedback() === "saved" ? t("settings.password_saved") : pwFeedback()}
              </div>
            </Show>
          </div>
        </Show>

        <div class="settings-toggle-row">
          <div>
            <div class="settings-toggle-label">{t("settings.allow_terminal")}</div>
            <div class="settings-toggle-hint">{t("settings.allow_terminal_hint")}</div>
          </div>
          <label class="toggle-switch">
            <input
              type="checkbox"
              checked={settings().allow_terminal}
              onChange={(e) => updateSetting("allow_terminal", e.currentTarget.checked)}
            />
            <span class="toggle-slider" />
          </label>
        </div>

        <div class="settings-toggle-row">
          <div>
            <div class="settings-toggle-label">{t("settings.allow_file_browser")}</div>
            <div class="settings-toggle-hint">{t("settings.allow_file_browser_hint")}</div>
          </div>
          <label class="toggle-switch">
            <input
              type="checkbox"
              checked={settings().allow_file_browser}
              onChange={(e) => updateSetting("allow_file_browser", e.currentTarget.checked)}
            />
            <span class="toggle-slider" />
          </label>
        </div>

        <div class="settings-toggle-row">
          <div>
            <div class="settings-toggle-label">{t("settings.allow_clipboard")}</div>
            <div class="settings-toggle-hint">{t("settings.allow_clipboard_hint")}</div>
          </div>
          <label class="toggle-switch">
            <input
              type="checkbox"
              checked={settings().allow_clipboard}
              onChange={(e) => updateSetting("allow_clipboard", e.currentTarget.checked)}
            />
            <span class="toggle-slider" />
          </label>
        </div>
      </section>

      {/* General */}
      <section class="settings-section">
        <h3 class="settings-section-title">{t("settings.section_general")}</h3>

        <div class="settings-row">
          <label class="form-label">{t("settings.language")}</label>
          <select
            class="form-input form-select"
            value={getLocale()}
            onChange={(e) => updateSetting("language", e.currentTarget.value)}
          >
            {getAvailableLocales().map((loc) => (
              <option value={loc}>{getLocaleDisplayName(loc)}</option>
            ))}
          </select>
        </div>

        <div class="settings-toggle-row">
          <div>
            <div class="settings-toggle-label">{t("settings.start_with_system")}</div>
          </div>
          <label class="toggle-switch">
            <input
              type="checkbox"
              checked={settings().autostart}
              onChange={(e) => updateSetting("autostart", e.currentTarget.checked)}
            />
            <span class="toggle-slider" />
          </label>
        </div>

        <div class="settings-toggle-row">
          <div>
            <div class="settings-toggle-label">{t("settings.start_minimized")}</div>
          </div>
          <label class="toggle-switch">
            <input
              type="checkbox"
              checked={settings().start_minimized}
              onChange={(e) => updateSetting("start_minimized", e.currentTarget.checked)}
            />
            <span class="toggle-slider" />
          </label>
        </div>
      </section>

      {/* About */}
      <section class="settings-section">
        <h3 class="settings-section-title">{t("settings.section_about")}</h3>
        <div class="settings-row">
          <span class="settings-about-label">{t("settings.app_version")}</span>
          <span class="settings-about-value">{version()}</span>
        </div>
        <div class="settings-actions">
          <button class="btn btn-secondary" onClick={restartService}>
            <span class="material-symbols-rounded">restart_alt</span>
            {t("settings.restart_service")}
          </button>
          <button class="btn btn-danger" onClick={unregister}>
            <span class="material-symbols-rounded">link_off</span>
            {t("settings.unregister")}
          </button>
        </div>
      </section>
    </div>
    </Show>
  );
};

export default SettingsPanel;
