// Seal branding.json into an encrypted blob for release embeds.
package main

import (
	"crypto/rand"
	"flag"
	"fmt"
	"os"

	"github.com/unitronix/betterdesk-support-agent/internal/brandseal"
)

func main() {
	in := flag.String("in", "resources/branding.json", "input branding JSON")
	out := flag.String("out", "", "output path (default: overwrite -in)")
	flag.Parse()
	if *out == "" {
		*out = *in
	}
	plain, err := os.ReadFile(*in)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read: %v\n", err)
		os.Exit(1)
	}
	if brandseal.IsSealed(plain) {
		fmt.Println("branding already sealed; skipping")
		return
	}
	salt := make([]byte, 32)
	if _, err := rand.Read(salt); err != nil {
		fmt.Fprintf(os.Stderr, "salt: %v\n", err)
		os.Exit(1)
	}
	sealed, err := brandseal.Seal(plain, salt)
	if err != nil {
		fmt.Fprintf(os.Stderr, "seal: %v\n", err)
		os.Exit(1)
	}
	if err := os.WriteFile(*out, sealed, 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "write: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("sealed branding → %s (%d bytes)\n", *out, len(sealed))
}
