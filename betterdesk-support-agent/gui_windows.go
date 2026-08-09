//go:build windows

package main

import (
	"os"
	"path/filepath"
)

func init() {
	prepWindowsGraphics()
}

// prepWindowsGraphics enables Mesa software OpenGL when a complete Mesa DLL
// set ships next to the exe. An incomplete opengl32.dll (missing
// libgallium_wgl.dll) is removed so it cannot shadow system OpenGL and crash
// with STATUS_DLL_NOT_FOUND (0xC0000135).
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
