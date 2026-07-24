import { Component, createSignal, onMount, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { t } from "../lib/i18n";

interface ConsentRequest {
  session_id: string;
  operator: string;
}

/**
 * ConsentDialog — floating modal shown when the Go agent (require_consent=true)
 * emits a "consent-request" event via stdout → Tauri → frontend.
 *
 * The user has 30 seconds to Allow or Deny. Auto-deny fires on timeout.
 * The component is always mounted in App.tsx (floating layer), invisible
 * until a request arrives.
 */
const ConsentDialog: Component = () => {
  const [request, setRequest] = createSignal<ConsentRequest | null>(null);
  const [timeLeft, setTimeLeft] = createSignal(30);
  let unlisten: UnlistenFn | undefined;
  let timerInterval: number | undefined;

  const clearTimer = () => {
    if (timerInterval !== undefined) {
      clearInterval(timerInterval);
      timerInterval = undefined;
    }
  };

  const dismiss = () => {
    clearTimer();
    setRequest(null);
    setTimeLeft(30);
  };

  const answer = async (granted: boolean) => {
    const req = request();
    if (!req) return;
    try {
      await invoke("answer_consent", { sessionId: req.session_id, granted });
    } catch (e) {
      console.error("[consent] answer_consent error:", e);
    }
    dismiss();
  };

  const startTimer = () => {
    clearTimer();
    setTimeLeft(30);
    timerInterval = window.setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          // Auto-deny on timeout.
          answer(false);
          return 0;
        }
        return t - 1;
      });
    }, 1000);
  };

  onMount(async () => {
    unlisten = await listen<string>("consent-request", (event) => {
      try {
        const data: ConsentRequest = JSON.parse(event.payload);
        setRequest(data);
        startTimer();
      } catch {
        console.error("[consent] Invalid consent-request payload:", event.payload);
      }
    });
  });

  onCleanup(() => {
    clearTimer();
    unlisten?.();
  });

  return (
    <Show when={request() !== null}>
      <div class="consent-overlay">
        <div class="consent-dialog">
          <div class="consent-icon">
            <span class="material-symbols-rounded">screen_share</span>
          </div>

          <h2 class="consent-title">{t("consent.title")}</h2>

          <p class="consent-operator">
            <strong>{request()!.operator}</strong>{" "}
            {t("consent.operator_suffix")}
          </p>

          <p class="consent-hint">{t("consent.hint")}</p>

          <div class="consent-timer-bar">
            <div
              class="consent-timer-fill"
              style={{ width: `${(timeLeft() / 30) * 100}%` }}
            />
          </div>
          <p class="consent-timer-label">
            {t("consent.auto_deny_in")} {timeLeft()}s
          </p>

          <div class="consent-actions">
            <button
              class="btn btn-danger"
              onClick={() => answer(false)}
            >
              <span class="material-symbols-rounded">block</span>
              {t("consent.deny")}
            </button>
            <button
              class="btn btn-success"
              onClick={() => answer(true)}
            >
              <span class="material-symbols-rounded">check_circle</span>
              {t("consent.allow")}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default ConsentDialog;
