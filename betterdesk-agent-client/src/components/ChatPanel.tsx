import { Component, createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { t } from "../lib/i18n";

interface ChatMessage {
  id: string;
  from: "operator" | "user";
  text: string;
  timestamp: string;
}

const ChatPanel: Component = () => {
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [input, setInput] = createSignal("");
  const [connected, setConnected] = createSignal(false);
  let messagesEnd: HTMLDivElement | undefined;
  let unlisten: UnlistenFn;

  const scrollToBottom = () => {
    messagesEnd?.scrollIntoView({ behavior: "smooth" });
  };

  onMount(async () => {
    try {
      const status = await invoke<{ connected: boolean }>("get_agent_status");
      setConnected(status.connected);
      if (status.connected) {
        const history = await invoke<ChatMessage[]>("get_chat_history");
        setMessages(history);
        setTimeout(scrollToBottom, 100);
      }
    } catch {}

    unlisten = await listen<ChatMessage>("chat-message-received", (event) => {
      setMessages((prev) => [...prev, event.payload]);
      setTimeout(scrollToBottom, 50);
    });
  });

  onCleanup(() => {
    unlisten?.();
  });

  const sendMessage = async () => {
    const text = input().trim();
    if (!text) return;

    try {
      await invoke("send_chat_message", { message: text });
      const msg: ChatMessage = {
        id: crypto.randomUUID(),
        from: "user",
        text,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, msg]);
      setInput("");
      setTimeout(scrollToBottom, 50);
    } catch {}
  };

  const formatTime = (iso: string): string => {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  };

  return (
    <div class="page-content chat-page">
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
        <h2 class="page-title">{t("chat.title")}</h2>
      </div>

      <Show when={connected()} fallback={
        <div class="empty-state">
          <span class="material-symbols-rounded">cloud_off</span>
          <p>{t("chat.connection_required")}</p>
        </div>
      }>
        <div class="chat-container">
          <div class="chat-messages">
            <Show when={messages().length === 0}>
              <div class="chat-empty">
                <span class="material-symbols-rounded">forum</span>
                <p>{t("chat.no_messages")}</p>
              </div>
            </Show>
            <For each={messages()}>
              {(msg) => (
                <div class={`chat-bubble ${msg.from}`}>
                  <div class="chat-bubble-header">
                    <span class="chat-sender">
                      {msg.from === "operator" ? t("chat.operator") : t("chat.you")}
                    </span>
                    <span class="chat-time">{formatTime(msg.timestamp)}</span>
                  </div>
                  <div class="chat-bubble-text">{msg.text}</div>
                </div>
              )}
            </For>
            <div ref={messagesEnd} />
          </div>

          <div class="chat-input-bar">
            <input
              type="text"
              class="form-input chat-input"
              placeholder={t("chat.placeholder")}
              value={input()}
              onInput={(e) => setInput(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            />
            <button class="btn btn-primary icon-only" onClick={sendMessage} title={t("chat.send")}>
              <span class="material-symbols-rounded">send</span>
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default ChatPanel;
