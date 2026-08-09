//go:build windows

package main

import (
	"os"
	"path/filepath"
)

func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}
