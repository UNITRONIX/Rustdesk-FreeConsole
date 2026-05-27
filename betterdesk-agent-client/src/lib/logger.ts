// Frontend logger that mirrors important events into the Rust-side log file
// via a Tauri IPC bridge. In dev mode it also echoes to the browser console.

import { invoke } from "@tauri-apps/api/core";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const IS_DEV = typeof import.meta !== "undefined" && Boolean((import.meta as any).env?.DEV);

function consoleEcho(level: LogLevel, scope: string, message: string, data?: unknown): void {
  if (!IS_DEV || typeof console === "undefined") return;
  const tag = `[${scope}]`;
  const fn =
    level === "error"
      ? console.error
      : level === "warn"
      ? console.warn
      : level === "debug" || level === "trace"
      ? console.debug
      : console.log;
  if (data !== undefined) {
    fn.call(console, tag, message, data);
  } else {
    fn.call(console, tag, message);
  }
}

/**
 * Send a structured log event to the Rust backend.
 *
 * The Rust side writes it to the normal agent log file via the
 * `log_frontend_event` IPC command, so packaged builds can be diagnosed
 * without opening browser devtools.
 */
export function frontendLog(
  level: LogLevel,
  scope: string,
  message: string,
  data?: unknown,
): void {
  consoleEcho(level, scope, message, data);
  // Fire-and-forget: never let logging failures crash the UI.
  void invoke("log_frontend_event", {
    level,
    scope,
    message,
    data: data === undefined ? null : data,
  }).catch(() => {
    // The Rust command is missing during early boot or in environments
    // where the Tauri bridge is unavailable (e.g. plain browser preview).
    // Silently ignore — the console echo above is the only fallback.
  });
}

/**
 * Hook global window error and unhandled-rejection handlers so that any
 * uncaught failure is forwarded to the Rust log file.
 *
 * Idempotent — installing twice still installs only one set of handlers.
 */
let handlersInstalled = false;
export function installFrontendErrorLogging(): void {
  if (handlersInstalled || typeof window === "undefined") return;
  handlersInstalled = true;

  window.addEventListener("error", (event) => {
    frontendLog("error", "window", event.message, {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error?.stack,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === "string"
        ? reason
        : "Unhandled promise rejection";
    frontendLog("error", "window", message, {
      stack: reason instanceof Error ? reason.stack : undefined,
      reason: reason instanceof Error ? undefined : reason,
    });
  });
}
