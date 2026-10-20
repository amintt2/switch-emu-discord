# Switch EMU — jouer à plusieurs dans Discord

Activité Discord pour jouer à plusieurs à des jeux Switch émulés (Mario Kart 8, Smash Bros…) qui
tournent sur le PC de l'hôte. Les amis lancent l'Activité dans un salon vocal, voient le jeu en direct
et jouent avec leur manette, le clavier ou des boutons tactiles.

> Rien de protégé n'est dans ce dépôt : ni jeux, ni clés, ni firmware. Chacun utilise ses propres dumps.

## État actuel : vérifications avant le vrai code

| Dossier | Ce que c'est |
|---|---|
| `prototypes/01-latence-locale` | Agent Go jetable : capture → encodage → WebRTC ou WebSocket + WebCodecs, manette virtuelle ViGEm, mesure de latence |
| `prototypes/02-sunshine` | Tampon horaire utilisé pour l'essai avec Sunshine (abandonné : appairage PIN et comptes en plus) |
| `prototypes/03-capteur` | Capture DXGI + conversion GPU + encodeur matériel via libavcodec, réglages repris de Sunshine (GPL-3.0) |
| `sonde/` | Page de test déployée sur `switch.mciut.fr` : manette, clavier, tactile, WebSocket et WebCodecs dans le vrai Discord |

Résultats en local (RX 6650 XT, écran 180 Hz) :

- capture + encodage : 3,5 ms (médiane) ;
- de l'écran à l'image affichée en WebSocket + WebCodecs : 15,5 ms (p95 23 ms) ;
- en WebRTC : 43,5 ms (pipeline vidéo de Chrome) — et Discord désactive WebRTC dans les Activités ;
- manette virtuelle ViGEm : moins de 1 ms.

## Licence

Le module de capture reprend du code de [Sunshine](https://github.com/LizardByte/Sunshine) (GPL-3.0) :
le projet est donc sous GPL-3.0.
