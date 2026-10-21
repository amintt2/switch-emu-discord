package main

import "testing"

func TestCaptureCouches(t *testing.T) {
	base := Capture{Largeur: 1920, Hauteur: 1080, IPS: 60, Kbps: 12000, Codec: "h264_amf"}
	if c := captureCouche(base, coucheHaute); c != base {
		t.Fatal("1080p : le réglage de capture tel quel", c)
	}
	if c := captureCouche(base, coucheBasse); c.Largeur != 1280 || c.Codec != "h264_amf" || c.Kbps != kbpsBasse {
		t.Fatal("720p H.264", c)
	}
	// Lecteurs sans H.264 (certains Discord) : VP8 encodé par le processeur.
	if c := captureCouche(base, coucheCompat); c.Codec != "libvpx" || c.Largeur != 1280 || c.Hauteur != 720 || c.Kbps != kbpsCompat {
		t.Fatal("couche de compatibilité VP8", c)
	}
}
