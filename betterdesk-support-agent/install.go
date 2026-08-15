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
	if err := copyLinuxUIBundle(src, dst); err != nil {
		return fmt.Errorf("copy binary: %w", err)
	}
	copyMesaCompanion(src, dst)
	if err := registerAutostart(dst); err != nil {
		return fmt.Errorf("register autostart: %w", err)
	}
	fmt.Printf("Installed to %s and registered autostart.\n", dst)
	return nil
}

// Uninstall removes autostart and installed binaries while preserving the
// agent's persistent state for a later reinstall.
func Uninstall() error {
	return uninstall(false)
}

// UninstallPurge removes autostart, installed binaries and persistent state.
// It is intentionally separate so normal uninstall cannot destroy enrollment
// identity or operator preferences.
func UninstallPurge() error {
	return uninstall(true)
}

func uninstall(purge bool) error {
	if err := unregisterAutostart(); err != nil {
		return fmt.Errorf("remove autostart: %w", err)
	}
	dst, err := installedBinaryPath()
	if err != nil {
		return err
	}
	installPath := filepath.Dir(dst)
	if purge {
		if err := os.RemoveAll(installPath); err != nil {
			return fmt.Errorf("remove install directory: %w", err)
		}
		if err := os.RemoveAll(stateDir()); err != nil {
			return fmt.Errorf("remove state directory: %w", err)
		}
	} else {
		for _, name := range []string{
			filepath.Base(dst),
			"betterdesk-support-x11",
			"betterdesk-support-wayland",
			"opengl32.dll",
			"libgallium_wgl.dll",
		} {
			if err := os.Remove(filepath.Join(installPath, name)); err != nil && !os.IsNotExist(err) {
				return fmt.Errorf("remove installed binary %s: %w", name, err)
			}
		}
		// Remove only an empty binary directory; any remaining operator files
		// are deliberately preserved.
		if err := os.Remove(installPath); err != nil && !os.IsNotExist(err) {
			fmt.Printf("Preserved non-empty install directory %s.\n", installPath)
		}
	}
	if purge {
		fmt.Println("Uninstalled autostart entry and purged state.")
	} else {
		fmt.Println("Uninstalled autostart entry; persistent state preserved.")
	}
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
	if err := os.Rename(tmp, dst); err == nil {
		return nil
	} else if runtime.GOOS == "windows" {
		// Windows cannot replace an existing executable with Rename. Remove
		// only the previous target after the new bytes are safely staged.
		if removeErr := os.Remove(dst); removeErr != nil && !os.IsNotExist(removeErr) {
			_ = os.Remove(tmp)
			return removeErr
		}
		if replaceErr := os.Rename(tmp, dst); replaceErr != nil {
			_ = os.Remove(tmp)
			return replaceErr
		}
		return nil
	} else {
		_ = os.Remove(tmp)
		return err
	}
}

// copyLinuxUIBundle installs the session launcher plus X11/Wayland UI binaries on Linux.
func copyLinuxUIBundle(src, dst string) error {
	if runtime.GOOS != "linux" {
		return copyExecutable(src, dst)
	}
	srcDir := filepath.Dir(src)
	x11 := filepath.Join(srcDir, "betterdesk-support-x11")
	wl := filepath.Join(srcDir, "betterdesk-support-wayland")
	launcher := filepath.Join(srcDir, "betterdesk-support")
	if _, err := os.Stat(x11); err != nil {
		return copyExecutable(src, dst)
	}
	installDir := filepath.Dir(dst)
	if err := copyExecutable(x11, filepath.Join(installDir, "betterdesk-support-x11")); err != nil {
		return err
	}
	if _, err := os.Stat(wl); err == nil {
		if err := copyExecutable(wl, filepath.Join(installDir, "betterdesk-support-wayland")); err != nil {
			return err
		}
	}
	script := launcher
	if st, err := os.Stat(launcher); err != nil || st.Mode()&0o111 == 0 {
		script = filepath.Join(srcDir, "scripts", "betterdesk-support-launcher.sh")
	}
	data, err := os.ReadFile(script)
	if err != nil {
		return copyExecutable(src, dst)
	}
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

// copyMesaCompanion copies the complete Mesa software-OpenGL DLL set beside the
// installed binary. Never copy opengl32.dll alone — it requires libgallium_wgl.dll.
func copyMesaCompanion(srcExe, dstExe string) {
	srcDir := filepath.Dir(srcExe)
	dstDir := filepath.Dir(dstExe)
	required := []string{"opengl32.dll", "libgallium_wgl.dll"}
	for _, name := range required {
		if _, err := os.Stat(filepath.Join(srcDir, name)); err != nil {
			return
		}
	}
	for _, name := range required {
		_ = copyExecutable(filepath.Join(srcDir, name), filepath.Join(dstDir, name))
	}
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
		hideConsole(cmd)
		_ = cmd.Run() // ignore "value not found"
		return nil
	}
	cmd := exec.Command("reg", "add", key, "/v", installAppName, "/t", "REG_SZ", "/d", binPath, "/f")
	hideConsole(cmd)
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
