import { Component, createSignal, Show, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useNavigate } from "@solidjs/router";
import { t } from "../lib/i18n";

type HelpState = "idle" | "sending" | "sent" | "active";

const HelpRequest: Component = () => {
  const navigate = useNavigate();
  const [state, setState] = createSignal<HelpState>("idle");
  const [message, setMessage] = createSignal("");
  const [error, setError] = createSignal("");

  let unlisten: UnlistenFn | undefined;

  onMount(async () => {
    unlisten = await listen("help-session-active", () => {
      setState("active");
    });
  });

  onCleanup(() => {
    unlisten?.();
  });

  const sendRequest = async () => {
    setState("sending");
    setError("");
    try {
      await invoke("request_help", { description: message().trim() });
      setState("sent");
      setMessage("");
    } catch (e) {
      setError(String(e));
      setState("idle");
    }
  };

  const cancelRequest = async () => {
    try {
      await invoke("cancel_help_request");
      setState("idle");
    } catch {}
  };

  return (
    <div class="page-content">
      <div class="page-header">
        <button
          class="page-back-btn"
          onClick={() => {
            if (typeof window !== "undefined") window.location.hash = "/";
          }}
          title={t("common.back")}
        >
          <span class="material-symbols-rounded">arrow_back</span>
        </button>
        <h2 class="page-title">{t("help.title")}</h2>
      </div>

      {/* Idle — show form */}
      <Show when={state() === "idle"}>
        <div class="help-section">
          <p class="help-description">{t("help.description")}</p>

          <label class="form-label">{t("help.message_label")}</label>
          <textarea
            class="form-input form-textarea"
            placeholder={t("help.message_placeholder")}
            rows={4}
            value={message()}
            onInput={(e) => setMessage(e.currentTarget.value)}
          />

          <Show when={error()}>
            <div class="form-error">{error()}</div>
          </Show>

          <button class="btn btn-primary" onClick={sendRequest}>
            <span class="material-symbols-rounded">support_agent</span>
            {t("help.send")}
          </button>
        </div>
      </Show>

      {/* Sending */}
      <Show when={state() === "sending"}>
        <div class="help-status">
          <span class="material-symbols-rounded spin">sync</span>
          <p>{t("help.sending")}</p>
        </div>
      </Show>

      {/* Sent — waiting for operator */}
      <Show when={state() === "sent"}>
        <div class="help-status sent">
          <span class="material-symbols-rounded">notifications_active</span>
          <h3>{t("help.sent_title")}</h3>
          <p>{t("help.sent_message")}</p>
          <button class="btn btn-secondary" onClick={cancelRequest}>
            <span class="material-symbols-rounded">close</span>
            {t("help.cancel")}
          </button>
        </div>
      </Show>

      {/* Active session */}
      <Show when={state() === "active"}>
        <div class="help-status active">
          <span class="material-symbols-rounded">person</span>
          <h3>{t("help.active_title")}</h3>
          <p>{t("help.active_message")}</p>
          <div class="status-actions">
            <button class="btn btn-primary" onClick={() => navigate("/chat")}>
              <span class="material-symbols-rounded">chat</span>
              {t("sidebar.chat")}
            </button>
            <button class="btn btn-danger" onClick={() => { cancelRequest(); setState("idle"); }}>
              <span class="material-symbols-rounded">call_end</span>
              {t("help.end_session")}
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default HelpRequest;
