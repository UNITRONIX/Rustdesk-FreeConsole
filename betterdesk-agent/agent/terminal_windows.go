//go:build windows

package agent

import (
	"io"
	"log"
	"os"
	"os/exec"
)

// StartTerminal spawns a shell on Windows using pipes (no PTY).
func StartTerminal(id string, cols, rows int, shell string, onOutput func([]byte)) (*TerminalSession, error) {
	if shell == "" {
		shell = os.Getenv("COMSPEC")
		if shell == "" {
			shell = "cmd.exe"
		}
	}

	cmd := exec.Command(shell, "/Q")
	cmd.Env = os.Environ()
	// Pipe-based terminals do not need a visible console. Without this flag a
	// session that accidentally reaches this shared path flashes cmd.exe over
	// the user's desktop and can itself be captured by remote support.
	hideConsole(cmd)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	readPipe := func(r io.ReadCloser) {
		buf := make([]byte, 8192)
		for {
			n, readErr := r.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				onOutput(chunk)
			}
			if readErr != nil {
				break
			}
		}
	}

	go readPipe(stdout)
	go readPipe(stderr)

	ts := &TerminalSession{
		ID: id,
		writeFn: func(data []byte) error {
			_, err := stdin.Write(data)
			return err
		},
		resizeFn: func(c, r int) error {
			// Windows pipes do not support resize. ConPTY would be needed.
			log.Printf("[terminal:%s] Resize not supported on Windows pipes", id)
			return nil
		},
		closeFn: func() error {
			stdin.Close()
			return cmd.Process.Kill()
		},
	}
	return ts, nil
}
