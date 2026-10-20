package main

import (
	"errors"
	"strings"
	"testing"
)

func TestSansJeton(t *testing.T) {
	err := errors.New(`Get "wss://relais/relais?jeton=eyJhIjoxfQ.c2ln": refusée`)
	if s := sansJeton(err); strings.Contains(s, "eyJ") || !strings.Contains(s, "jeton=…") {
		t.Fatal(s)
	}
}
