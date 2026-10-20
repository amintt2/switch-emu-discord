// Prototype jetable : mesure la latence capture -> encodage AMF -> WebRTC -> affichage,
// le canal de données non fiable, et une manette virtuelle ViGEm. Tout tourne en local.
//
//	go run . [-source "<filtre ffmpeg>"] [-bitrate 15M]
//
// puis ouvrir http://localhost:8090 (la page doit être visible à l'écran).
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	_ "embed"

	"github.com/coder/websocket"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

//go:embed client.html
var clientHTML []byte

var (
	source  = flag.String("source", `gfxcapture=window_title=(?i)Latence proto:max_framerate=60:capture_cursor=0,hwdownload,format=bgra,format=nv12`, "filtre ffmpeg de capture")
	bitrate = flag.String("bitrate", "15M", "débit vidéo")
	encoder = flag.String("encoder", "h264_amf", "encodeur ffmpeg")
	addr    = flag.String("addr", "127.0.0.1:8090", "adresse HTTP locale")
	extra   = flag.String("extra", "-async_depth 1", "options ffmpeg en plus pour l'encodeur")
	capteur = flag.String("capteur", "", "chemin de capteur.exe (prototype 03) : remplace ffmpeg")
	fenetre = flag.String("fenetre", "Latence proto", "avec -capteur : titre de la fenêtre à capturer")
)

// Broadcast of encoded access units to every viewer (one encode, N viewers).
type frame struct {
	data []byte
	key  bool
	dur  time.Duration
}

type hub struct {
	mu   sync.Mutex
	next int
	subs map[int]func(frame)
}

func (h *hub) add(f func(frame)) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.next++
	h.subs[h.next] = f
	return h.next
}
func (h *hub) remove(id int) { h.mu.Lock(); delete(h.subs, id); h.mu.Unlock() }
func (h *hub) write(f frame) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, s := range h.subs {
		s(f)
	}
}

var video = &hub{subs: map[int]func(frame){}}

func main() {
	flag.Parse()
	go runEncoder()

	pad := setupPad()

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(clientHTML)
	})
	http.HandleFunc("/offer", func(w http.ResponseWriter, r *http.Request) { handleOffer(w, r, pad) })
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) { handleWS(w, r, pad) })
	http.HandleFunc("/report", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		name := "resultats-webrtc.json"
		if r.URL.Query().Get("mode") == "ws" {
			name = "resultats-ws.json"
		}
		os.WriteFile(name, body, 0o644)
		log.Printf("résultats enregistrés dans %s", name)
	})
	log.Printf("ouvre http://%s", *addr)
	log.Fatal(http.ListenAndServe(*addr, nil))
}

func setupPad() *Pad {
	bus, err := OpenViGEm()
	if err != nil {
		log.Printf("ViGEm indisponible: %v", err)
		return nil
	}
	pad, err := bus.PlugX360()
	if err != nil {
		log.Printf("ViGEm: %v", err)
		return nil
	}
	time.Sleep(500 * time.Millisecond)
	idx, err := pad.UserIndex()
	log.Printf("manette virtuelle Xbox 360 branchée (XInput %d, err=%v)", idx, err)
	return pad
}

// --- encoder: ffmpeg writes FLV on stdout; FLV tags give exact frame boundaries,
// so a frame is forwarded as soon as it is complete (raw Annex B would need the next start code).

// requestIDR asks the encoder for a keyframe (new viewer, decoder error).
var requestIDR = func() {}

func runEncoder() {
	if *capteur != "" {
		runCapteur()
		return
	}
	for {
		args := []string{"-hide_banner", "-loglevel", "error", "-fflags", "nobuffer",
			"-filter_complex", *source,
			"-c:v", *encoder, "-b:v", *bitrate, "-maxrate", *bitrate, "-bufsize", "1M", "-g", "120", "-bf", "0"}
		if *encoder == "h264_amf" {
			args = append(args, "-usage", "ultralowlatency", "-rc", "cbr", "-profile:v", "constrained_high", "-quality", "speed")
		}
		args = append(args, strings.Fields(*extra)...)
		args = append(args, "-flush_packets", "1", "-f", "flv", "pipe:1")
		cmd := exec.Command("ffmpeg", args...)
		cmd.Stderr = os.Stderr
		out, _ := cmd.StdoutPipe()
		if err := cmd.Start(); err != nil {
			log.Fatalf("ffmpeg: %v", err)
		}
		err := readFLV(bufio.NewReaderSize(out, 1<<20))
		cmd.Wait()
		log.Printf("ffmpeg arrêté (%v), relance dans 2 s", err)
		time.Sleep(2 * time.Second)
	}
}

func readFLV(r io.Reader) error {
	hdr := make([]byte, 13)
	if _, err := io.ReadFull(r, hdr); err != nil {
		return err
	}
	var sps, pps [][]byte
	lenSize := 4
	last := time.Now()
	th := make([]byte, 11)
	for {
		if _, err := io.ReadFull(r, th); err != nil {
			return err
		}
		size := int(th[1])<<16 | int(th[2])<<8 | int(th[3])
		data := make([]byte, size+4)
		if _, err := io.ReadFull(r, data); err != nil {
			return err
		}
		data = data[:size]
		if th[0] != 9 || size < 5 || data[0]&0x0f != 7 {
			continue
		}
		key := data[0]>>4 == 1
		switch data[1] {
		case 0: // AVCDecoderConfigurationRecord
			sps, pps, lenSize = parseAVCC(data[5:])
		case 1:
			var au []byte
			if key {
				for _, n := range append(append([][]byte{}, sps...), pps...) {
					au = append(au, 0, 0, 0, 1)
					au = append(au, n...)
				}
			}
			p := data[5:]
			for len(p) >= lenSize {
				n := 0
				for i := 0; i < lenSize; i++ {
					n = n<<8 | int(p[i])
				}
				p = p[lenSize:]
				if n > len(p) {
					break
				}
				au = append(au, 0, 0, 0, 1)
				au = append(au, p[:n]...)
				p = p[n:]
			}
			if os.Getenv("NALDEBUG") != "" && (key || debugCount < 5) {
				debugCount++
				log.Printf("AU key=%v taille=%d NAL=%v", key, len(au), nalTypes(au))
			}
			now := time.Now()
			video.write(frame{data: au, key: key, dur: now.Sub(last)})
			last = now
		}
	}
}

func parseAVCC(b []byte) (sps, pps [][]byte, lenSize int) {
	if len(b) < 7 {
		return nil, nil, 4
	}
	lenSize = int(b[4]&3) + 1
	p := b[5:]
	read := func(count int) (out [][]byte) {
		for i := 0; i < count && len(p) >= 2; i++ {
			n := int(binary.BigEndian.Uint16(p))
			if len(p) < 2+n {
				return
			}
			out = append(out, append([]byte{}, p[2:2+n]...))
			p = p[2+n:]
		}
		return
	}
	sps = read(int(p[0] & 0x1f))
	p = p[1:]
	if len(p) > 0 {
		c := int(p[0])
		p = p[1:]
		pps = read(c)
	}
	return
}

// --- signaling (local, non-trickle: the browser sends a complete offer)

type inputMsg struct {
	Type    string  `json:"type"`
	T       float64 `json:"t"`
	Buttons uint16  `json:"buttons"`
	Seq     int     `json:"seq"`
}

func handleOffer(w http.ResponseWriter, r *http.Request, pad *Pad) {
	var offer webrtc.SessionDescription
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&offer); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	track, _ := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264}, "video", "ecran")
	sender, _ := pc.AddTrack(track)
	go func() { // drain RTCP (PLI/NACK) so the interceptors keep working
		for {
			pkts, _, err := sender.ReadRTCP()
			if err != nil {
				return
			}
			for _, p := range pkts {
				if _, ok := p.(*rtcp.PictureLossIndication); ok {
					requestIDR()
				}
			}
		}
	}()
	subID := 0
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		log.Printf("WebRTC: %s", s)
		switch s {
		case webrtc.PeerConnectionStateConnected:
			subID = video.add(func(f frame) { track.WriteSample(media.Sample{Data: f.data, Duration: f.dur}) })
			requestIDR()
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed, webrtc.PeerConnectionStateDisconnected:
			video.remove(subID)
			pc.Close()
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		log.Printf("canal de données %q (ordonné=%v)", dc.Label(), dc.Ordered())
		dc.OnMessage(func(m webrtc.DataChannelMessage) {
			handleInput(pad, m.Data, func(b []byte) { dc.SendText(string(b)) })
		})
	})
	if err := pc.SetRemoteDescription(offer); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	done := webrtc.GatheringCompletePromise(pc)
	pc.SetLocalDescription(answer)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		http.Error(w, "ICE timeout", 500)
		return
	}
	json.NewEncoder(w).Encode(pc.LocalDescription())
}

// handleInput is shared by the WebRTC data channel and the WebSocket.
func handleInput(pad *Pad, data []byte, send func([]byte)) {
	var in inputMsg
	if err := json.Unmarshal(data, &in); err != nil {
		log.Printf("message illisible: %v", err)
		return
	}
	switch in.Type {
	case "ping":
		b, _ := json.Marshal(map[string]any{"type": "pong", "t": in.T})
		send(b)
	case "pad":
		res := map[string]any{"type": "padres", "seq": in.Seq}
		if pad == nil {
			res["error"] = "pas de manette virtuelle"
		} else {
			start := time.Now()
			err := pad.Submit(XusbReport{Buttons: in.Buttons})
			res["submitUs"] = time.Since(start).Microseconds()
			if err != nil {
				res["error"] = err.Error()
			} else if idx, err := pad.UserIndex(); err == nil {
				d, ok := waitXInput(idx, in.Buttons, 200*time.Millisecond)
				res["xinputUs"] = d.Microseconds()
				res["seen"] = ok
			}
		}
		b, _ := json.Marshal(res)
		send(b)
	}
}

// --- WebSocket transport (what a Discord Activity has to use: no WebRTC there).
// Binary message = [1 byte flags (1 = keyframe)][Annex B access unit]. Text = JSON input.
// A slow viewer gets frames dropped until the next keyframe instead of building up delay.
func handleWS(w http.ResponseWriter, r *http.Request, pad *Pad) {
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	c.SetReadLimit(1 << 16)
	ctx := r.Context()
	q := make(chan frame, 3)
	waitKey := true
	id := video.add(func(f frame) {
		if waitKey && !f.key {
			return
		}
		select {
		case q <- f:
			waitKey = false
		default:
			waitKey = true // queue full: skip until the next keyframe
			go requestIDR()
		}
	})
	defer video.remove(id)
	requestIDR()
	log.Printf("WebSocket connecté")
	var wmu sync.Mutex
	go func() {
		for {
			select {
			case f := <-q:
				msg := make([]byte, 1+len(f.data))
				if f.key {
					msg[0] = 1
				}
				copy(msg[1:], f.data)
				wmu.Lock()
				err := c.Write(ctx, websocket.MessageBinary, msg)
				wmu.Unlock()
				if err != nil {
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			log.Printf("WebSocket fermé: %v", err)
			return
		}
		handleInput(pad, data, func(b []byte) {
			wmu.Lock()
			c.Write(ctx, websocket.MessageText, b)
			wmu.Unlock()
		})
	}
}

var debugCount int

func nalTypes(au []byte) (t []int) {
	for i := 0; i+4 < len(au); i++ {
		if au[i] == 0 && au[i+1] == 0 && au[i+2] == 0 && au[i+3] == 1 {
			t = append(t, int(au[i+4]&0x1f))
		}
	}
	return
}

// --- capteur.exe (prototype 03): DXGI capture + GPU NV12 conversion + hardware encoder, keyframes on demand.
// Packet = u32 size | u8 flags | i64 present_us | i64 out_us | Annex B.
func runCapteur() {
	for {
		cmd := exec.Command(*capteur, "--window", *fenetre, "--fps", "60", "--kbps", strings.TrimSuffix(*bitrate, "M")+"000")
		cmd.Stderr = os.Stderr
		out, _ := cmd.StdoutPipe()
		in, _ := cmd.StdinPipe()
		if err := cmd.Start(); err != nil {
			log.Fatalf("capteur: %v", err)
		}
		var mu sync.Mutex
		requestIDR = func() { mu.Lock(); io.WriteString(in, "idr\n"); mu.Unlock() }
		r := bufio.NewReaderSize(out, 1<<20)
		last := time.Now()
		hdr := make([]byte, 21)
		var encodeLat []float64
		for {
			if _, err := io.ReadFull(r, hdr); err != nil {
				break
			}
			n := binary.LittleEndian.Uint32(hdr)
			present := int64(binary.LittleEndian.Uint64(hdr[5:]))
			outUs := int64(binary.LittleEndian.Uint64(hdr[13:]))
			au := make([]byte, n)
			if _, err := io.ReadFull(r, au); err != nil {
				break
			}
			if present > 0 {
				encodeLat = append(encodeLat, float64(outUs-present)/1000)
				if len(encodeLat) == 300 {
					log.Printf("capteur : affichage -> encodé, médiane %.2f ms", median(encodeLat))
					encodeLat = encodeLat[:0]
				}
			}
			now := time.Now()
			video.write(frame{data: au, key: hdr[4]&1 == 1, dur: now.Sub(last)})
			last = now
		}
		cmd.Wait()
		log.Printf("capteur arrêté, relance dans 2 s")
		time.Sleep(2 * time.Second)
	}
}

func median(v []float64) float64 {
	s := append([]float64{}, v...)
	sort.Float64s(s)
	return s[len(s)/2]
}
