// Signe le manifeste d'une version de l'agent (utilisé par GitHub Actions).
//
//	AGENT_SIGNING_KEY=<graine ed25519 en base64> go run ./outils/signer manifest.json > manifest.sig
package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage : signer manifest.json")
		os.Exit(2)
	}
	graine, err := base64.StdEncoding.DecodeString(strings.TrimSpace(os.Getenv("AGENT_SIGNING_KEY")))
	if err != nil || len(graine) != ed25519.SeedSize {
		fmt.Fprintln(os.Stderr, "AGENT_SIGNING_KEY absente ou invalide")
		os.Exit(1)
	}
	brut, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Print(base64.StdEncoding.EncodeToString(ed25519.Sign(ed25519.NewKeyFromSeed(graine), brut)))
}
