package main

// Son du jeu : son.exe (dossier capteur/) capture le son de Ryubing seul (pas celui de Discord :
// les amis n'entendent pas leur propre voix en écho), en PCM 48 kHz stéréo, par paquets de ~10 ms :
//   u32 taille | i64 position µs | PCM 16 bits entrelacé
// L'agent suit le processus de Ryubing : son.exe est relancé si Ryubing est relancé.

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"log"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	drapeauSon   = 0x02          // dans l'en-tête des paquets binaires : son (et pas image)
	tailleMaxSon = 48000 * 4 / 2 // 500 ms : bien plus qu'un paquet normal
)

type capteurSon struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	paquets chan []byte
}

func lancerSon(ctx context.Context, exe string, pid uint32) (*capteurSon, error) {
	cmd := exec.CommandContext(ctx, exe, strconv.FormatUint(uint64(pid), 10))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	cmd.Stderr = logWriter{"son"}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	s := &capteurSon{cmd: cmd, stdin: in, paquets: make(chan []byte, 16)}
	go s.lire(bufio.NewReaderSize(out, 64<<10))
	return s, nil
}

func (s *capteurSon) lire(r io.Reader) {
	defer close(s.paquets)
	hdr := make([]byte, 12)
	for {
		if _, err := io.ReadFull(r, hdr); err != nil {
			return
		}
		n := binary.LittleEndian.Uint32(hdr)
		if n > tailleMaxSon || n%4 != 0 {
			log.Printf("son : paquet invalide (%d octets), arrêt", n)
			return
		}
		pcm := make([]byte, n)
		if _, err := io.ReadFull(r, pcm); err != nil {
			return
		}
		select {
		case s.paquets <- pcm:
		default: // personne ne suit : un trou dans le son plutôt que du retard
		}
	}
}

func (s *capteurSon) arreter() {
	io.WriteString(s.stdin, "quit\n")
	s.stdin.Close()
	fini := make(chan struct{})
	go func() { s.cmd.Wait(); close(fini) }()
	select {
	case <-fini:
	case <-time.After(time.Second):
		s.cmd.Process.Kill()
	}
}

// encoderSon prépare un paquet de son pour le relais (envoyé à tous les amis).
func encoderSon(t time.Time, pcm []byte) []byte {
	b := make([]byte, enteteImage+len(pcm))
	b[4] = drapeauSon
	binary.LittleEndian.PutUint64(b[6:], math.Float64bits(heureMs(t)))
	copy(b[enteteImage:], pcm)
	return b
}

// exeSon : son.exe à côté du capteur.
func exeSon(exeCapteur string) string { return filepath.Join(filepath.Dir(exeCapteur), "son.exe") }

// suivreSon fait tourner son.exe sur le processus de Ryubing tant que la partie dure ; chaque paquet
// part dans sortie. Sans son.exe (ancienne installation), la partie continue sans le son.
func suivreSon(ctx context.Context, exe string, sortie chan<- []byte) {
	if _, err := os.Stat(exe); err != nil {
		log.Printf("son : %s introuvable, partie sans le son", exe)
		return
	}
	var s *capteurSon
	var pid uint32
	defer func() {
		if s != nil {
			s.arreter()
		}
	}()
	// Ryubing lancé, relancé ou fermé : on suit son processus (vérifié toutes les 2 s).
	verifier := func() {
		p, _ := trouverRyubing()
		if p == pid && (s != nil || p == 0) {
			return
		}
		if s != nil {
			s.arreter()
			s = nil
		}
		pid = p
		if p != 0 {
			var err error
			if s, err = lancerSon(ctx, exe, p); err != nil {
				log.Printf("son : %v", err)
				s = nil
			}
		}
	}
	verifier()
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		var paquets <-chan []byte
		if s != nil {
			paquets = s.paquets
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			verifier()
		case pcm, ok := <-paquets:
			if !ok {
				s.arreter()
				s = nil // son.exe s'est arrêté : relancé à la prochaine vérification
				continue
			}
			select {
			case sortie <- pcm:
			default:
			}
		}
	}
}

var errPasDeRyubing = errors.New("Ryubing n'est pas lancé")

// trouverRyubing renvoie le processus Ryujinx.exe en cours (0 s'il n'y en a pas).
func trouverRyubing() (uint32, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		if strings.EqualFold(windows.UTF16ToString(e.ExeFile[:]), "Ryujinx.exe") {
			return e.ProcessID, nil
		}
	}
	return 0, errPasDeRyubing
}
