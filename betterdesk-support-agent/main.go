// BetterDesk Support Agent — lightweight quick-help remote desktop agent.
//
// Single Go binary that serves two distribution forms from one codebase:
//
//   - Installer form: registered as an autostarting background service that
//     presents a minimal "quick help" window (request help, show access
//     password, supervised/unattended access, custom password).
//   - Portable form: the exact same binary run directly, no installation.
//
// The remote-desktop engine is reused from the betterdesk-agent module.
package main

import (
	"flag"
	"fmt"
	"os"
)

var version = "0.1.0"

func main() {
	var (
		showVer   = flag.Bool("version", false, "Print version and exit")
		doInstall = flag.Bool("install", false, "Install to a per-user location and enable autostart")
		doUninst  = flag.Bool("uninstall", false, "Remove autostart entry and installed binary")
		doReset   = flag.Bool("reset-enrollment", false, "Clear local enrollment state and exit")
		noGUI     = flag.Bool("nogui", false, "Run without graphical interface (no window)")
	)
	flag.Parse()

	prepWindowsGraphics()
	prepLinuxDisplay()

	if *showVer {
		fmt.Printf("betterdesk-support-agent %s\n", version)
		os.Exit(0)
	}

	if *doInstall {
		if err := Install(); err != nil {
			fmt.Fprintf(os.Stderr, "install failed: %v\n", err)
			os.Exit(1)
		}
		os.Exit(0)
	}

	if *doUninst {
		if err := Uninstall(); err != nil {
			fmt.Fprintf(os.Stderr, "uninstall failed: %v\n", err)
			os.Exit(1)
		}
		os.Exit(0)
	}

	if *doReset {
		if err := ResetEnrollmentState(); err != nil {
			fmt.Fprintf(os.Stderr, "reset-enrollment failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Local enrollment state cleared.")
		os.Exit(0)
	}

	if *noGUI || os.Getenv("BETTERDESK_SUPPORT_NOGUI") == "1" {
		runHeadless()
		return
	}

	run()
}
