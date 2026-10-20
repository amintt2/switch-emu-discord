package main

// Fenêtre et icône près de l'horloge. La fenêtre affiche une petite page servie par l'agent sur
// 127.0.0.1 (port au hasard, protégée par un jeton aléatoire) dans WebView2, le moteur web de Windows.

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	_ "embed"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"fyne.io/systray"
	webview2 "github.com/jchv/go-webview2"
)

//go:embed ui.html
var uiHTML []byte

//go:embed icone.png
var iconePNG []byte

type interfaceAgent struct {
	a       *Agent
	adresse string // http://127.0.0.1:port
	jeton   string
	mu      sync.Mutex
	ouverte bool
}

func demarrerInterface(a *Agent) (*interfaceAgent, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	b := make([]byte, 16)
	rand.Read(b)
	ui := &interfaceAgent{a: a, adresse: "http://" + l.Addr().String(), jeton: hex.EncodeToString(b)}
	mux := http.NewServeMux()
	mux.HandleFunc("/", ui.page)
	mux.HandleFunc("/icone.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write(iconePNG)
	})
	mux.HandleFunc("/api/etat", ui.proteger(func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(a.etatUI()) }))
	mux.HandleFunc("/api/action", ui.proteger(ui.action))
	go http.Serve(l, mux)
	return ui, nil
}

func (ui *interfaceAgent) url() string { return ui.adresse + "/?t=" + ui.jeton }

func (ui *interfaceAgent) page(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" || !ui.hoteLocal(r) {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(uiHTML)
}

// hoteLocal refuse les requêtes dont l'en-tête Host n'est pas notre adresse (protection DNS rebinding).
func (ui *interfaceAgent) hoteLocal(r *http.Request) bool {
	return "http://"+r.Host == ui.adresse
}

func (ui *interfaceAgent) proteger(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t := r.Header.Get("X-Jeton")
		if !ui.hoteLocal(r) || subtle.ConstantTimeCompare([]byte(t), []byte(ui.jeton)) != 1 {
			http.Error(w, "interdit", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		h(w, r)
	}
}

func (ui *interfaceAgent) action(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST attendu", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Action string `json:"action"`
		Valeur string `json:"valeur"`
	}
	json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req)
	a := ui.a
	var err error
	switch req.Action {
	case "lier":
		a.jumelerParNavigateur(ouvrirNavigateur)
	case "delier":
		err = a.delier()
	case "choisir-ryujinx":
		if p := choisirFichier("Où se trouve Ryujinx.exe ?", "Ryubing (Ryujinx.exe)|Ryujinx.exe"); p != "" {
			err = a.modifier(func(c *Config) { c.Ryujinx = p })
		}
	case "detecter-ryujinx":
		if p := detecterRyujinx(); p != "" {
			err = a.modifier(func(c *Config) { c.Ryujinx = p })
		}
	case "ajouter-dossier":
		if p := choisirDossier("Dossier où sont rangés tes jeux (.nsp / .xci)"); p != "" {
			err = a.modifier(func(c *Config) {
				for _, d := range c.DossiersJeux {
					if strings.EqualFold(d, p) {
						return
					}
				}
				c.DossiersJeux = append(c.DossiersJeux, p)
			})
		}
	case "retirer-dossier":
		err = a.modifier(func(c *Config) {
			var garde []string
			for _, d := range c.DossiersJeux {
				if d != req.Valeur {
					garde = append(garde, d)
				}
			}
			c.DossiersJeux = garde
		})
	case "rescanner":
		a.rescannerJeux()
	case "lancer":
		err = a.lancerJeu(req.Valeur)
	case "fermer-jeu":
		a.fermerJeu()
	case "demarrage":
		err = reglerDemarrageWindows(req.Valeur == "oui")
	case "ryubing-auto":
		err = a.modifier(func(c *Config) { c.RyubingManuel = req.Valeur != "oui" })
	case "maj-verifier":
		go a.verifierMaj(context.Background())
	case "maj-installer":
		go a.installerMaj()
	case "journal":
		ouvrirFichier(cheminJournal())
	case "vigem":
		ouvrirNavigateur("https://github.com/nefarius/ViGEmBus/releases/latest")
	case "quitter":
		go func() { time.Sleep(200 * time.Millisecond); a.quitter() }()
	default:
		http.Error(w, "action inconnue", http.StatusBadRequest)
		return
	}
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"erreur": err.Error()})
		return
	}
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// ouvrirFenetre affiche la fenêtre (une seule à la fois). Sans WebView2, la page s'ouvre dans le navigateur.
func (ui *interfaceAgent) ouvrirFenetre() {
	ui.mu.Lock()
	if ui.ouverte {
		ui.mu.Unlock()
		return
	}
	ui.ouverte = true
	ui.mu.Unlock()
	go func() {
		runtime.LockOSThread() // la fenêtre et sa boucle de messages vivent sur ce fil
		defer func() { ui.mu.Lock(); ui.ouverte = false; ui.mu.Unlock() }()
		w := webview2.NewWithOptions(webview2.WebViewOptions{
			AutoFocus:     true,
			DataPath:      filepath.Join(dossierDonnees(), "webview"),
			WindowOptions: webview2.WindowOptions{Title: "Switch EMU", Width: 520, Height: 720, Center: true},
		})
		if w == nil {
			ouvrirNavigateur(ui.url())
			return
		}
		w.Navigate(ui.url())
		w.Run()
		w.Destroy()
	}()
}

// --- Icône près de l'horloge

func (ui *interfaceAgent) lancerIcone(auDemarrage bool) {
	systray.Run(func() {
		systray.SetIcon(icoDepuisPNG(iconePNG))
		systray.SetTitle("Switch EMU")
		systray.SetTooltip("Switch EMU")
		systray.SetOnTapped(ui.ouvrirFenetre)
		ouvrir := systray.AddMenuItem("Ouvrir Switch EMU", "")
		etat := systray.AddMenuItem("…", "")
		etat.Disable()
		systray.AddSeparator()
		demarrage := systray.AddMenuItemCheckbox("Démarrer avec Windows", "", demarrageWindows())
		quitter := systray.AddMenuItem("Quitter", "")
		go func() {
			for {
				select {
				case <-ouvrir.ClickedCh:
					ui.ouvrirFenetre()
				case <-demarrage.ClickedCh:
					actif := !demarrageWindows()
					if reglerDemarrageWindows(actif) == nil {
						if actif {
							demarrage.Check()
						} else {
							demarrage.Uncheck()
						}
					}
				case <-quitter.ClickedCh:
					ui.a.quitter()
				case <-time.After(2 * time.Second):
					e := ui.a.etatUI()
					switch {
					case e["heberge"] == true:
						etat.SetTitle("En partie : tes amis voient ton écran")
					case e["connecte"] == true:
						etat.SetTitle("Connecté (" + e["compte"].(string) + ")")
					case e["lie"] == true:
						etat.SetTitle("Connexion au serveur…")
					default:
						etat.SetTitle("PC pas encore lié à Discord")
					}
				}
			}
		}()
		if !auDemarrage {
			ui.ouvrirFenetre()
		}
	}, func() {})
}

// icoDepuisPNG emballe une image PNG dans un fichier .ico (Windows accepte le PNG dans un .ico).
func icoDepuisPNG(png []byte) []byte {
	var b bytes.Buffer
	binary.Write(&b, binary.LittleEndian, [3]uint16{0, 1, 1}) // réservé, type icône, 1 image
	b.Write([]byte{0, 0, 0, 0})                               // largeur/hauteur 256 (0), couleurs, réservé
	binary.Write(&b, binary.LittleEndian, [2]uint16{1, 32})   // plans, bits par pixel
	binary.Write(&b, binary.LittleEndian, [2]uint32{uint32(len(png)), 22})
	b.Write(png)
	return b.Bytes()
}

// --- Petits outils Windows

func ouvrirNavigateur(url string) {
	if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://127.0.0.1:") && !strings.HasPrefix(url, "http://localhost:") {
		return
	}
	exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

func ouvrirFichier(chemin string) {
	if _, err := os.Stat(chemin); err == nil {
		exec.Command("explorer", "/select,", chemin).Start()
	}
}

// Les sélecteurs de Windows, par un petit script PowerShell fixe (aucune donnée extérieure n'y entre).
func powershellDialogue(script string) string {
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		log.Printf("sélecteur : %v", err)
		return ""
	}
	return strings.TrimSpace(string(out))
}

func choisirDossier(titre string) string {
	return powershellDialogue(`Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '` +
		strings.ReplaceAll(titre, "'", "''") + `'; if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $d.SelectedPath }`)
}

func choisirFichier(titre, filtre string) string {
	return powershellDialogue(`Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = '` +
		strings.ReplaceAll(titre, "'", "''") + `'; $d.Filter = '` + strings.ReplaceAll(filtre, "'", "''") +
		`'; if ($d.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [Text.Encoding]::UTF8; $d.FileName }`)
}
