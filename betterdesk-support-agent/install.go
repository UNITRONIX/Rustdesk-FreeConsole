package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// Installation turns the portable binary into the "installer form": it copies
// itself to a stable per-user location and registers autostart so the tray
// agent launches at login. The same binary therefore serves both forms — run
// it directly (portable) or with -install (installed).

const installAppName = "betterdesk-support"

// installDir returns the per-user directory the installed binary lives in.
func installDir() (string, error) {
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			base = os.Getenv("APPDATA")
		}
		if base == "" {
			return "", fmt.Errorf("LOCALAPPDATA not set")
		}
		return filepath.Join(base, "BetterDeskSupport"), nil
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Applications", "BetterDeskSupport"), nil
	default: // linux
		base, err := os.UserConfigDir()
		if err != nil {
			home, _ := os.UserHomeDir()
			base = filepath.Join(home, ".local", "share")
		}
		return filepath.Join(base, installAppName, "bin"), nil
	}
}

// installedBinaryPath returns the path of the installed executable.
func installedBinaryPath() (string, error) {
	dir, err := installDir()
	if err != nil {
		return "", err
	}
	name := installAppName
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(dir, name), nil
}

// Install copies the running binary to the install directory and registers
// per-user autostart.
func Install() error {
	src, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate executable: %w", err)
	}
	dst, err := installedBinaryPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("create install dir: %w", err)
	}
	if err := copyExecutable(src, dst); err != nil {
		return fmt.Errorf("copy binary: %w", err)
	}
	copyMesaCompanion(src, dst)
	if err := registerAutostart(dst); err != nil {
		return fmt.Errorf("register autostart: %w", err)
	}
	fmt.Printf("Installed to %s and registered autostart.\n", dst)
	return nil
}

// Uninstall removes autostart and the installed binary.
func Uninstall() error {
	if err := unregisterAutostart(); err != nil {
		fmt.Printf("warning: remove autostart: %v\n", err)
	}
	dst, err := installedBinaryPath()
	if err == nil {
		_ = os.Remove(dst)
		_ = os.Remove(filepath.Dir(dst))
	}
	fmt.Println("Uninstalled autostart entry.")
	return nil
}

// copyExecutable copies src to dst preserving the executable bit.
func copyExecutable(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	// Replace any previous install atomically.
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

// copyMesaCompanion copies software OpenGL (Mesa opengl32.dll) beside the installed binary.
func copyMesaCompanion(srcExe, dstExe string) {
	mesa := filepath.Join(filepath.Dir(srcExe), "opengl32.dll")
	if _, err := os.Stat(mesa); err != nil {
		return
	}
	dst := filepath.Join(filepath.Dir(dstExe), "opengl32.dll")
	_ = copyExecutable(mesa, dst)
}

// registerAutostart wires the installed binary to launch at user login.
func registerAutostart(binPath string) error {
	switch runtime.GOOS {
	case "windows":
		return autostartWindows(binPath, true)
	case "darwin":
		return autostartDarwin(binPath, true)
	default:
		return autostartLinux(binPath, true)
	}
}

// unregisterAutostart removes the login entry.
func unregisterAutostart() error {
	switch runtime.GOOS {
	case "windows":
		return autostartWindows("", false)
	case "darwin":
		return autostartDarwin("", false)
	default:
		return autostartLinux("", false)
	}
}

// ── Linux: XDG autostart .desktop ────────────────────────────────────

func linuxAutostartPath() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "autostart", installAppName+".desktop"), nil
}

func autostartLinux(binPath string, enable bool) error {
	path, err := linuxAutostartPath()
	if err != nil {
		return err
	}
	if !enable {
		err := os.Remove(path)
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	entry := fmt.Sprintf(`[Desktop Entry]
Type=Application
Name=%s
Exec=%q
Terminal=false
X-GNOME-Autostart-enabled=true
`, GetBranding().ProductName, binPath)
	return os.WriteFile(path, []byte(entry), 0o644)
}

// ── Windows: HKCU Run key via reg.exe ────────────────────────────────

func autostartWindows(binPath string, enable bool) error {
	const key = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
	if !enable {
		cmd := exec.Command("reg", "delete", key, "/v", installAppName, "/f")
		_ = cmd.Run() // ignore "value not found"
		return nil
	}
	cmd := exec.Command("reg", "add", key, "/v", installAppName, "/t", "REG_SZ", "/d", binPath, "/f")
	return cmd.Run()
}

// ── macOS: LaunchAgent plist ─────────────────────────────────────────

func darwinLaunchAgentPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "LaunchAgents", "com.betterdesk.supportagent.plist"), nil
}

func autostartDarwin(binPath string, enable bool) error {
	path, err := darwinLaunchAgentPath()
	if err != nil {
		return err
	}
	if !enable {
		err := os.Remove(path)
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>com.betterdesk.supportagent</string>
	<key>ProgramArguments</key><array><string>%s</string></array>
	<key>RunAtLoad</key><true/>
</dict>
</plist>
`, binPath)
	return os.WriteFile(path, []byte(plist), 0o644)
}
