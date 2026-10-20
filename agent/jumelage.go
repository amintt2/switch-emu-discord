package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

var client = &http.Client{Timeout: 15 * time.Second}

type reponseJumelage struct {
	Code       string `json:"code"`
	Secret     string `json:"secret"`
	ExpireDans int64  `json:"expireDans"`
	Etat       string `json:"etat"`
	Jeton      string `json:"jeton"`
	Nom        string `json:"nom"`
	Error      string `json:"error"`
}

func appel(ctx context.Context, methode, u string) (reponseJumelage, int, error) {
	var r reponseJumelage
	req, _ := http.NewRequestWithContext(ctx, methode, u, strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return r, 0, err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	json.Unmarshal(b, &r)
	return r, res.StatusCode, nil
}

// jumeler demande un code au serveur, l'affiche, et attend que l'utilisateur le tape dans l'Activité.
func jumeler(ctx context.Context, serveur string, afficher func(code string)) (jeton, nom string, err error) {
	base := strings.TrimRight(serveur, "/")
	r, status, err := appel(ctx, http.MethodPost, base+"/api/agent/jumelage")
	if err != nil {
		return "", "", fmt.Errorf("serveur injoignable : %w", err)
	}
	if status != 200 || r.Code == "" {
		return "", "", fmt.Errorf("le serveur refuse le jumelage (%d) : %s", status, r.Error)
	}
	afficher(r.Code)
	fin := time.Now().Add(time.Duration(r.ExpireDans) * time.Millisecond)
	for time.Now().Before(fin) {
		select {
		case <-ctx.Done():
			return "", "", ctx.Err()
		case <-time.After(2 * time.Second):
		}
		e, status, err := appel(ctx, http.MethodGet, base+"/api/agent/jumelage/"+r.Secret)
		if err != nil {
			continue // coupure réseau passagère : on réessaie
		}
		if status == 404 {
			break
		}
		if e.Etat == "lie" && e.Jeton != "" {
			return e.Jeton, e.Nom, nil
		}
	}
	return "", "", errors.New("code expiré sans être utilisé : relance l'agent pour en avoir un nouveau")
}
