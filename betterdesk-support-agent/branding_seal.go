package main

import "github.com/unitronix/betterdesk-support-agent/internal/brandseal"

func sealBranding(plaintext, salt []byte) ([]byte, error) {
	return brandseal.Seal(plaintext, salt)
}

func unsealBranding(blob []byte) ([]byte, error) {
	return brandseal.Unseal(blob)
}

func isSealedBranding(blob []byte) bool {
	return brandseal.IsSealed(blob)
}
