//go:build windows && mesaembed

package main

import (
	"embed"
	"io/fs"
	"log"
	"os"
	"path/filepath"
)

// Complete Mesa software-OpenGL set. opengl32.dll alone depends on
// libgallium_wgl.dll — shipping only opengl32 causes STATUS_DLL_NOT_FOUND
// because Windows prefers the local broken DLL over system OpenGL.
//
//go:embed windows/*.dll
var mesaDLLFS embed.FS

func ensureMesaBesideExe() {
	dir := exeDir()
	entries, err := fs.ReadDir(mesaDLLFS, "windows")
	if err != nil {
		log.Printf("[support-agent] mesa embed listing failed: %v", err)
		return
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".dll" {
			continue
		}
		target := filepath.Join(dir, e.Name())
		if _, err := os.Stat(target); err == nil {
			continue
		}
		data, err := mesaDLLFS.ReadFile("windows/" + e.Name())
		if err != nil || len(data) == 0 {
			continue
		}
		if err := os.WriteFile(target, data, 0o644); err != nil {
			log.Printf("[support-agent] could not write %s: %v", e.Name(), err)
		}
	}
}
