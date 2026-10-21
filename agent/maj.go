package main

// Mises à jour automatiques : chaque version de l'agent est compilée par GitHub Actions et publiée sur
// la page « Releases » du dépôt avec un manifeste (version, empreinte SHA-256 du zip) signé par une clé
// privée que seul GitHub connaît. L'agent n'installe une version que si la signature est valide avec la
// clé publique ci-dessous et que l'empreinte du zip correspond.

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	clePubliqueMaj = "fge8DKsjr6YF9uDv0WAqgRYz2RpPkxnQyxGFs6B7FeM="
	urlDerniere    = "https://api.github.com/repos/amintt2/switch-emu-discord/releases/latest"
	tailleMaxMaj   = 500 << 20
	nomExe         = "SwitchEMU.exe"
)

type manifeste struct {
	Version string `json:"version"`
	Fichier string `json:"fichier"`
	SHA256  string `json:"sha256"`
	Taille  int64  `json:"taille"`
}

var errSignature = errors.New("signature de la mise à jour invalide")

// verifierManifeste contrôle la signature (base64) du manifeste brut puis le lit.
func verifierManifeste(brut []byte, signature string, cle string) (manifeste, error) {
	var m manifeste
	pub, err := base64.StdEncoding.DecodeString(cle)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return m, errors.New("clé publique invalide")
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signature))
	if err != nil || !ed25519.Verify(ed25519.PublicKey(pub), brut, sig) {
		return m, errSignature
	}
	if err := json.Unmarshal(brut, &m); err != nil {
		return m, err
	}
	if m.Version == "" || len(m.SHA256) != 64 || m.Taille <= 0 || m.Taille > tailleMaxMaj || strings.ContainsAny(m.Fichier, `/\`) {
		return m, errors.New("manifeste incomplet")
	}
	return m, nil
}

// versionPlusRecente compare « 0.4.10 » et « 0.4.9 » (un « v » ou « agent-v » devant est ignoré).
func versionPlusRecente(candidate, actuelle string) bool {
	parse := func(v string) []int {
		v = strings.TrimPrefix(strings.TrimPrefix(v, "agent-"), "v")
		var r []int
		for _, p := range strings.Split(strings.SplitN(v, "-", 2)[0], ".") {
			n, err := strconv.Atoi(p)
			if err != nil {
				return nil
			}
			r = append(r, n)
		}
		return r
	}
	a, b := parse(candidate), parse(actuelle)
	if a == nil {
		return false
	}
	if b == nil { // version « dev » : toute version publiée est plus récente
		return true
	}
	for i := 0; i < len(a) || i < len(b); i++ {
		x, y := 0, 0
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

type versionPubliee struct {
	m      manifeste
	urlZip string
}

var clientMaj = &http.Client{Timeout: 10 * time.Minute}

// accepterPour : l'API de GitHub (JSON) refuse « octet-stream » (erreur 415) ; les fichiers le veulent.
func accepterPour(url string) string {
	if strings.HasPrefix(url, "https://api.github.com/") {
		return "application/vnd.github+json"
	}
	return "application/octet-stream"
}

func telecharger(ctx context.Context, url string, max int64) ([]byte, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("User-Agent", "SwitchEMU-agent/"+version)
	req.Header.Set("Accept", accepterPour(url))
	res, err := clientMaj.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("téléchargement refusé (%d)", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, max+1))
	if int64(len(b)) > max {
		return nil, errors.New("fichier trop gros")
	}
	return b, err
}

// chercherMaj lit la dernière version publiée. Renvoie nil s'il n'y a rien de plus récent.
func chercherMaj(ctx context.Context) (*versionPubliee, error) {
	b, err := telecharger(ctx, urlDerniere, 1<<20)
	if err != nil {
		return nil, err
	}
	var rel struct {
		Assets []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(b, &rel); err != nil {
		return nil, err
	}
	urls := map[string]string{}
	for _, a := range rel.Assets {
		urls[a.Name] = a.URL
	}
	if urls["manifest.json"] == "" || urls["manifest.sig"] == "" {
		return nil, errors.New("la dernière version n'a pas de manifeste signé")
	}
	brut, err := telecharger(ctx, urls["manifest.json"], 64<<10)
	if err != nil {
		return nil, err
	}
	sig, err := telecharger(ctx, urls["manifest.sig"], 4<<10)
	if err != nil {
		return nil, err
	}
	m, err := verifierManifeste(brut, string(sig), clePubliqueMaj)
	if err != nil {
		return nil, err
	}
	if !versionPlusRecente(m.Version, version) {
		return nil, nil
	}
	if urls[m.Fichier] == "" {
		return nil, errors.New("fichier de la mise à jour absent")
	}
	return &versionPubliee{m: m, urlZip: urls[m.Fichier]}, nil
}

// preparerMaj télécharge et vérifie le zip, puis l'extrait dans un dossier neuf. Renvoie ce dossier.
func preparerMaj(ctx context.Context, v *versionPubliee) (string, error) {
	b, err := telecharger(ctx, v.urlZip, tailleMaxMaj)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(b)
	if int64(len(b)) != v.m.Taille || !strings.EqualFold(hex.EncodeToString(h[:]), v.m.SHA256) {
		return "", errors.New("le fichier téléchargé ne correspond pas au manifeste signé")
	}
	dest := filepath.Join(dossierDonnees(), "maj", v.m.Version)
	os.RemoveAll(dest)
	if err := extraireZip(b, dest); err != nil {
		return "", err
	}
	if _, err := os.Stat(filepath.Join(dest, nomExe)); err != nil {
		return "", errors.New("la mise à jour ne contient pas " + nomExe)
	}
	return dest, nil
}

// extraireZip refuse les chemins qui sortiraient du dossier (« zip slip »).
func extraireZip(b []byte, dest string) error {
	r, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return err
	}
	dest = filepath.Clean(dest)
	for _, f := range r.File {
		cible := filepath.Join(dest, f.Name)
		if !strings.HasPrefix(cible, dest+string(os.PathSeparator)) {
			return fmt.Errorf("chemin interdit dans la mise à jour : %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			os.MkdirAll(cible, 0o755)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(cible), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.Create(cible)
		if err == nil {
			_, err = io.Copy(out, io.LimitReader(rc, tailleMaxMaj))
			out.Close()
		}
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// lancerInstallation démarre la nouvelle version en mode « installateur » : elle attend que celle-ci se
// ferme, copie ses fichiers dans le dossier de l'application, puis se relance depuis là.
func lancerInstallation(dossierMaj string) error {
	cmd := exec.Command(filepath.Join(dossierMaj, nomExe), "-installer", dossierApp(), "-attendre", strconv.Itoa(os.Getpid()))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Start()
}

// --- Côté application : vérifier régulièrement, installer tout seul quand aucune partie n'est en cours.

func (a *Agent) verifierMaj(ctx context.Context) *versionPubliee {
	a.mu.Lock()
	a.majEtat = "Recherche d'une mise à jour…"
	a.mu.Unlock()
	v, err := chercherMaj(ctx)
	a.mu.Lock()
	defer a.mu.Unlock()
	switch {
	case err != nil:
		a.majEtat = "Vérification impossible : " + err.Error()
	case v == nil:
		a.majEtat = "À jour"
		a.majDispo = nil
	default:
		a.majEtat = "Version " + v.m.Version + " disponible"
		a.majDispo = v
	}
	return v
}

func (a *Agent) installerMaj() {
	a.mu.Lock()
	v, enPartie := a.majDispo, a.salle != ""
	a.mu.Unlock()
	if v == nil {
		return
	}
	if enPartie {
		a.mu.Lock()
		a.majEtat = "Version " + v.m.Version + " : installée après la partie"
		a.mu.Unlock()
		return
	}
	a.mu.Lock()
	a.majEtat = "Téléchargement de la version " + v.m.Version + "…"
	a.mu.Unlock()
	dir, err := preparerMaj(context.Background(), v)
	if err == nil {
		err = lancerInstallation(dir)
	}
	if err != nil {
		a.mu.Lock()
		a.majEtat = "Mise à jour impossible : " + err.Error()
		a.mu.Unlock()
		return
	}
	log.Printf("mise à jour vers %s : redémarrage", v.m.Version)
	a.quitter()
}

// surveillerMaj vérifie au démarrage puis toutes les 6 heures, et installe dès qu'aucune partie n'est en cours.
func (a *Agent) surveillerMaj(ctx context.Context) {
	if version == "dev" || !estInstalle() {
		return // version de développement ou lancée hors installation : pas de mise à jour automatique
	}
	attente := time.Minute
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(attente):
		}
		attente = 6 * time.Hour
		if v := a.verifierMaj(ctx); v != nil {
			for ctx.Err() == nil {
				a.mu.Lock()
				enPartie := a.salle != "" || a.enCours != nil
				a.mu.Unlock()
				if !enPartie {
					a.installerMaj()
					break
				}
				select {
				case <-ctx.Done():
				case <-time.After(time.Minute):
				}
			}
		}
	}
}
