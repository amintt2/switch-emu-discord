package main

// Pilote capteur.exe (dossier capteur/) : capture DXGI + encodage matériel, une image par paquet sur stdout :
//   u32 taille | u8 drapeaux (bit0 = clé) | i64 t_affichage_us | i64 t_sortie_us | Annex B
// Commandes sur stdin : "idr", "bitrate <kbit/s>", "quit".

import (
	"bufio"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"time"
)

type image struct {
	au      []byte
	cle     bool
	capture time.Time
}

type capteur struct {
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	mu         sync.Mutex
	images     chan image
	dernierIDR time.Time
}

func lancerCapteur(ctx context.Context, exe string, c Capture) (*capteur, error) {
	args := []string{"--output", strconv.Itoa(c.Ecran), "--fps", strconv.Itoa(c.IPS), "--kbps", strconv.Itoa(c.Kbps), "--codec", c.Codec}
	if c.Largeur > 0 && c.Hauteur > 0 {
		args = append(args, "--width", strconv.Itoa(c.Largeur), "--height", strconv.Itoa(c.Hauteur))
	}
	if c.Fenetre != "" {
		args = append(args, "--window", c.Fenetre)
	}
	cmd := exec.CommandContext(ctx, exe, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	cmd.Stderr = logWriter{"capteur"}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("impossible de lancer %s : %w", exe, err)
	}
	k := &capteur{cmd: cmd, stdin: in, images: make(chan image, 4)}
	go k.lire(bufio.NewReaderSize(out, 1<<20))
	return k, nil
}

func (k *capteur) lire(r io.Reader) {
	defer close(k.images)
	hdr := make([]byte, 21)
	debut := time.Now()
	qpcDebut := int64(-1)
	for {
		if _, err := io.ReadFull(r, hdr); err != nil {
			return
		}
		n := binary.LittleEndian.Uint32(hdr)
		if n > 16<<20 {
			log.Printf("capteur : paquet trop gros (%d octets), arrêt", n)
			return
		}
		au := make([]byte, n)
		if _, err := io.ReadFull(r, au); err != nil {
			return
		}
		// Heure de capture : on convertit l'horloge du capteur (µs QPC) en heure murale.
		sortie := int64(binary.LittleEndian.Uint64(hdr[13:]))
		affiche := int64(binary.LittleEndian.Uint64(hdr[5:]))
		if qpcDebut < 0 {
			qpcDebut = sortie
			debut = time.Now()
		}
		t := debut.Add(time.Duration(sortie-qpcDebut) * time.Microsecond)
		if affiche > 0 && affiche < sortie {
			t = t.Add(-time.Duration(sortie-affiche) * time.Microsecond)
		}
		select {
		case k.images <- image{au: au, cle: hdr[4]&1 == 1, capture: t}:
		default:
			// Personne ne suit : on jette et on redemandera une image clé.
			k.demanderIDR()
		}
	}
}

// demanderIDR demande une image clé, au plus 2 fois par seconde.
func (k *capteur) demanderIDR() {
	k.mu.Lock()
	defer k.mu.Unlock()
	if time.Since(k.dernierIDR) < 500*time.Millisecond {
		return
	}
	k.dernierIDR = time.Now()
	io.WriteString(k.stdin, "idr\n")
}

func (k *capteur) debit(kbps int) {
	k.mu.Lock()
	defer k.mu.Unlock()
	fmt.Fprintf(k.stdin, "bitrate %d\n", kbps)
}

func (k *capteur) arreter() {
	k.mu.Lock()
	io.WriteString(k.stdin, "quit\n")
	k.stdin.Close()
	k.mu.Unlock()
	done := make(chan struct{})
	go func() { k.cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		k.cmd.Process.Kill()
	}
}

type logWriter struct{ prefixe string }

func (w logWriter) Write(p []byte) (int, error) {
	log.Printf("%s: %s", w.prefixe, trimNL(string(p)))
	return len(p), nil
}

func trimNL(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}
