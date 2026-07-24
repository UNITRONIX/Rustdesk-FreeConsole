import { Component, createSignal, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n";

interface SudoAuthDialogProps {
  /** Called when the user successfully authenticates (or is already root). */
  onSuccess: () => void;
  /** Called when the user dismisses the dialog without authenticating. */
  onCancel?: () => void;
  /** Optional title override. Defaults to `auth.title`. */
  title?: string;
  /** Optional subtitle override. Defaults to `auth.subtitle`. */
  subtitle?: string;
}

const SudoAuthDialog: Component<SudoAuthDialogProps> = (props) => {
  const [password, setPassword] = createSignal("");
  const [verifying, setVerifying] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  let inputRef: HTMLInputElement | undefined;

  onMount(() => {
    // Focus password field immediately so the user can start typing.
    setTimeout(() => inputRef?.focus(), 50);
  });

  const submit = async () => {
    const pw = password();
    if (!pw) {
      setError(t("auth.enter_password_error"));
      return;
    }

    setVerifying(true);
    setError(null);

    try {
      const ok = await invoke<boolean>("authenticate_sudo", { password: pw });
      if (ok) {
        props.onSuccess();
      } else {
        setError(t("auth.wrong_password"));
        setPassword("");
        setTimeout(() => inputRef?.focus(), 50);
      }
    } catch (e) {
      setError(t("auth.sudo_error"));
    } finally {
      setVerifying(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") submit();
    if (e.key === "Escape") props.onCancel?.();
  };

  return (
    <div class="sudo-auth-overlay">
      <div class="sudo-auth-dialog">
        <div class="sudo-auth-icon">
          <span class="material-symbols-rounded">lock</span>
        </div>

        <h2 class="sudo-auth-title">
          {props.title ?? t("auth.title")}
        </h2>
        <p class="sudo-auth-subtitle">
          {props.subtitle ?? t("auth.subtitle")}
        </p>

        <div class="sudo-auth-field">
          <label class="sudo-auth-label">{t("auth.password")}</label>
          <input
            ref={inputRef}
            type="password"
            class={`sudo-auth-input ${error() ? "sudo-auth-input-error" : ""}`}
            placeholder={t("auth.password_placeholder")}
            value={password()}
            onInput={(e) => { setPassword(e.currentTarget.value); setError(null); }}
            onKeyDown={onKeyDown}
            disabled={verifying()}
            autocomplete="current-password"
          />
          {error() && (
            <p class="sudo-auth-error">
              <span class="material-symbols-rounded">error</span>
              {error()}
            </p>
          )}
        </div>

        <div class="sudo-auth-actions">
          {props.onCancel && (
            <button
              class="sudo-auth-btn sudo-auth-btn-cancel"
              onClick={props.onCancel}
              disabled={verifying()}
            >
              {t("auth.cancel")}
            </button>
          )}
          <button
            class="sudo-auth-btn sudo-auth-btn-submit"
            onClick={submit}
            disabled={verifying()}
          >
            {verifying() ? (
              <>
                <span class="material-symbols-rounded spin" style="font-size:1rem">sync</span>
                {t("auth.verifying")}
              </>
            ) : (
              t("auth.submit")
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SudoAuthDialog;
