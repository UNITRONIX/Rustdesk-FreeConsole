// Package sessioncore provides the transport-agnostic, passive-session
// lifecycle used by BetterDesk support targets.
//
// A Core represents one enrollment and support-session attempt. It intentionally
// owns policy and state only: callers supply server-grant verification and wire
// approved sessions to their transport separately.
package sessioncore
