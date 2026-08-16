//go:build windows

package main

import (
	"os"
	"path/filepath"
)

func init() {
	prepWindowsGraphics()
}

// prepWindowsGraphics cleans up incomplete Mesa OpenGL sidecars left by older
// Fyne builds. The default Wails UI uses WebView2 and does not need Mesa; an
// orphan opengl32.dll without libgallium_wgl.dll still must not shadow system GL.
func prepWindowsGraphics() {
	ensureMesaBesideExe()
	dir := exeDir()
	gl := filepath.Join(dir, "opengl32.dll")
	gallium := filepath.Join(dir, "libgallium_wgl.dll")
	if _, err := os.Stat(gl); err != nil {
		return
	}
	if _, err := os.Stat(gallium); err != nil {
		_ = os.Remove(gl)
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
