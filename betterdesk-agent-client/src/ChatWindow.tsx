import { Component, onMount } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ChatPanel from "./components/ChatPanel";
import { initI18n, t } from "./lib/i18n";
import { loadBranding, getBranding } from "./lib/branding";
import { frontendLog } from "./lib/logger";

// Standalone chat window.
//
// Rendered when the frontend is loaded with the `?win=chat` flag (the dedicated
// chat window spawned by the `open_chat_window` IPC command). It deliberately
// skips the registration/boot shell and bottom navigation so the user gets a
// focused support conversation in its own native window.
const ChatWindow: Component = () => {
  onMount(() => {
    // initI18n is synchronous (bundled translations); branding is best-effort.
    initI18n();
    void loadBranding().catch((error) =>
      frontendLog("warn", "chat-window", "loadBranding failed", error),
    );
    frontendLog("info", "chat-window", "Chat window mounted");
  });

  const closeWindow = () => {
    void getCurrentWindow()
      .close()
      .catch((error) => frontendLog("warn", "chat-window", "close failed", error));
  };

  return (
    <div class="chat-window">
      <header class="chat-window-header">
        <span class="material-symbols-rounded chat-window-icon">support_agent</span>
        <div class="chat-window-titles">
          <span class="chat-window-title">{t("chat.window_title")}</span>
          <span class="chat-window-subtitle">
            {getBranding().company_name || "BetterDesk"}
          </span>
        </div>
        <button class="chat-window-close" type="button" title={t("chat.close")} onClick={closeWindow}>
          <span class="material-symbols-rounded">close</span>
        </button>
      </header>
      <div class="chat-window-body">
        <ChatPanel />
      </div>
    </div>
  );
};

export default ChatWindow;
