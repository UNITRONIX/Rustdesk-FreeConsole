import { Component, createSignal, onMount, onCleanup, Show } from "solid-js";
import { HashRouter as Router, Route } from "@solidjs/router";
import StatusPanel from "./components/StatusPanel";
import SetupWizard from "./components/SetupWizard";
import ChatPanel from "./components/ChatPanel";
import HelpRequest from "./components/HelpRequest";
import SettingsPanel from "./components/SettingsPanel";
import ConsentDialog from "./components/ConsentDialog";
import SudoAuthDialog from "./components/SudoAuthDialog";
import SessionOverlay from "./components/SessionOverlay";
import { initI18n, t } from "./lib/i18n";
import { frontendLog } from "./lib/logger";
import { loadBranding } from "./lib/branding";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ── Navigation listener (tray menu events → router) ──────────────────────────
const getCurrentHashRoute = (): string => {
  if (typeof window === "undefined") {
    return "/";
  }

  const raw = window.location.hash.replace(/^#/, "") || "/";
  return raw.startsWith("/") ? raw : `/${raw}`;
};

const getCurrentHashPath = (): string => getCurrentHashRoute().split("?")[0] || "/";

const navigateHashRoute = (route: string): void => {
  if (typeof window === "undefined") {
    return;
  }

  const normalized = route.startsWith("/") ? route : `/${route}`;
  if (getCurrentHashRoute() === normalized) {
    return;
  }

  window.location.hash = normalized;
};

const NavigationListener: Component = () => {
  onMount(() => {
    const unlistenPromise = listen<string>("navigate", (event) => {
      const route = event.payload;
      if (typeof route === "string" && route.startsWith("/")) {
        navigateHashRoute(route);
      }
    });
    onCleanup(async () => (await unlistenPromise)());
  });

  return null;
};

// ── Bottom navigation bar ─────────────────────────────────────────────────────
// Visible tabs: Status | Chat | Help | Settings
// The "Close" action is in the overflow menu (requires sudo auth for non-admins).
interface BottomNavProps {
  isAdmin: boolean;
  onQuit: () => void;
}

interface RegisteredShellProps {
  isAdmin: boolean;
  onQuit: () => void;
}

const BottomNav: Component<BottomNavProps> = (props) => {
  const [showMenu, setShowMenu] = createSignal(false);
  const [currentPath, setCurrentPath] = createSignal(getCurrentHashPath());

  const isActive = (path: string) =>
    path === "/" ? currentPath() === "/" : currentPath().startsWith(path);

  // Close overflow menu on outside click. Solid delegates click handlers at the
  // document level, so the native listener must explicitly ignore clicks inside
  // this overflow area instead of relying on stopPropagation timing.
  onMount(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".bottom-nav-overflow")) {
        return;
      }

      setShowMenu(false);
    };
    const syncPath = () => setCurrentPath(getCurrentHashPath());

    document.addEventListener("click", handler, { capture: true });
    window.addEventListener("hashchange", syncPath);
    onCleanup(() => {
      document.removeEventListener("click", handler, { capture: true });
      window.removeEventListener("hashchange", syncPath);
    });
  });

  const mainTabs = [
    { path: "/", icon: "monitoring", label: () => t("sidebar.status") },
    { path: "/chat", icon: "chat", label: () => t("sidebar.chat") },
    { path: "/help", icon: "support_agent", label: () => t("sidebar.help") },
  ];

  return (
    <nav class="bottom-nav">
      {mainTabs.map((tab) => (
        <button
          class={`bottom-nav-item ${isActive(tab.path) ? "active" : ""}`}
          onClick={() => { setShowMenu(false); navigateHashRoute(tab.path); }}
        >
          <span class="material-symbols-rounded">{tab.icon}</span>
          <span class="bottom-nav-label">{tab.label()}</span>
        </button>
      ))}

            {/* Settings / overflow */}
          <div class="bottom-nav-overflow" onClick={(e) => e.stopPropagation()}>
            <button
              class={`bottom-nav-item ${showMenu() || isActive("/settings") ? "active" : ""}`}
              type="button"
              aria-haspopup="menu"
              aria-expanded={showMenu()}
              onClick={() => setShowMenu((v) => !v)}
            >
              <span class="material-symbols-rounded">more_vert</span>
              <span class="bottom-nav-label">{t("sidebar.more")}</span>
            </button>

            <Show when={showMenu()}>
              <div class="overflow-menu" role="menu">
                {/* Settings — always visible, SudoAuthDialog gates controls inside */}
                <button
                  class="overflow-menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => { navigateHashRoute("/settings"); setShowMenu(false); }}
                >
                  <span class="material-symbols-rounded">settings</span>
                  {t("sidebar.settings")}
                </button>

                <hr class="overflow-menu-divider" />
                {/* Close — always visible; non-admin gets sudo dialog */}
                <button
                  class="overflow-menu-item overflow-menu-item-danger"
                  type="button"
                  role="menuitem"
                  onClick={() => { props.onQuit(); setShowMenu(false); }}
                >
                  <span class="material-symbols-rounded">power_settings_new</span>
                  {t("app.close_agent")}
                </button>
              </div>
            </Show>
          </div>
        </nav>
  );
};

const RegisteredShell: Component<RegisteredShellProps> = (props) => {
  return (
    <Router
      root={(routerProps) => (
        <div class="app-layout app-layout-tray">
          <NavigationListener />
          <ConsentDialog />
          <SessionOverlay />
          <main class="app-main app-main-full">{routerProps.children}</main>
          <BottomNav isAdmin={props.isAdmin} onQuit={props.onQuit} />
        </div>
      )}
    >
      <Route path="/" component={StatusPanel} />
      <Route path="/chat" component={ChatPanel} />
      <Route path="/help" component={HelpRequest} />
      <Route
        path="/settings"
        component={() => <SettingsPanel isAdmin={props.isAdmin} />}
      />
    </Router>
  );
};

// ── Root App component ────────────────────────────────────────────────────────
const App: Component = () => {
  const [ready, setReady] = createSignal(false);
  const [registered, setRegistered] = createSignal(false);
  const [isAdmin, setIsAdmin] = createSignal(false);
  const [bootStage, setBootStage] = createSignal("Starting BetterDesk Agent...");
  // Quit confirmation / sudo auth dialog state.
  const [showQuitDialog, setShowQuitDialog] = createSignal(false);

  const markBootStage = (message: string, data?: unknown) => {
    setBootStage(message);
    frontendLog("debug", "app.boot", message, data);
  };

  const withTimeout = <T,>(
    promise: Promise<T>,
    timeoutMs: number,
    fallbackValue: T,
    label: string,
  ): Promise<T> => {
    return new Promise<T>((resolve) => {
      const timeoutId = window.setTimeout(() => {
        frontendLog("warn", "app.boot", `${label} timed out after ${timeoutMs}ms`);
        resolve(fallbackValue);
      }, timeoutMs);

      promise
        .then((value) => {
          window.clearTimeout(timeoutId);
          resolve(value);
        })
        .catch((error) => {
          window.clearTimeout(timeoutId);
          frontendLog("error", "app.boot", `${label} failed`, error);
          resolve(fallbackValue);
        });
    });
  };

  const checkRegistration = async (): Promise<boolean> => {
    frontendLog("debug", "app.boot", "Requesting cached agent registration state");
    try {
      const result = await Promise.race([
        invoke<{ registered: boolean }>("get_agent_status"),
        new Promise<null>((r) => setTimeout(() => r(null), 1000)),
      ]);
      if (result === null) {
        frontendLog("warn", "app.boot", "get_agent_status timed out after 1000ms");
        return false;
      }

      const registeredState = !!result.registered;
      frontendLog("info", "app.boot", "Cached registration probe finished", {
        registered: registeredState,
      });
      return registeredState;
    } catch (error) {
      frontendLog("error", "app.boot", "get_agent_status failed", error);
      return false;
    }
  };

  const doQuit = async () => {
    frontendLog("info", "app.quit", "Quit confirmed by user");
    try {
      await invoke("quit_app");
    } catch (error) {
      frontendLog("error", "app.quit", "quit_app IPC failed", error);
    }
  };

  onMount(async () => {
    frontendLog("info", "app.boot", "App mounted");

    const quitUnlistenPromise = listen<void>("request-quit", () => {
      frontendLog("info", "app.quit", "Quit requested from tray/window");
      setShowQuitDialog(true);
    });

    void quitUnlistenPromise
      .then((unlisten) => {
        onCleanup(unlisten);
      })
      .catch((error) => {
        frontendLog("error", "app.boot", "Failed to register request-quit listener", error);
      });

    try {
      markBootStage("Initialising bundled translations");
      await withTimeout(
        initI18n(),
        750,
        undefined,
        "initI18n",
      );

      // Apply per-deployment branding (theme colors, product name, logo). Runs
      // in the background so a slow/failed load never blocks the boot path.
      void withTimeout(loadBranding(), 1000, undefined, "loadBranding");

      markBootStage("Checking agent state");
      const [reg, admin] = await Promise.all([
        checkRegistration(),
        withTimeout(
          invoke<boolean>("is_os_admin"),
          2000,
          false,
          "is_os_admin",
        ),
      ]);

      setRegistered(reg);
      setIsAdmin(admin);
      frontendLog("info", "app.boot", "Boot state resolved", {
        registered: reg,
        isAdmin: admin,
      });
    } catch (error) {
      frontendLog("error", "app.boot", "Unexpected boot failure - continuing with safe defaults", error);
    }

    setReady(true);
    frontendLog("info", "app.boot", "UI ready", {
      registered: registered(),
      isAdmin: isAdmin(),
    });
  });

  return (
    <div class="app-root">
      {/* Quit confirmation / sudo auth dialog — rendered at root so it overlays everything */}
      <Show when={showQuitDialog()}>
        {isAdmin() ? (
          // Admin: simple confirmation without sudo.
          <div class="sudo-auth-overlay">
            <div class="sudo-auth-dialog">
              <div class="sudo-auth-icon">
                <span class="material-symbols-rounded">power_settings_new</span>
              </div>
              <h2 class="sudo-auth-title">{t("app.quit_title")}</h2>
              <p class="sudo-auth-subtitle">{t("app.close_confirm")}</p>
              <div class="sudo-auth-actions">
                <button class="sudo-auth-btn sudo-auth-btn-cancel" onClick={() => setShowQuitDialog(false)}>
                  {t("auth.cancel")}
                </button>
                <button class="sudo-auth-btn sudo-auth-btn-submit" onClick={doQuit}>
                  {t("app.close_agent")}
                </button>
              </div>
            </div>
          </div>
        ) : (
          // Non-admin: require sudo password before quitting.
          <SudoAuthDialog
            title={t("app.quit_title")}
            subtitle={t("app.quit_sudo_hint")}
            onSuccess={doQuit}
            onCancel={() => setShowQuitDialog(false)}
          />
        )}
      </Show>
      <Show
        when={ready()}
        fallback={
          <div class="app-loading">
            <span class="material-symbols-rounded spin">sync</span>
            <span>{bootStage()}</span>
          </div>
        }
      >
        <Show
          when={registered()}
          fallback={
            <SetupWizard
              onComplete={async () => {
                const ok = await checkRegistration();
                if (ok) {
                  navigateHashRoute("/");
                }
                setRegistered(ok);
              }}
            />
          }
        >
          <RegisteredShell isAdmin={isAdmin()} onQuit={() => setShowQuitDialog(true)} />
        </Show>
      </Show>
    </div>
  );
};

export default App;

