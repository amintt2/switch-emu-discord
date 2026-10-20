# Switch EMU — jouer à plusieurs dans Discord

Activité Discord pour jouer à plusieurs à des jeux Switch émulés (Mario Kart 8, Smash Bros…) qui
tournent sur le PC de l'hôte. Les amis lancent l'Activité dans un salon vocal, voient le jeu en direct
et jouent avec leur manette, le clavier ou des boutons tactiles.

> Rien de protégé n'est dans ce dépôt : ni jeux, ni clés, ni firmware. Chacun utilise ses propres dumps.

## Héberger une partie (sur ton PC Windows)

1. Télécharge **SwitchEMU-agent.zip** sur la page [Releases](https://github.com/amintt2/switch-emu-discord/releases/latest),
   décompresse-le et lance **SwitchEMU.exe**. Il s'installe tout seul (dans `%LOCALAPPDATA%\SwitchEMU`),
   démarre avec Windows, se range près de l'horloge et se met à jour automatiquement (versions signées).
2. Dans sa fenêtre :
   - **Se connecter avec Discord** : lie ce PC à ton compte (une seule fois) ;
   - **Émulateur** : Ryubing (`Ryujinx.exe`) est détecté tout seul, sinon indique où il se trouve ;
   - **Mes jeux** : ajoute le dossier où tu ranges tes jeux (`.nsp`, `.xci`) — tes propres dumps.
3. Pour les manettes de tes amis, installe [ViGEmBus](https://github.com/nefarius/ViGEmBus/releases/latest) (une fois).
4. Dans Discord, lance l'Activité **Switch EMU** dans un salon vocal, clique **Héberger depuis mon PC**,
   choisis le jeu : l'agent lance Ryubing en plein écran.
5. Dans Ryubing (une fois) : **Input → Player 2, 3, 4** = les manettes « Xbox 360 Controller » (branchées par
   l'agent dans cet ordre au début de la partie). Player 1 = ta manette.

Tes amis n'installent rien : ils lancent l'Activité, prennent une place (J2 à J4) et jouent avec leur manette,
leur clavier, et bientôt des boutons tactiles.

## État actuel : vérifications avant le vrai code

| Dossier | Ce que c'est |
|---|---|
| `prototypes/01-latence-locale` | Agent Go jetable : capture → encodage → WebRTC ou WebSocket + WebCodecs, manette virtuelle ViGEm, mesure de latence |
| `prototypes/02-sunshine` | Tampon horaire utilisé pour l'essai avec Sunshine (abandonné : appairage PIN et comptes en plus) |
| `prototypes/03-capteur` | Capture DXGI + conversion GPU + encodeur matériel via libavcodec, réglages repris de Sunshine (GPL-3.0) |
| `prototypes/04-hote-test` | Hôte de test en Go : connexions sortantes vers les relais, P2P WebRTC (canaux de données) |
| `relais-cf/` | Relais de test sur Cloudflare (un Durable Object par salle, créé près de l'hôte) |
| `sonde/` | Page de test déployée sur `switch.mciut.fr` : manette, clavier, tactile, WebCodecs et les trois chemins vers le PC, dans le vrai Discord |

Résultats en local (RX 6650 XT, écran 180 Hz) :

- capture + encodage : 3,5 ms (médiane) ;
- de l'écran à l'image affichée en WebSocket + WebCodecs : 15,5 ms (p95 23 ms) ;
- en WebRTC : 43,5 ms (pipeline vidéo de Chrome) — et Discord désactive WebRTC dans les Activités ;
- manette virtuelle ViGEm : moins de 1 ms.

Dans le vrai Discord (Mac, même réseau que le PC hôte), jusqu'au PC :

| Chemin | Aller-retour | Image |
|---|---|---|
| Relais VPS (Helsinki) | 118 ms | 60 ms |
| Relais Cloudflare (salle à Paris) | 43 ms | 24 ms |
| P2P WebRTC hors Discord (même réseau) | 7 ms | 6 ms |

La manette (Gamepad API), le clavier et l'ouverture dans le navigateur marchent dans l'Activité ;
WebRTC et le plein écran y sont bloqués par Discord.

## Licence

Le module de capture reprend du code de [Sunshine](https://github.com/LizardByte/Sunshine) (GPL-3.0) :
le projet est donc sous GPL-3.0.
