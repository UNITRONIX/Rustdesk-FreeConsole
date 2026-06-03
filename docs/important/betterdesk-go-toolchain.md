# BetterDesk Go Toolchain
- This workspace initially had no system `go`/`gofmt`; `sudo dnf` is blocked by `no_new_privileges`.
- Local Go 1.25.0 was installed at `$HOME/.local/share/betterdesk-tools/go1.25.0`.
- For BetterDesk server tests, use: `export PATH="$HOME/.local/share/betterdesk-tools/go1.25.0/bin:$PATH"` and `export GOTOOLCHAIN=local` before `go test`.# BetterDesk Go Toolchain
- This workspace initially had no system `go`/`gofmt`; `sudo dnf` is blocked by `no_new_privileges`.
- Local Go 1.25.0 was installed at `$HOME/.local/share/betterdesk-tools/go1.25.0`.
- For BetterDesk server tests, use: `export PATH="$HOME/.local/share/betterdesk-tools/go1.25.0/bin:$PATH"` and `export GOTOOLCHAIN=local` before `go test`.
