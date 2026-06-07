//go:build windows

package main

import (
	"os"
	"path/filepath"
)

func init() {
	prepWindowsGraphics()
}

// prepWindowsGraphics enables Mesa software OpenGL when opengl32.dll ships next to the exe.
func prepWindowsGraphics() {
	ensureMesaBesideExe()
	exe, err := os.Executable()
	if err != nil {
		return
	}
	dir := filepath.Dir(exe)
	if _, err := os.Stat(filepath.Join(dir, "opengl32.dll")); err != nil {
		return
	}
	if os.Getenv("GALLIUM_DRIVER") == "" {
		_ = os.Setenv("GALLIUM_DRIVER", "llvmpipe")
	}
	if os.Getenv("LIBGL_ALWAYS_SOFTWARE") == "" {
		_ = os.Setenv("LIBGL_ALWAYS_SOFTWARE", "1")
	}
}

func prepLinuxDisplay() {}
