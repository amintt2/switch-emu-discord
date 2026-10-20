package main

// Bibliothèque de jeux de l'hôte : les fichiers .nsp / .xci de ses dossiers (ses propres dumps).
// Seuls un identifiant et un titre partent vers le serveur ; le chemin des fichiers reste sur ce PC.
// L'agent ne lance que des fichiers de cette liste : jamais un chemin reçu de l'extérieur.

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
)

type jeu struct {
	ID     string `json:"id"`
	Titre  string `json:"titre"`
	Chemin string `json:"-"`
	Taille int64  `json:"taille"`
}

var extensionsJeux = map[string]bool{".nsp": true, ".xci": true, ".nsz": true, ".xcz": true}

const (
	profondeurMax = 4
	tailleMin     = 20 << 20 // les mises à jour et DLC font souvent quelques Mo
	maxJeux       = 500
)

var (
	reCrochets    = regexp.MustCompile(`\[[^\]]*\]|\([^)]*\)|\{[^}]*\}`)
	reEspaces     = regexp.MustCompile(`[\s._]+`)
	reMiseAJour   = regexp.MustCompile(`(?i)\[(upd|update|dlc)\]|\b(update|dlc|mise à jour)\b|\[v[1-9]\d*\]`)
	reIDDeContenu = regexp.MustCompile(`\[01[0-9A-Fa-f]{14}\]`) // identifiant de titre : 16 chiffres hexadécimaux
)

// titreDepuisFichier : « Mario Kart 8 Deluxe [0100152000022000][v0].nsp » → « Mario Kart 8 Deluxe ».
func titreDepuisFichier(nom string) string {
	t := strings.TrimSuffix(nom, filepath.Ext(nom))
	t = reCrochets.ReplaceAllString(t, " ")
	t = reEspaces.ReplaceAllString(t, " ")
	t = strings.Trim(t, " -")
	if t == "" {
		return nom
	}
	return t
}

// estMiseAJourOuDLC repère les fichiers qui ne sont pas un jeu à lancer.
func estMiseAJourOuDLC(nom string) bool {
	if reMiseAJour.MatchString(nom) {
		return true
	}
	// Identifiant de contenu : les jeux finissent par 000, les mises à jour par 800, les DLC autrement.
	if m := reIDDeContenu.FindString(nom); m != "" {
		fin := strings.ToUpper(m[len(m)-4 : len(m)-1])
		return fin != "000"
	}
	return false
}

func idJeu(chemin string) string {
	h := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(chemin))))
	return hex.EncodeToString(h[:8])
}

// scannerJeux parcourt les dossiers (sans suivre les liens) et renvoie les jeux triés par titre.
func scannerJeux(dossiers []string) []jeu {
	vus := map[string]bool{}
	jeux := []jeu{}
	for _, racine := range dossiers {
		racine = filepath.Clean(racine)
		profondeur := strings.Count(racine, string(os.PathSeparator))
		filepath.WalkDir(racine, func(chemin string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if strings.Count(chemin, string(os.PathSeparator))-profondeur >= profondeurMax {
					return filepath.SkipDir
				}
				return nil
			}
			if !extensionsJeux[strings.ToLower(filepath.Ext(chemin))] || estMiseAJourOuDLC(d.Name()) {
				return nil
			}
			info, err := d.Info()
			if err != nil || info.Size() < tailleMin {
				return nil
			}
			id := idJeu(chemin)
			if vus[id] || len(jeux) >= maxJeux {
				return nil
			}
			vus[id] = true
			jeux = append(jeux, jeu{ID: id, Titre: titreDepuisFichier(d.Name()), Chemin: chemin, Taille: info.Size()})
			return nil
		})
	}
	sort.Slice(jeux, func(i, j int) bool { return strings.ToLower(jeux[i].Titre) < strings.ToLower(jeux[j].Titre) })
	return jeux
}

// detecterRyujinx cherche Ryujinx.exe (Ryubing) aux endroits habituels.
func detecterRyujinx() string {
	var candidats []string
	for _, base := range []string{os.Getenv("LOCALAPPDATA"), os.Getenv("ProgramFiles"), `C:\Jeux`, `C:\Games`, `D:\Jeux`, `D:\Games`} {
		if base == "" {
			continue
		}
		for _, sous := range []string{"Ryubing", "Ryujinx", `Programs\Ryubing`, `Programs\Ryujinx`, `Ryubing\publish`, `Ryujinx\publish`} {
			candidats = append(candidats, filepath.Join(base, sous, "Ryujinx.exe"))
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		for _, d := range []string{"Downloads", "Téléchargements", "Desktop", "Bureau", "Documents"} {
			motifs, _ := filepath.Glob(filepath.Join(home, d, "*", "Ryujinx.exe"))
			candidats = append(candidats, motifs...)
			motifs, _ = filepath.Glob(filepath.Join(home, d, "*", "*", "Ryujinx.exe"))
			candidats = append(candidats, motifs...)
		}
	}
	for _, c := range candidats {
		if info, err := os.Stat(c); err == nil && !info.IsDir() {
			return c
		}
	}
	return ""
}

var errPasDeRyujinx = errors.New("Ryubing introuvable : indique où se trouve Ryujinx.exe dans la fenêtre de l'agent")

// commandeJeu prépare le lancement de Ryubing en plein écran avec le jeu (aucune autre option).
func commandeJeu(ryujinx string, j jeu) (*exec.Cmd, error) {
	if ryujinx == "" || !strings.EqualFold(filepath.Base(ryujinx), "Ryujinx.exe") {
		return nil, errPasDeRyujinx
	}
	if _, err := os.Stat(ryujinx); err != nil {
		return nil, errPasDeRyujinx
	}
	cmd := exec.Command(ryujinx, "--fullscreen", j.Chemin)
	cmd.Dir = filepath.Dir(ryujinx)
	cmd.SysProcAttr = &syscall.SysProcAttr{}
	return cmd, nil
}
