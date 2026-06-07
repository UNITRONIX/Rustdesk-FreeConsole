package main

import "sync"

// Minimal i18n for the support agent UI. Strings are keyed; English is the
// fallback. The active language comes from AppState (default from branding).

var (
	langMu      sync.RWMutex
	activeLang  = "en"
	translation = map[string]map[string]string{
		"en": {
			"window_title":      "Support",
			"your_id":           "Your ID",
			"access_password":   "Access password",
			"show":              "Show",
			"hide":              "Hide",
			"copy":              "Copy",
			"copied":            "Copied to clipboard",
			"regenerate":        "Generate new",
			"set_custom":        "Set custom password",
			"custom_password":   "Custom password",
			"access_mode":       "Access mode",
			"mode_supervised":   "Ask each time",
			"mode_unattended":   "Unattended access",
			"mode_disabled":     "Disabled",
			"request_help":      "Request help",
			"help_message":      "Describe your problem",
			"send":              "Send",
			"cancel":            "Cancel",
			"help_sent":         "Help request sent",
			"help_failed":       "Could not send help request",
			"connected":         "Connected",
			"disconnected":      "Connecting…",
			"save":              "Save",
			"settings":          "Settings",
			"test_connection":   "Test connection",
			"test_running":      "Testing connection…",
			"test_ok":           "Connection OK",
			"test_failed":       "Connection problem",
			"test_gateway":      "Remote gateway",
			"test_api":          "Management API",
			"test_enrollment":   "Device registration API",
			"close":             "Close",
			"password_too_short": "Password must be at least 6 characters",
			"status_ready":       "Ready",
			"enrollment_pending": "Waiting for operator approval",
			"enrollment_rejected": "Registration rejected",
			"enrollment_error":   "Registration failed",
			"consent_title":      "Remote access request",
			"consent_prompt":     "Allow connection from",
			"session_active":     "Active session",
			"session_with":       "Session with",
			"session_disconnect": "Hide session bar",
			"chat_with_support":  "Chat with support",
			"settings_language":  "Language",
			"quit":               "Quit",
			"consent_accept":     "Accept",
			"consent_deny":       "Deny",
			"chat_title":         "Support chat",
			"chat_send":          "Send message",
			"chat_placeholder":   "Type a message…",
			"chat_empty":         "No messages yet",
			"totp_title":         "Two-factor authentication",
			"totp_enabled":       "2FA is enabled for this device",
			"totp_disabled":      "2FA is not enabled",
			"totp_setup":           "Set up 2FA",
			"totp_disable":         "Disable 2FA",
			"totp_manual_key":      "Manual key",
			"totp_step2":           "Scan the URI in your authenticator app, then enter the code",
			"totp_enter_code":      "Enter verification code",
			"totp_verify_enable":   "Verify and enable",
			"totp_invalid_code":    "Invalid verification code",
			"totp_enabled_success": "Two-factor authentication enabled",
			"totp_disabled_success": "Two-factor authentication disabled",
			"totp_setup_failed":    "Could not start 2FA setup",
		},
		"pl": {
			"window_title":      "Wsparcie",
			"your_id":           "Twoje ID",
			"access_password":   "Hasło dostępu",
			"show":              "Pokaż",
			"hide":              "Ukryj",
			"copy":              "Kopiuj",
			"copied":            "Skopiowano do schowka",
			"regenerate":        "Generuj nowe",
			"set_custom":        "Ustaw własne hasło",
			"custom_password":   "Własne hasło",
			"access_mode":       "Tryb dostępu",
			"mode_supervised":   "Pytaj za każdym razem",
			"mode_unattended":   "Dostęp bez nadzoru",
			"mode_disabled":     "Wyłączony",
			"request_help":      "Poproś o pomoc",
			"help_message":      "Opisz swój problem",
			"send":              "Wyślij",
			"cancel":            "Anuluj",
			"help_sent":         "Wysłano prośbę o pomoc",
			"help_failed":       "Nie udało się wysłać prośby o pomoc",
			"connected":         "Połączono",
			"disconnected":      "Łączenie…",
			"save":              "Zapisz",
			"settings":          "Ustawienia",
			"test_connection":   "Testuj połączenie",
			"test_running":      "Testowanie połączenia…",
			"test_ok":           "Połączenie poprawne",
			"test_failed":       "Problem z połączeniem",
			"test_gateway":      "Brama zdalna",
			"test_api":          "API serwera",
			"test_enrollment":   "API rejestracji urządzenia",
			"close":             "Zamknij",
			"password_too_short": "Hasło musi mieć co najmniej 6 znaków",
			"status_ready":       "Gotowy",
			"enrollment_pending": "Oczekiwanie na zatwierdzenie operatora",
			"enrollment_rejected": "Rejestracja odrzucona",
			"enrollment_error":   "Rejestracja nie powiodła się",
			"consent_title":      "Prośba o zdalny dostęp",
			"consent_prompt":     "Zezwolić na połączenie od",
			"session_active":     "Aktywna sesja",
			"session_with":       "Sesja z",
			"session_disconnect": "Ukryj pasek sesji",
			"chat_with_support":  "Czat ze wsparciem",
			"settings_language":  "Język",
			"quit":               "Zakończ",
			"consent_accept":     "Akceptuj",
			"consent_deny":       "Odrzuć",
			"chat_title":         "Czat wsparcia",
			"chat_send":          "Wyślij wiadomość",
			"chat_placeholder":   "Wpisz wiadomość…",
			"chat_empty":         "Brak wiadomości",
			"totp_title":         "Uwierzytelnianie dwuskładnikowe",
			"totp_enabled":       "2FA włączone na tym urządzeniu",
			"totp_disabled":      "2FA wyłączone",
			"totp_setup":           "Skonfiguruj 2FA",
			"totp_disable":         "Wyłącz 2FA",
			"totp_manual_key":      "Klucz ręczny",
			"totp_step2":           "Zeskanuj URI w aplikacji uwierzytelniającej, potem wpisz kod",
			"totp_enter_code":      "Wprowadź kod weryfikacyjny",
			"totp_verify_enable":   "Zweryfikuj i włącz",
			"totp_invalid_code":    "Nieprawidłowy kod weryfikacyjny",
			"totp_enabled_success": "Uwierzytelnianie dwuskładnikowe włączone",
			"totp_disabled_success": "Uwierzytelnianie dwuskładnikowe wyłączone",
			"totp_setup_failed":    "Nie udało się rozpocząć konfiguracji 2FA",
		},
	}
)

// setLang sets the active UI language if a translation table exists.
func setLang(lang string) {
	langMu.Lock()
	defer langMu.Unlock()
	if _, ok := translation[lang]; ok {
		activeLang = lang
	}
}

// t returns the translated string for key, falling back to English then the
// key itself.
func t(key string) string {
	langMu.RLock()
	defer langMu.RUnlock()
	if m, ok := translation[activeLang]; ok {
		if v, ok := m[key]; ok {
			return v
		}
	}
	if v, ok := translation["en"][key]; ok {
		return v
	}
	return key
}
