package main

// Minimal pure-Go client for the ViGEmBus driver (virtual Xbox 360 pads).
// Protocol reference: nefarius/ViGEmClient (BusShared.h / ViGEmClient.cpp).
// Closing the bus handle unplugs every pad it created, so a crash leaves no ghost pad.

import (
	"errors"
	"fmt"
	"runtime"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/windows"
)

var guidViGEmBus = windows.GUID{Data1: 0x96E42B22, Data2: 0xF5E9, Data3: 0x42F8,
	Data4: [8]byte{0xB0, 0x43, 0xED, 0x0F, 0x93, 0x2F, 0x01, 0x4F}}

func ctlCode(function, access uint32) uint32 {
	const fileDeviceBusExtender = 0x2A
	return fileDeviceBusExtender<<16 | access<<14 | function<<2 // METHOD_BUFFERED = 0
}

const (
	accessRead  = 1
	accessWrite = 2
	ioctlBase   = 0x801
)

var (
	ioctlPlugin       = ctlCode(ioctlBase+0x000, accessWrite)
	ioctlUnplug       = ctlCode(ioctlBase+0x001, accessWrite)
	ioctlCheckVersion = ctlCode(ioctlBase+0x002, accessWrite)
	ioctlWaitReady    = ctlCode(ioctlBase+0x003, accessWrite)
	ioctlXusbSubmit   = ctlCode(ioctlBase+0x201, accessWrite)
	ioctlXusbNotif    = ctlCode(ioctlBase+0x200, accessRead|accessWrite)
	ioctlXusbUserIdx  = ctlCode(ioctlBase+0x206, accessRead|accessWrite)
)

type pluginTarget struct {
	Size, SerialNo, TargetType uint32
	VendorID, ProductID        uint16
}

type sizeSerial struct{ Size, SerialNo uint32 }

// XusbReport has the same layout as XINPUT_GAMEPAD.
type XusbReport struct {
	Buttons                            uint16
	LeftTrigger, RightTrigger          uint8
	ThumbLX, ThumbLY, ThumbRX, ThumbRY int16
}

type xusbSubmit struct {
	Size, SerialNo uint32
	Report         XusbReport
}

type ViGEm struct{ h windows.Handle }

type Pad struct {
	bus       *ViGEm
	serial    uint32
	debranche atomic.Bool
}

// xusbNotification is XUSB_REQUEST_NOTIFICATION: the driver completes it when the game changes the rumble.
type xusbNotification struct {
	Size, SerialNo         uint32
	LargeMotor, SmallMotor uint8
	LedNumber              uint8
	_                      uint8
}

func OpenViGEm() (*ViGEm, error) {
	paths, err := windows.CM_Get_Device_Interface_List("", &guidViGEmBus, windows.CM_GET_DEVICE_INTERFACE_LIST_PRESENT)
	if err != nil {
		return nil, fmt.Errorf("ViGEmBus introuvable: %w", err)
	}
	if len(paths) == 0 {
		return nil, errors.New("ViGEmBus n'est pas installé")
	}
	p, _ := windows.UTF16PtrFromString(paths[0])
	h, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OVERLAPPED, 0)
	if err != nil {
		return nil, fmt.Errorf("ouverture ViGEmBus: %w", err)
	}
	v := &ViGEm{h: h}
	cv := sizeSerial{Size: 8, SerialNo: 1} // VIGEM_CHECK_VERSION {Size, Version=1}
	if err := v.ioctl(ioctlCheckVersion, unsafe.Pointer(&cv), 8, nil, 0); err != nil {
		windows.CloseHandle(h)
		return nil, fmt.Errorf("version ViGEmBus incompatible: %w", err)
	}
	return v, nil
}

// ioctl sends a request and waits for it. The handle is overlapped (like ViGEmClient) so that a pending
// notification request (rumble) never blocks the other requests. The kernel reads and writes a heap
// buffer, never Go stack memory (stacks can move).
func (v *ViGEm) ioctl(code uint32, in unsafe.Pointer, inLen uint32, out unsafe.Pointer, outLen uint32) error {
	n := max(inLen, outLen, 1)
	buf := make([]byte, n)
	copy(buf, unsafe.Slice((*byte)(in), inLen))
	ev, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(ev)
	ov := &windows.Overlapped{HEvent: ev}
	var lus uint32
	var sortie *byte
	if outLen > 0 {
		sortie = &buf[0]
	}
	err = windows.DeviceIoControl(v.h, code, &buf[0], inLen, sortie, outLen, &lus, ov)
	if err == windows.ERROR_IO_PENDING {
		err = windows.GetOverlappedResult(v.h, ov, &lus, true)
	}
	if err == nil && outLen > 0 {
		copy(unsafe.Slice((*byte)(out), outLen), buf[:outLen])
	}
	runtime.KeepAlive(ov)
	runtime.KeepAlive(buf)
	return err
}

func (v *ViGEm) Close() { windows.CloseHandle(v.h) }

// PlugX360 plugs a wired Xbox 360 pad (VID 045E, given PID) and waits until it accepts reports.
// Windows still drives it as an Xbox 360 pad (XInput) whatever the PID.
func (v *ViGEm) PlugX360(pid uint16) (*Pad, error) {
	for serial := uint32(1); serial <= 16; serial++ {
		pt := pluginTarget{Size: uint32(unsafe.Sizeof(pluginTarget{})), SerialNo: serial, TargetType: 0, VendorID: 0x045E, ProductID: pid}
		if err := v.ioctl(ioctlPlugin, unsafe.Pointer(&pt), pt.Size, nil, 0); err != nil {
			continue // serial already used by another client
		}
		wr := sizeSerial{Size: 8, SerialNo: serial}
		if err := v.ioctl(ioctlWaitReady, unsafe.Pointer(&wr), 8, nil, 0); err != nil {
			return nil, fmt.Errorf("manette virtuelle pas prête: %w", err)
		}
		return &Pad{bus: v, serial: serial}, nil
	}
	return nil, errors.New("aucun emplacement ViGEm libre")
}

func (p *Pad) Submit(r XusbReport) error {
	s := xusbSubmit{Size: uint32(unsafe.Sizeof(xusbSubmit{})), SerialNo: p.serial, Report: r}
	return p.bus.ioctl(ioctlXusbSubmit, unsafe.Pointer(&s), s.Size, unsafe.Pointer(&s), s.Size)
}

// UserIndex returns the XInput slot (0-3) Windows gave this pad.
func (p *Pad) UserIndex() (uint32, error) {
	in := struct{ Size, SerialNo, UserIndex uint32 }{12, p.serial, 0}
	err := p.bus.ioctl(ioctlXusbUserIdx, unsafe.Pointer(&in), 12, unsafe.Pointer(&in), 12)
	return in.UserIndex, err
}

func (p *Pad) Unplug() error {
	p.debranche.Store(true)
	u := sizeSerial{Size: 8, SerialNo: p.serial}
	err := p.bus.ioctl(ioctlUnplug, unsafe.Pointer(&u), 8, nil, 0)
	windows.CancelIoEx(p.bus.h, nil) // réveille la demande de vibration en attente (les autres la refont)
	return err
}

// Vibrations calls f each time the game changes the rumble of this pad (large and small motors,
// 0-255), until the pad is unplugged.
func (p *Pad) Vibrations(f func(fort, faible uint8)) {
	for !p.debranche.Load() {
		n := xusbNotification{Size: 12, SerialNo: p.serial}
		err := p.bus.ioctl(ioctlXusbNotif, unsafe.Pointer(&n), 12, unsafe.Pointer(&n), 12)
		if p.debranche.Load() {
			return
		}
		if err == windows.ERROR_OPERATION_ABORTED {
			continue // annulée pour une autre manette
		}
		if err != nil {
			return
		}
		f(n.LargeMotor, n.SmallMotor)
	}
}

// --- Lecture XInput : sert seulement à l'auto-test (-test-manette).

var procXInputGetState = windows.NewLazySystemDLL("xinput1_4.dll").NewProc("XInputGetState")

type xinputState struct {
	PacketNumber uint32
	Gamepad      XusbReport
}

func lireXInput(idx uint32) (XusbReport, bool) {
	var st xinputState
	r, _, _ := procXInputGetState.Call(uintptr(idx), uintptr(unsafe.Pointer(&st)))
	return st.Gamepad, r == 0
}

var procXInputSetState = windows.NewLazySystemDLL("xinput1_4.dll").NewProc("XInputSetState")

// vibrerXInput fait vibrer la manette d'un emplacement XInput (auto-test des vibrations).
func vibrerXInput(idx uint32, gauche, droite uint16) bool {
	v := struct{ Gauche, Droite uint16 }{gauche, droite}
	r, _, _ := procXInputSetState.Call(uintptr(idx), uintptr(unsafe.Pointer(&v)))
	return r == 0
}
