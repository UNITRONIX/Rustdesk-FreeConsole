//go:build windows

package main

import (
	"log"
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

// ensureMesaBesideExe drops a bundled Mesa opengl32.dll next to the exe when the
// build embeds one (Generator / cross-build with scripts/fetch-mesa-windows.sh).
func ensureMesaBesideExe() {
	target := filepath.Join(exeDir(), "opengl32.dll")
	if _, err := os.Stat(target); err == nil {
		return
	}
	data := mesaDLLBytes()
	if len(data) == 0 {
		return
	}
	if err := os.WriteFile(target, data, 0o644); err != nil {
		log.Printf("[support-agent] could not write opengl32.dll: %v", err)
	}
}
