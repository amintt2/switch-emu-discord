// Hôte de test jetable : tourne sur le PC de l'hôte, se connecte EN SORTANT aux relais (VPS et Cloudflare),
// répond aux mesures de la sonde (ping, flux vidéo de test) et accepte une connexion P2P WebRTC
// (canaux de données) quand la sonde est ouverte hors de Discord.
//
//	go run . [-salle sonde] [-clip ../../sonde/clip.h264]
package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"log"
	"math"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"
)

var (
	relais = flag.String("relais", "wss://switch.mciut.fr/relais,wss://switch-emu-relais.amin2020e.workers.dev/relais", "relais (séparés par des virgules)")
	salle  = flag.String("salle", "sonde", "nom de la salle")
	clip   = flag.String("clip", "../../sonde/clip.h264", "extrait H.264 (Annex B, un AUD par image)")
)

var frames [][]byte

func nowMs() float64 { return float64(time.Now().UnixNano()) / 1e6 }

func main() {
	flag.Parse()
	data, err := os.ReadFile(*clip)
	if err != nil {
		log.Fatal(err)
	}
	aud := []byte{0, 0, 0, 1, 9}
	for len(data) > 0 {
		i := bytes.Index(data[1:], aud)
		if i < 0 {
			frames = append(frames, data)
			break
		}
		frames = append(frames, data[:i+1])
		data = data[i+1:]
	}
	log.Printf("%d images dans l'extrait", len(frames))
	for _, u := range strings.Split(*relais, ",") {
		go connect(strings.TrimSpace(u))
	}
	select {}
}

// msg is what the probe sends (through a relay, "de" = sender id).
type msg struct {
	Type     string  `json:"type"`
	De       uint32  `json:"de"`
	T        float64 `json:"t"`
	Secondes int     `json:"secondes"`
	SDP      string  `json:"sdp"`
}

// sink abstracts "send to this viewer" over a relay or a P2P data channel.
type sink struct {
	text  func(v map[string]any)
	video func(b []byte) error
}

func connect(u string) {
	for {
		ctx := context.Background()
		c, _, err := websocket.Dial(ctx, u+"?salle="+*salle+"&role=hote", nil)
		if err != nil {
			log.Printf("%s : %v (nouvel essai dans 3 s)", u, err)
			time.Sleep(3 * time.Second)
			continue
		}
		c.SetReadLimit(1 << 20)
		log.Printf("connecté au relais %s", u)
		var mu sync.Mutex
		write := func(t websocket.MessageType, b []byte) error {
			mu.Lock()
			defer mu.Unlock()
			wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			return c.Write(wctx, t, b)
		}
		for {
			_, b, err := c.Read(ctx)
			if err != nil {
				log.Printf("%s fermé : %v", u, err)
				break
			}
			var m msg
			if json.Unmarshal(b, &m) != nil {
				continue
			}
			to := m.De
			s := sink{
				text: func(v map[string]any) {
					v["a"] = to
					j, _ := json.Marshal(v)
					write(websocket.MessageText, j)
				},
				video: func(p []byte) error {
					out := make([]byte, 4+len(p))
					binary.LittleEndian.PutUint32(out, to)
					copy(out[4:], p)
					return write(websocket.MessageBinary, out)
				},
			}
			switch m.Type {
			case "arrivee":
				log.Printf("%s : ami %d arrivé", u, m.De)
			case "offre":
				go p2p(m, s)
			default:
				handle(m, s)
			}
		}
		c.CloseNow()
		time.Sleep(time.Second)
	}
}

func handle(m msg, s sink) {
	switch m.Type {
	case "ping":
		s.text(map[string]any{"type": "pong", "t": m.T, "s": nowMs()})
	case "flux":
		go stream(m.Secondes, s)
	}
}

// stream sends the clip at 60 fps: [f64 host time ms][u32 seq][u8 key][Annex B], like the VPS probe.
func stream(seconds int, s sink) {
	seconds = int(math.Min(15, math.Max(1, float64(seconds))))
	total := seconds * 60
	t0 := time.Now()
	sent := 0
	for seq := 0; seq < total; seq++ {
		au := frames[seq%len(frames)]
		p := make([]byte, 13+len(au))
		binary.LittleEndian.PutUint64(p, math.Float64bits(nowMs()))
		binary.LittleEndian.PutUint32(p[8:], uint32(seq))
		if seq%len(frames) == 0 {
			p[12] = 1
		}
		copy(p[13:], au)
		if s.video(p) == nil {
			sent++
		}
		time.Sleep(time.Until(t0.Add(time.Duration(seq+1) * time.Second / 60)))
	}
	s.text(map[string]any{"type": "fin", "envoyees": sent})
}

// p2p answers a WebRTC offer received through the relay. The probe opens two data channels:
// "ctrl" (reliable, JSON) and "video" (unordered, no retransmission).
func p2p(m msg, relay sink) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"}}},
	})
	if err != nil {
		return
	}
	var ctrl, video *webrtc.DataChannel
	ready := make(chan struct{})
	var once sync.Once
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		switch dc.Label() {
		case "ctrl":
			ctrl = dc
		case "video":
			video = dc
		}
		dc.OnOpen(func() {
			if ctrl != nil && video != nil && ctrl.ReadyState() == webrtc.DataChannelStateOpen && video.ReadyState() == webrtc.DataChannelStateOpen {
				once.Do(func() { close(ready) })
			}
		})
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		log.Printf("P2P ami %d : %s", m.De, st)
		if st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed {
			pc.Close()
		}
	})
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {}) // non-trickle: candidates are in the answer
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: m.SDP}); err != nil {
		relay.text(map[string]any{"type": "reponse", "erreur": err.Error()})
		return
	}
	ans, _ := pc.CreateAnswer(nil)
	done := webrtc.GatheringCompletePromise(pc)
	pc.SetLocalDescription(ans)
	<-done
	relay.text(map[string]any{"type": "reponse", "sdp": pc.LocalDescription().SDP})
	select {
	case <-ready:
	case <-time.After(20 * time.Second):
		pc.Close()
		return
	}
	s := sink{
		text:  func(v map[string]any) { j, _ := json.Marshal(v); ctrl.SendText(string(j)) },
		video: func(b []byte) error { return video.Send(b) },
	}
	ctrl.OnMessage(func(dm webrtc.DataChannelMessage) {
		var cm msg
		if json.Unmarshal(dm.Data, &cm) == nil {
			handle(cm, s)
		}
	})
	if pair, err := pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair(); err == nil && pair != nil {
		log.Printf("P2P ami %d : chemin %s -> %s", m.De, pair.Local.Typ, pair.Remote.Typ)
	}
}
