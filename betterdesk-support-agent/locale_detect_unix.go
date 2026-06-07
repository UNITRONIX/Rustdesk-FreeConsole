//go:build !windows

package main

import (
	"os"
	"strings"
)

func detectSystemLanguage() string {
	for _, key := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		if v := os.Getenv(key); v != "" {
			if code := parseUnixLocale(v); code != "" {
				return code
			}
		}
	}
	return ""
}

func parseUnixLocale(v string) string {
	v = strings.TrimSpace(v)
	if v == "" || v == "C" || v == "POSIX" {
		return ""
	}
	if i := strings.Index(v, "."); i >= 0 {
		v = v[:i]
	}
	return normalizeLocale(v)
}
