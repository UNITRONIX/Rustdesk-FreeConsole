package main

import (
	"testing"
)

func TestNormalizeLocale(t *testing.T) {
	cases := map[string]string{
		"pl_PL.UTF-8": "pl",
		"en-US":       "en",
		"zh-CN":       "zh",
		"zh-TW":       "zh-TW",
		"nb_NO":       "nb",
		"pt-BR":       "pt",
		"":            "en",
		"xx":          "en",
	}
	for in, want := range cases {
		if got := normalizeLocale(in); got != want {
			t.Fatalf("normalizeLocale(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestEmbeddedLocales(t *testing.T) {
	for _, code := range SupportedLocales {
		if _, ok := translation[code]; !ok {
			t.Fatalf("missing embedded locale %s", code)
		}
	}
	enKeys := len(translation["en"])
	for _, code := range SupportedLocales {
		if len(translation[code]) != enKeys {
			t.Fatalf("locale %s has %d keys, en has %d", code, len(translation[code]), enKeys)
		}
	}
}

func TestTranslationFallback(tt *testing.T) {
	setLang("pl")
	if got := t("save"); got != "Zapisz" {
		tt.Fatalf("expected Polish save, got %q", got)
	}
	setLang("en")
}
