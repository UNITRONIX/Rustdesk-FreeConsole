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
			"test_console":      "Console",
			"close":             "Close",
			"password_too_short": "Password must be at least 6 characters",
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
			"test_console":      "Konsola",
			"close":             "Zamknij",
			"password_too_short": "Hasło musi mieć co najmniej 6 znaków",
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
