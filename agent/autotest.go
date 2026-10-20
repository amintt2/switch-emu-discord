package main

import (
	"fmt"
	"time"
)

// autoTestManette vérifie la chaîne côté PC : ViGEm → Windows (XInput), comme le verra l'émulateur.
// On cherche la manette sur les 4 emplacements XInput : le numéro annoncé par ViGEm n'est pas fiable
// quand une vraie manette est déjà branchée.
func autoTestManette(bus busManettes) int {
	if bus == nil {
		fmt.Println("ÉCHEC : ViGEmBus n'est pas installé")
		return 1
	}
	p, err := bus.brancher()
	if err != nil {
		fmt.Println("ÉCHEC : impossible de brancher une manette virtuelle :", err)
		return 1
	}
	defer p.Unplug()
	time.Sleep(500 * time.Millisecond)
	test := XusbReport{Buttons: 0x1000, ThumbLX: 20000}
	p.Submit(test)
	time.Sleep(100 * time.Millisecond)
	defer p.Submit(XusbReport{})
	for i := uint32(0); i < 4; i++ {
		if r, ok := lireXInput(i); ok && r == test {
			fmt.Printf("OK : manette virtuelle Xbox 360 vue par Windows (XInput %d), bouton A et stick reçus.\n", i)
			return 0
		}
	}
	fmt.Println("ÉCHEC : Windows ne voit pas l'état envoyé à la manette virtuelle")
	return 1
}
