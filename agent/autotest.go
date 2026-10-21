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
	p, err := bus.brancher(2)
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
			return testerVibration(p, i)
		}
	}
	fmt.Println("ÉCHEC : Windows ne voit pas l'état envoyé à la manette virtuelle")
	return 1
}

// testerVibration : le jeu fait vibrer la manette (ici par XInput), l'agent doit le voir.
func testerVibration(p padVirtuel, slot uint32) int {
	v, ok := p.(vibreur)
	if !ok {
		return 0
	}
	recu := make(chan [2]uint8, 4)
	go v.Vibrations(func(fort, faible uint8) { recu <- [2]uint8{fort, faible} })
	time.Sleep(100 * time.Millisecond)
	vibrerXInput(slot, 40000, 20000)
	defer vibrerXInput(slot, 0, 0)
	fin := time.After(2 * time.Second)
	for {
		select {
		case r := <-recu:
			if r == [2]uint8{} {
				continue // état de départ (moteurs à l'arrêt)
			}
			fmt.Printf("OK : vibration reçue par l'agent (moteurs %d et %d).\n", r[0], r[1])
			return 0
		case <-fin:
			fmt.Println("ÉCHEC : la vibration demandée par le jeu n'arrive pas à l'agent")
			return 1
		}
	}
}
