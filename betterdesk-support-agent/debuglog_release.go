//go:build release

package main

// debugLog is intentionally compiled out of release builds. Diagnostic logs
// can include endpoint and device metadata that is not needed at runtime.
func debugLog(string, string, string, map[string]any) {}
