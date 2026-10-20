package main

// Installation sur ce PC : l'application vit dans %LOCALAPPDATA%\SwitchEMU\app, ses réglages dans
// %APPDATA%\SwitchEMU. Au premier lancement depuis un zip, l'agent s'y copie et se relance depuis là.

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func dossierDonnees() string {
	if d := os.Getenv("LOCALAPPDATA"); d != "" {
		return filepath.Join(d, "SwitchEMU")
	}
	return filepath.Join(os.TempDir(), "SwitchEMU")
}

func dossierApp() string { return filepath.Join(dossierDonnees(), "app") }

func dossierExe() string {
	self, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(self)
}

func estInstalle() bool {
	return strings.EqualFold(filepath.Clean(dossierExe()), filepath.Clean(dossierApp()))
}

// copierDossier copie les fichiers du dossier source (sans sous-dossiers) vers dest.
func copierDossier(src, dest string) error {
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	entrees, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entrees {
		if e.IsDir() {
			continue
		}
		if err := copierFichier(filepath.Join(src, e.Name()), filepath.Join(dest, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

func copierFichier(src, dest string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dest + ".nouveau"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	out.Close()
	// Un exécutable en cours d'utilisation ne peut pas être remplacé, mais il peut être renommé.
	if _, err := os.Stat(dest); err == nil {
		vieux := dest + ".ancien"
		os.Remove(vieux)
		os.Rename(dest, vieux)
	}
	return os.Rename(tmp, dest)
}

// attendreFin attend la fin d'un processus (au plus 30 s).
func attendreFin(pid int) {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return
	}
	defer windows.CloseHandle(h)
	windows.WaitForSingleObject(h, 30_000)
}

// modeInstallateur : appelé par une mise à jour ou au premier lancement.
func modeInstallateur(dest string, pid int) error {
	if pid > 0 {
		attendreFin(pid)
		time.Sleep(300 * time.Millisecond)
	}
	if !strings.EqualFold(filepath.Clean(dest), filepath.Clean(dossierApp())) {
		return errors.New("dossier d'installation inattendu")
	}
	if err := copierDossier(dossierExe(), dest); err != nil {
		return fmt.Errorf("installation impossible : %w", err)
	}
	// Le démarrage avec Windows pointe déjà vers ce dossier : rien à changer.
	return exec.Command(filepath.Join(dest, nomExe)).Start()
}

// --- Démarrage avec Windows (clé « Run » de l'utilisateur, pas besoin des droits administrateur)

const cleRun = `Software\Microsoft\Windows\CurrentVersion\Run`

func demarrageWindows() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, cleRun, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	_, _, err = k.GetStringValue("SwitchEMU")
	return err == nil
}

func reglerDemarrageWindows(actif bool) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, cleRun, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if !actif {
		err := k.DeleteValue("SwitchEMU")
		if errors.Is(err, registry.ErrNotExist) {
			return nil
		}
		return err
	}
	return k.SetStringValue("SwitchEMU", fmt.Sprintf(`"%s" -demarrage`, filepath.Join(dossierApp(), nomExe)))
}
