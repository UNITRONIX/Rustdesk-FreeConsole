// Seal branding.json into an encrypted blob for release embeds.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/unitronix/betterdesk-support-agent/internal/brandprofile"
	"github.com/unitronix/betterdesk-support-agent/internal/brandseal"
)

func main() {
	in := flag.String("in", "resources/branding.json", "input branding JSON")
	out := flag.String("out", "", "output path (default: overwrite -in)")
	signingKeyFile := flag.String("signing-key-file", "", "Ed25519 PKCS#8 PEM or base64 private key file")
	publicKeyOut := flag.String("public-key-out", "resources/branding.pub", "output file for the signing public key")
	flag.Parse()
	if *out == "" {
		*out = *in
	}
	plain, err := os.ReadFile(*in)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read: %v\n", err)
		os.Exit(1)
	}
	if brandprofile.IsSigned(plain) || brandseal.IsSealed(plain) {
		fmt.Println("branding already sealed; skipping")
		return
	}
	if *signingKeyFile != "" {
		privateKey, err := loadPrivateKey(*signingKeyFile)
		if err != nil {
			fmt.Fprintf(os.Stderr, "signing key: %v\n", err)
			os.Exit(1)
		}
		signed, err := brandprofile.Sign(plain, privateKey)
		if err != nil {
			fmt.Fprintf(os.Stderr, "sign branding: %v\n", err)
			os.Exit(1)
		}
		encodedPublic, err := brandprofile.EncodePublicKey(privateKey.Public().(ed25519.PublicKey))
		if err != nil {
			fmt.Fprintf(os.Stderr, "encode signing public key: %v\n", err)
			os.Exit(1)
		}
		if err := os.WriteFile(*publicKeyOut, []byte(encodedPublic+"\n"), 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "write signing public key: %v\n", err)
			os.Exit(1)
		}
		if err := os.WriteFile(*out, signed, 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "write: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("signed branding → %s (%d bytes)\n", *out, len(signed))
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

func loadPrivateKey(path string) (ed25519.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if block, _ := pem.Decode(data); block != nil {
		parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("parse PKCS#8 PEM: %w", err)
		}
		key, ok := parsed.(ed25519.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("PEM key is not Ed25519")
		}
		return key, nil
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
	if err != nil {
		return nil, fmt.Errorf("decode base64 private key: %w", err)
	}
	if len(raw) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("invalid Ed25519 private key length")
	}
	return ed25519.PrivateKey(raw), nil
}
