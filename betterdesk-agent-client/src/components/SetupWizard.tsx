import { Component, createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../lib/i18n";
import { frontendLog } from "../lib/logger";

interface ValidationStep {
  key: string;
  label: string;
  status: "pending" | "running" | "ok" | "error";
  error?: string;
}

interface DiscoveredLanServer {
  name: string;
  version: string;
  address: string;
  port: number;
  api_port: number;
  protocol: string;
  console_url: string;
}

/** Returned by register_device and poll_enrollment_status Tauri commands. */
interface RegisterResult {
  status: "approved" | "pending" | "rejected";
  device_id: string;
  message: string;
}

interface SetupProps {
  onComplete: () => void;
}

const SetupWizard: Component<SetupProps> = (props) => {
  const [step, setStep] = createSignal(0); // 0=address, 1=validate, 2=register, 3=sync, 4=complete
  const [address, setAddress] = createSignal("");
  const [addressError, setAddressError] = createSignal("");
  const [validationSteps, setValidationSteps] = createSignal<ValidationStep[]>([]);
  const [registering, setRegistering] = createSignal(false);
  const [registerError, setRegisterError] = createSignal("");
  const [syncing, setSyncing] = createSignal(false);
  const [syncError, setSyncError] = createSignal("");
  const [discovering, setDiscovering] = createSignal(false);
  const [discoveryError, setDiscoveryError] = createSignal("");
  const [discoveredServers, setDiscoveredServers] = createSignal<DiscoveredLanServer[]>([]);

  // Pending-approval sub-state (step 2 while awaiting operator action).
  const [pendingDeviceId, setPendingDeviceId] = createSignal("");
  const [approvalPolling, setApprovalPolling] = createSignal(false);
  let pollingInterval: ReturnType<typeof setInterval> | undefined;

  // Clean up polling timer when the component unmounts.
  onCleanup(() => {
    if (pollingInterval !== undefined) clearInterval(pollingInterval);
  });

  onMount(() => {
    frontendLog("info", "setup", "Setup wizard mounted");
    void discoverServers();
  });

  const validateAddress = (): boolean => {
    let addr = address().trim();
    if (!addr) {
      setAddressError(t("setup.error_empty"));
      return false;
    }
    // Remove trailing slash.
    addr = addr.replace(/\/+$/, "");
    setAddress(addr);

    // Basic format check: optional scheme + hostname/IP + optional port.
    const pattern = /^(https?:\/\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*(?::\d{1,5})?$/;
    if (!pattern.test(addr)) {
      setAddressError(t("setup.error_format"));
      return false;
    }
    setAddressError("");
    return true;
  };

  const discoverServers = async () => {
    setDiscovering(true);
    setDiscoveryError("");
    try {
      const servers = await invoke<DiscoveredLanServer[]>("discover_lan_servers");
      setDiscoveredServers(servers);
      if (!address() && servers.length === 1) {
        setAddress(servers[0].console_url);
      }
    } catch (error) {
      frontendLog("warn", "setup.discovery", "LAN discovery failed", error);
      setDiscoveryError(String(error));
    }
    setDiscovering(false);
  };

  const startValidation = async () => {
    if (!validateAddress()) return;

    setStep(1);
    const steps: ValidationStep[] = [
      { key: "availability", label: t("setup.checking_availability"), status: "pending" },
      { key: "protocol", label: t("setup.checking_protocol"), status: "pending" },
      { key: "registration", label: t("setup.checking_registration"), status: "pending" },
      { key: "certificate", label: t("setup.checking_certificate"), status: "pending" },
    ];
    setValidationSteps([...steps]);

    for (let i = 0; i < steps.length; i++) {
      steps[i].status = "running";
      setValidationSteps([...steps]);

      try {
        await invoke("validate_server_step", {
          address: address().trim(),
          stepKey: steps[i].key,
        });
        steps[i].status = "ok";
      } catch (e) {
        steps[i].status = "error";
        steps[i].error = String(e);
        setValidationSteps([...steps]);
        return; // Stop on first failure
      }
      setValidationSteps([...steps]);
    }

    // Auto-proceed to registration after brief pause
    setTimeout(() => setStep(2), 800);
  };

  const startRegistration = async () => {
    setRegistering(true);
    setRegisterError("");
    try {
      const result = await invoke<RegisterResult>("register_device", { address: address().trim() });

      if (result.status === "approved") {
        // Immediately proceed to config sync.
        setStep(3);
        await startSync();
      } else if (result.status === "pending") {
        // Server is in managed-enrollment mode — wait for operator approval.
        setPendingDeviceId(result.device_id);
        setApprovalPolling(true);

        pollingInterval = setInterval(async () => {
          try {
            const poll = await invoke<RegisterResult>("poll_enrollment_status", {
              address: address().trim(),
              deviceId: result.device_id,
            });

            if (poll.status === "approved") {
              clearInterval(pollingInterval);
              pollingInterval = undefined;
              setApprovalPolling(false);
              setPendingDeviceId("");
              setRegistering(false);
              setStep(3);
              await startSync();
            } else if (poll.status === "rejected") {
              clearInterval(pollingInterval);
              pollingInterval = undefined;
              setApprovalPolling(false);
              setPendingDeviceId("");
              setRegistering(false);
              setRegisterError(
                `${t("setup.approval_rejected")}${poll.message ? ": " + poll.message : ""}`
              );
            }
            // "pending" → keep polling
          } catch {
            // Network glitch — keep polling silently
          }
        }, 5000);

        // Registering stays true (spinner) while polling; fallback handled above.
        return;
      }
    } catch (e) {
      setRegisterError(String(e));
    }
    setRegistering(false);
  };

  const cancelPendingRegistration = () => {
    if (pollingInterval !== undefined) {
      clearInterval(pollingInterval);
      pollingInterval = undefined;
    }
    setApprovalPolling(false);
    setPendingDeviceId("");
    setRegistering(false);
    setRegisterError("");
    setStep(0);
  };

  const startSync = async () => {
    setSyncing(true);
    setSyncError("");
    try {
      await invoke("sync_initial_config");
      setStep(4);
    } catch (e) {
      setSyncError(String(e));
    }
    setSyncing(false);
  };

  return (
    <div class="setup-root">
      <div class="setup-card">
        <div class="setup-header">
          <span class="material-symbols-rounded setup-icon">lan</span>
          <h1>{t("setup.title")}</h1>
          <p class="setup-subtitle">{t("setup.subtitle")}</p>
        </div>

        {/* Step indicators */}
        <div class="setup-steps">
          {["step_address", "step_validate", "step_register", "step_sync", "step_complete"].map(
            (sk, idx) => (
              <div class={`setup-step-dot ${step() >= idx ? "active" : ""} ${step() === idx ? "current" : ""}`}>
                <span>{idx + 1}</span>
              </div>
            )
          )}
        </div>

        {/* Step 0: Address input */}
        <Show when={step() === 0}>
          <div class="setup-body">
            <div class="setup-discovery-header">
              <div>
                <div class="form-label">{t("setup.lan_discovery_title")}</div>
                <div class="form-hint">{t("setup.lan_discovery_hint")}</div>
              </div>
              <button class="btn btn-secondary btn-sm" onClick={discoverServers} disabled={discovering()}>
                <span class="material-symbols-rounded">travel_explore</span>
                {discovering() ? t("setup.searching_lan") : t("setup.search_lan")}
              </button>
            </div>

            <Show when={discoveredServers().length > 0}>
              <div class="setup-discovery-list">
                <For each={discoveredServers()}>
                  {(server) => (
                    <button
                      class={`setup-discovery-card ${address() === server.console_url ? "selected" : ""}`}
                      onClick={() => {
                        setAddress(server.console_url);
                        setAddressError("");
                      }}
                    >
                      <div class="setup-discovery-name">{server.name}</div>
                      <div class="setup-discovery-meta">{server.console_url}</div>
                      <Show when={server.version}>
                        <div class="setup-discovery-version">v{server.version}</div>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <Show when={!discovering() && discoveredServers().length === 0 && !discoveryError()}>
              <div class="form-hint">{t("setup.lan_discovery_empty")}</div>
            </Show>

            <Show when={discoveryError()}>
              <div class="form-error">{discoveryError()}</div>
            </Show>

            <label class="form-label">{t("setup.server_address")}</label>
            <input
              type="text"
              class={`form-input ${addressError() ? "error" : ""}`}
              placeholder={t("setup.server_placeholder")}
              value={address()}
              onInput={(e) => {
                setAddress(e.currentTarget.value);
                setAddressError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && startValidation()}
            />
            <Show when={addressError()}>
              <div class="form-error">{addressError()}</div>
            </Show>
            <button class="btn btn-primary setup-next" onClick={startValidation}>
              {t("setup.next")}
              <span class="material-symbols-rounded">arrow_forward</span>
            </button>
          </div>
        </Show>

        {/* Step 1: Validation */}
        <Show when={step() === 1}>
          <div class="setup-body">
            <p class="setup-progress-label">{t("setup.validating")}</p>
            <div class="validation-list">
              <For each={validationSteps()}>
                {(vs) => (
                  <div class={`validation-item ${vs.status}`}>
                    <span class="material-symbols-rounded validation-icon">
                      {vs.status === "pending"
                        ? "radio_button_unchecked"
                        : vs.status === "running"
                        ? "sync"
                        : vs.status === "ok"
                        ? "check_circle"
                        : "cancel"}
                    </span>
                    <span class="validation-label">{vs.label}</span>
                    <Show when={vs.error}>
                      <span class="validation-error">{vs.error}</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
            <Show when={validationSteps().some((v) => v.status === "error")}>
              <button class="btn btn-secondary" onClick={() => setStep(0)}>
                <span class="material-symbols-rounded">arrow_back</span>
                {t("setup.back")}
              </button>
            </Show>
          </div>
        </Show>

        {/* Step 2: Registration */}
        <Show when={step() === 2}>
          <div class="setup-body">
            {/* Pending approval sub-state */}
            <Show when={approvalPolling()}>
              <div class="setup-pending">
                <span class="material-symbols-rounded spin setup-pending-icon">hourglass_top</span>
                <h3>{t("setup.pending_title")}</h3>
                <p class="setup-pending-message">{t("setup.pending_message")}</p>
                <div class="setup-pending-device-id">
                  <span class="form-label">{t("setup.pending_device_id")}</span>
                  <code class="device-id-code">{pendingDeviceId()}</code>
                </div>
                <p class="setup-pending-hint">{t("setup.pending_hint")}</p>
                <button class="btn btn-secondary setup-pending-cancel" onClick={cancelPendingRegistration}>
                  <span class="material-symbols-rounded">close</span>
                  {t("setup.pending_cancel")}
                </button>
              </div>
            </Show>

            {/* Normal registration state */}
            <Show when={!approvalPolling()}>
              <Show when={!registering()} fallback={
                <div class="setup-progress">
                  <span class="material-symbols-rounded spin">sync</span>
                  <p>{t("setup.registering")}</p>
                </div>
              }>
                <Show when={registerError()} fallback={
                  <button class="btn btn-primary" onClick={startRegistration}>
                    {t("setup.step_register")}
                    <span class="material-symbols-rounded">arrow_forward</span>
                  </button>
                }>
                  <div class="setup-error">
                    <span class="material-symbols-rounded">error</span>
                    <p>{registerError()}</p>
                  </div>
                  <button class="btn btn-secondary" onClick={() => { setRegisterError(""); startRegistration(); }}>
                    {t("setup.step_register")}
                  </button>
                </Show>
              </Show>
            </Show>
          </div>
        </Show>

        {/* Step 3: Sync */}
        <Show when={step() === 3}>
          <div class="setup-body">
            <Show when={syncing()} fallback={
              <Show when={syncError()}>
                <div class="setup-error">
                  <span class="material-symbols-rounded">error</span>
                  <p>{syncError()}</p>
                </div>
                <button class="btn btn-secondary" onClick={startSync}>
                  {t("setup.step_sync")}
                </button>
              </Show>
            }>
              <div class="setup-progress">
                <span class="material-symbols-rounded spin">sync</span>
                <p>{t("setup.syncing")}</p>
              </div>
            </Show>
          </div>
        </Show>

        {/* Step 4: Complete */}
        <Show when={step() === 4}>
          <div class="setup-body setup-complete">
            <span class="material-symbols-rounded complete-icon">check_circle</span>
            <h2>{t("setup.complete_title")}</h2>
            <p>{t("setup.complete_message")}</p>
            <button class="btn btn-primary" onClick={props.onComplete}>
              {t("setup.finish")}
              <span class="material-symbols-rounded">arrow_forward</span>
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default SetupWizard;
