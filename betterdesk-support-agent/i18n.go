package main

import (
	"embed"
	"encoding/json"
	"log"
	"strings"
	"sync"
)

//go:embed locales/*.json
var localeFS embed.FS

// SupportedLocales lists UI languages (same set as web-nodejs console).
var SupportedLocales = []string{
	"ar", "cs", "da", "de", "en", "es", "fi", "fr", "hi", "hu", "id", "it",
	"ja", "ko", "nb", "nl", "pl", "pt", "ro", "sv", "th", "tr", "uk", "vi",
	"zh", "zh-TW",
}

var (
	langMu       sync.RWMutex
	activeLang   = "en"
	translation  map[string]map[string]string
	localeLabels map[string]string
)

func init() {
	loadEmbeddedLocales()
}

func loadEmbeddedLocales() {
	translation = make(map[string]map[string]string, len(SupportedLocales))
	localeLabels = make(map[string]string, len(SupportedLocales))

	for _, code := range SupportedLocales {
		path := "locales/" + code + ".json"
		data, err := localeFS.ReadFile(path)
		if err != nil {
			log.Printf("[i18n] missing locale %s: %v", code, err)
			continue
		}
		var m map[string]string
		if err := json.Unmarshal(data, &m); err != nil {
			log.Printf("[i18n] parse %s: %v", code, err)
			continue
		}
		translation[code] = m
		localeLabels[code] = languageNativeName(code)
	}
}

// setLang sets the active UI language when supported.
func setLang(lang string) {
	lang = normalizeLocale(lang)
	langMu.Lock()
	defer langMu.Unlock()
	if _, ok := translation[lang]; ok {
		activeLang = lang
	}
}

// t returns the translated string for key, falling back to English then the key.
func t(key string) string {
	langMu.RLock()
	defer langMu.RUnlock()
	if m, ok := translation[activeLang]; ok {
		if v, ok := m[key]; ok && v != "" {
			return v
		}
	}
	if v, ok := translation["en"][key]; ok {
		return v
	}
	return key
}

// normalizeLocale maps OS/browser tags to supported codes.
func normalizeLocale(tag string) string {
	tag = strings.TrimSpace(tag)
	if tag == "" {
		return "en"
	}
	tag = strings.ReplaceAll(tag, "_", "-")
	lower := strings.ToLower(tag)

	for _, code := range SupportedLocales {
		if strings.EqualFold(code, tag) || strings.EqualFold(code, lower) {
			return code
		}
	}
	base := lower
	if i := strings.IndexAny(base, "-@."); i >= 0 {
		base = base[:i]
	}
	switch base {
	case "nb", "no", "nn":
		return "nb"
	case "zh":
		if strings.HasPrefix(lower, "zh-tw") || strings.HasPrefix(lower, "zh-hk") || strings.HasPrefix(lower, "zh-mo") {
			return "zh-TW"
		}
		return "zh"
	case "pt":
		return "pt"
	}
	for _, code := range SupportedLocales {
		if strings.EqualFold(code, base) {
			return code
		}
	}
	return "en"
}

// resolveInitialLanguage picks persisted/branding/system language on first run.
func resolveInitialLanguage(brandingDefault string) string {
	if brandingDefault != "" {
		if code := normalizeLocale(brandingDefault); hasLocale(code) {
			return code
		}
	}
	if sys := detectSystemLanguage(); sys != "" && hasLocale(sys) {
		return sys
	}
	return "en"
}

func hasLocale(code string) bool {
	_, ok := translation[code]
	return ok
}

// languageOptions returns locale codes with native labels for settings UI.
func languageOptions() []string {
	out := make([]string, 0, len(SupportedLocales))
	for _, code := range SupportedLocales {
		if label, ok := localeLabels[code]; ok && label != "" {
			out = append(out, code+" — "+label)
		} else {
			out = append(out, code)
		}
	}
	return out
}

func languageCodeFromOption(opt string) string {
	if i := strings.Index(opt, " — "); i >= 0 {
		return strings.TrimSpace(opt[:i])
	}
	return strings.TrimSpace(opt)
}

func languageOptionForCode(code string) string {
	code = normalizeLocale(code)
	if label, ok := localeLabels[code]; ok && label != "" {
		return code + " — " + label
	}
	return code
}

func languageNativeName(code string) string {
	switch code {
	case "ar":
		return "العربية"
	case "cs":
		return "Čeština"
	case "da":
		return "Dansk"
	case "de":
		return "Deutsch"
	case "en":
		return "English"
	case "es":
		return "Español"
	case "fi":
		return "Suomi"
	case "fr":
		return "Français"
	case "hi":
		return "हिन्दी"
	case "hu":
		return "Magyar"
	case "id":
		return "Bahasa Indonesia"
	case "it":
		return "Italiano"
	case "ja":
		return "日本語"
	case "ko":
		return "한국어"
	case "nb":
		return "Norsk Bokmål"
	case "nl":
		return "Nederlands"
	case "pl":
		return "Polski"
	case "pt":
		return "Português"
	case "ro":
		return "Română"
	case "sv":
		return "Svenska"
	case "th":
		return "ไทย"
	case "tr":
		return "Türkçe"
	case "uk":
		return "Українська"
	case "vi":
		return "Tiếng Việt"
	case "zh":
		return "简体中文"
	case "zh-TW":
		return "繁體中文"
	default:
		return code
	}
}
