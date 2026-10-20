// Switch EMU — l'agent du PC de l'hôte. Il se connecte EN SORTANT au serveur (aucun port à ouvrir) ;
// quand l'hôte clique « Héberger » dans l'Activité, il capture l'écran, l'envoie au relais, et crée une
// manette virtuelle pour chaque ami. Il vit près de l'horloge, avec une petite fenêtre de réglages.
//
//	SwitchEMU.exe                 application normale (s'installe au premier lancement)
//	SwitchEMU.exe -demarrage      lancé avec Windows : seulement l'icône, sans ouvrir la fenêtre
//	SwitchEMU.exe -console        sans fenêtre ni installation (développement)
//	SwitchEMU.exe -test-manette   vérifie les manettes virtuelles puis quitte
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"

	"fyne.io/systray"
	"golang.org/x/sys/windows"
)

var version = "dev"

func cheminJournal() string { return filepath.Join(dossierDonnees(), "agent.log") }

func main() {
	chemin := flag.String("config", cheminConfig(), "fichier de configuration")
	serveur := flag.String("serveur", "", "adresse du serveur (remplace celle de la configuration)")
	exeCapteur := flag.String("capteur", "", "chemin de capteur.exe (par défaut : à côté de l'agent)")
	dev := flag.Bool("dev", false, "essais en local : accepte un relais en ws://localhost")
	console := flag.Bool("console", false, "sans fenêtre ni installation (développement)")
	demarrage := flag.Bool("demarrage", false, "lancé avec Windows : seulement l'icône près de l'horloge")
	testManette := flag.Bool("test-manette", false, "branche une manette virtuelle, appuie sur A, vérifie que Windows la voit, puis quitte")
	installer := flag.String("installer", "", "usage interne : installe cette version dans ce dossier")
	attendre := flag.Int("attendre", 0, "usage interne : attend la fin de ce processus avant d'installer")
	flag.Parse()

	// Journal : dans un fichier (l'application n'a pas de console), et à l'écran en mode console.
	os.MkdirAll(dossierDonnees(), 0o755)
	if info, err := os.Stat(cheminJournal()); err == nil && info.Size() > 5<<20 {
		os.Rename(cheminJournal(), cheminJournal()+".ancien")
	}
	if f, err := os.OpenFile(cheminJournal(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
		log.SetOutput(io.MultiWriter(f, os.Stderr)) // le fichier d'abord : en mode fenêtre, il n'y a pas de console
	}
	log.SetFlags(log.Ldate | log.Ltime)
	log.Printf("Switch EMU %s", version)

	if *installer != "" {
		if err := modeInstallateur(*installer, *attendre); err != nil {
			log.Fatal(err)
		}
		return
	}

	// Manettes virtuelles des amis (pilote ViGEmBus).
	var bus busManettes
	if v, err := OpenViGEm(); err != nil {
		log.Printf("manettes virtuelles indisponibles : %v", err)
	} else {
		bus = busViGEm{v}
		defer v.Close()
	}
	if *testManette {
		os.Exit(autoTestManette(bus))
	}

	// Premier lancement depuis un zip : on s'installe dans %LOCALAPPDATA%\SwitchEMU\app et on se relance.
	if !*console && !*dev && version != "dev" && !estInstalle() {
		if err := modeInstallateur(dossierApp(), 0); err != nil {
			log.Fatal(err)
		}
		reglerDemarrageWindows(true)
		return
	}

	// Une seule instance : la deuxième se contente d'ouvrir la fenêtre de la première.
	if !*console {
		nom, _ := windows.UTF16PtrFromString(`Local\SwitchEMU-agent`)
		if _, err := windows.CreateMutex(nil, false, nom); err == windows.ERROR_ALREADY_EXISTS {
			if b, err := os.ReadFile(filepath.Join(dossierDonnees(), "fenetre.url")); err == nil {
				ouvrirNavigateur(string(b))
			}
			return
		}
	}

	cfg, err := chargerConfig(*chemin)
	if err != nil {
		log.Fatalf("configuration illisible (%s) : %v", *chemin, err)
	}
	if *serveur != "" {
		cfg.Serveur = *serveur
	}
	cfg.dev = *dev
	if *exeCapteur == "" {
		*exeCapteur = filepath.Join(dossierExe(), "capteur.exe")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	a := nouvelAgent(*chemin, cfg, *exeCapteur, bus)
	go a.boucle(ctx)
	go a.surveillerMaj(ctx)

	if *console {
		a.quitter = stop
		if cfg.Jeton == "" {
			a.jumelerParNavigateur(func(url string) {
				fmt.Printf("\nOuvre cette page pour lier ce PC à ton compte Discord :\n  %s\n\n", url)
			})
		}
		<-ctx.Done()
		return
	}

	ui, err := demarrerInterface(a)
	if err != nil {
		log.Fatal(err)
	}
	os.WriteFile(filepath.Join(dossierDonnees(), "fenetre.url"), []byte(ui.url()), 0o600)
	a.quitter = func() { stop(); systray.Quit() }
	go func() { <-ctx.Done(); systray.Quit() }()
	ui.lancerIcone(*demarrage) // bloque jusqu'à « Quitter »
}
