// capteur : capture d'écran DXGI -> conversion NV12 sur le GPU -> encodeur matériel (AMF/NVENC/QSV via libavcodec).
// Tout reste sur le GPU (zéro copie vers la mémoire centrale). Réglages d'encodeur repris de Sunshine
// (LizardByte/Sunshine, src/video.cpp, GPL-3.0) : pas d'images B, GOP infini, IDR à la demande.
//
// Sortie (stdout), un paquet par image :
//   u32 taille_charge | u8 drapeaux (bit0 = image clé) | i64 t_present_us | i64 t_sortie_us | charge (Annex B)
//   (les temps sont en microsecondes QueryPerformanceCounter, t_present = moment où Windows a affiché l'image)
// Commandes (stdin, une par ligne) : "idr", "bitrate <kbit/s>", "quit".
#include <windows.h>
#include <timeapi.h>
#include <d3d11.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <cstdarg>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <io.h>
#include <fcntl.h>
#include <limits>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_d3d11va.h>
#include <libavutil/opt.h>
}

using Microsoft::WRL::ComPtr;

static void logf(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  std::fputs("[capteur] ", stderr);
  std::vfprintf(stderr, fmt, ap);
  std::fputc('\n', stderr);
  std::fflush(stderr);
  va_end(ap);
}

static int64_t qpc_us() {
  static LARGE_INTEGER f = [] { LARGE_INTEGER x; QueryPerformanceFrequency(&x); return x; }();
  LARGE_INTEGER c;
  QueryPerformanceCounter(&c);
  return c.QuadPart * 1000000 / f.QuadPart;
}

static int64_t qpc_to_us(int64_t ticks) {
  static LARGE_INTEGER f = [] { LARGE_INTEGER x; QueryPerformanceFrequency(&x); return x; }();
  return ticks * 1000000 / f.QuadPart;
}

struct Options {
  int output = 0;           // index de l'écran
  std::wstring window;      // si non vide : capture seulement la zone cliente de cette fenêtre (titre contenant ce texte)
  int fps = 60;
  int kbps = 15000;
  int width = 0, height = 0;  // 0 = taille source
  std::string codec = "h264_amf";
};

static std::atomic<bool> g_idr{true}, g_quit{false};
static std::atomic<int> g_kbps{0};

static void stdin_thread() {
  char line[256];
  while (std::fgets(line, sizeof line, stdin)) {
    if (!std::strncmp(line, "idr", 3)) g_idr = true;
    else if (!std::strncmp(line, "bitrate ", 8)) g_kbps = std::atoi(line + 8);
    else if (!std::strncmp(line, "quit", 4)) break;
  }
  g_quit = true;  // stdin fermé = l'agent est parti
}

static RECT window_rect_on_output(const std::wstring &title, const RECT &desk) {
  RECT r{0, 0, 0, 0};
  struct Ctx { const std::wstring *t; HWND h; } ctx{&title, nullptr};
  EnumWindows([](HWND h, LPARAM p) -> BOOL {
    auto c = (Ctx *) p;
    wchar_t buf[512];
    if (!IsWindowVisible(h) || !GetWindowTextW(h, buf, 512)) return TRUE;
    if (std::wstring(buf).find(*c->t) != std::wstring::npos) { c->h = h; return FALSE; }
    return TRUE;
  }, (LPARAM) &ctx);
  if (!ctx.h) return r;
  RECT cr;
  GetClientRect(ctx.h, &cr);
  POINT tl{0, 0};
  ClientToScreen(ctx.h, &tl);
  r = {tl.x - desk.left, tl.y - desk.top, tl.x - desk.left + cr.right, tl.y - desk.top + cr.bottom};
  r.left = std::max(r.left, 0L); r.top = std::max(r.top, 0L);
  r.right = std::min(r.right, desk.right - desk.left); r.bottom = std::min(r.bottom, desk.bottom - desk.top);
  r.right -= (r.right - r.left) & 1; r.bottom -= (r.bottom - r.top) & 1;  // tailles paires pour le NV12
  return r;
}

struct Capturer {
  ComPtr<ID3D11Device> dev;
  ComPtr<ID3D11DeviceContext> ctx;
  ComPtr<IDXGIOutput1> output;
  ComPtr<IDXGIOutputDuplication> dup;
  RECT desk{};

  bool init(int index) {
    ComPtr<IDXGIFactory1> f;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&f)))) return false;
    ComPtr<IDXGIAdapter1> ad;
    int n = 0;
    for (UINT a = 0; f->EnumAdapters1(a, &ad) != DXGI_ERROR_NOT_FOUND; a++) {
      ComPtr<IDXGIOutput> o;
      for (UINT i = 0; ad->EnumOutputs(i, &o) != DXGI_ERROR_NOT_FOUND; i++, n++) {
        if (n != index) continue;
        o.As(&output);
        DXGI_OUTPUT_DESC od;
        o->GetDesc(&od);
        desk = od.DesktopCoordinates;
        DXGI_ADAPTER_DESC1 add;
        ad->GetDesc1(&add);
        logf("carte : %ls, écran %d (%ldx%ld)", add.Description, index, desk.right - desk.left, desk.bottom - desk.top);
        D3D_FEATURE_LEVEL fl[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
        UINT flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT;
        if (FAILED(D3D11CreateDevice(ad.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags, fl, 2, D3D11_SDK_VERSION, &dev, nullptr, &ctx)))
          return false;
        ComPtr<IDXGIDevice1> dd;
        dev.As(&dd);
        dd->SetMaximumFrameLatency(1);
        return reopen();
      }
    }
    logf("écran %d introuvable", index);
    return false;
  }

  bool reopen() {
    dup.Reset();
    HRESULT hr = output->DuplicateOutput(dev.Get(), &dup);
    if (FAILED(hr)) { logf("DuplicateOutput a échoué (0x%08lx)", hr); return false; }
    return true;
  }
};

struct Converter {  // BGRA -> NV12 avec le processeur vidéo du GPU (mise à l'échelle comprise)
  ComPtr<ID3D11VideoDevice> vdev;
  ComPtr<ID3D11VideoContext> vctx;
  ComPtr<ID3D11VideoProcessorEnumerator> en;
  ComPtr<ID3D11VideoProcessor> vp;
  ComPtr<ID3D11Texture2D> src;  // copie BGRA de la dernière image capturée
  ComPtr<ID3D11VideoProcessorInputView> in;
  std::vector<std::pair<ID3D11Texture2D *, ComPtr<ID3D11VideoProcessorOutputView>>> outs;  // une vue par texture du pool
  RECT crop{};

  bool init(ID3D11Device *dev, ID3D11DeviceContext *ctx, int sw, int sh, RECT c, int ow, int oh) {
    crop = c;
    if (FAILED(dev->QueryInterface(IID_PPV_ARGS(&vdev))) || FAILED(ctx->QueryInterface(IID_PPV_ARGS(&vctx)))) return false;
    D3D11_TEXTURE2D_DESC td{};
    td.Width = sw; td.Height = sh; td.MipLevels = 1; td.ArraySize = 1;
    td.Format = DXGI_FORMAT_B8G8R8A8_UNORM; td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DEFAULT; td.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    if (FAILED(dev->CreateTexture2D(&td, nullptr, &src))) return false;
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC cd{};
    cd.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    cd.InputWidth = sw; cd.InputHeight = sh; cd.OutputWidth = ow; cd.OutputHeight = oh;
    cd.Usage = D3D11_VIDEO_USAGE_OPTIMAL_SPEED;
    if (FAILED(vdev->CreateVideoProcessorEnumerator(&cd, &en)) || FAILED(vdev->CreateVideoProcessor(en.Get(), 0, &vp))) return false;
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC ivd{};
    ivd.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
    if (FAILED(vdev->CreateVideoProcessorInputView(src.Get(), en.Get(), &ivd, &in))) return false;
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE ics{}; ics.RGB_Range = 0;  // RVB 0-255
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE ocs{}; ocs.YCbCr_Matrix = 1; ocs.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;  // BT.709 limité
    vctx->VideoProcessorSetStreamColorSpace(vp.Get(), 0, &ics);
    vctx->VideoProcessorSetOutputColorSpace(vp.Get(), &ocs);
    vctx->VideoProcessorSetStreamSourceRect(vp.Get(), 0, TRUE, &crop);
    RECT dst{0, 0, ow, oh};
    vctx->VideoProcessorSetStreamDestRect(vp.Get(), 0, TRUE, &dst);
    vctx->VideoProcessorSetStreamAutoProcessingMode(vp.Get(), 0, FALSE);
    return true;
  }

  bool blt(ID3D11Texture2D *nv12, UINT slice) {
    ID3D11VideoProcessorOutputView *view = nullptr;
    for (auto &[t, v] : outs)
      if (t == nv12) view = v.Get();
    if (!view) {
      D3D11_TEXTURE2D_DESC td;
      nv12->GetDesc(&td);
      D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC od{};
      if (td.ArraySize > 1) {
        od.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2DARRAY;
        od.Texture2DArray.FirstArraySlice = slice; od.Texture2DArray.ArraySize = 1;
      } else {
        od.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
      }
      ComPtr<ID3D11VideoProcessorOutputView> v;
      HRESULT hr = vdev->CreateVideoProcessorOutputView(nv12, en.Get(), &od, &v);
      if (FAILED(hr)) { logf("vue de sortie NV12 : 0x%08lx", hr); return false; }
      view = v.Get();
      outs.emplace_back(nv12, v);
    }
    D3D11_VIDEO_PROCESSOR_STREAM st{};
    st.Enable = TRUE;
    st.pInputSurface = in.Get();
    return SUCCEEDED(vctx->VideoProcessorBlt(vp.Get(), view, 0, 1, &st));
  }
};

struct Encoder {
  AVCodecContext *c = nullptr;
  AVBufferRef *hwdev = nullptr, *hwframes = nullptr;
  AVPacket *pkt = av_packet_alloc();
  int fps = 60;

  bool init(ID3D11Device *dev, const Options &o, int w, int h) {
    fps = o.fps;
    const AVCodec *codec = avcodec_find_encoder_by_name(o.codec.c_str());
    if (!codec) { logf("encodeur %s absent", o.codec.c_str()); return false; }
    hwdev = av_hwdevice_ctx_alloc(AV_HWDEVICE_TYPE_D3D11VA);
    auto dc = (AVD3D11VADeviceContext *) ((AVHWDeviceContext *) hwdev->data)->hwctx;
    dev->AddRef();
    dc->device = dev;
    if (av_hwdevice_ctx_init(hwdev) < 0) return false;

    hwframes = av_hwframe_ctx_alloc(hwdev);
    auto fc = (AVHWFramesContext *) hwframes->data;
    fc->format = AV_PIX_FMT_D3D11; fc->sw_format = AV_PIX_FMT_NV12;
    fc->width = w; fc->height = h; fc->initial_pool_size = 0;  // textures individuelles (un tableau NV12 + RENDER_TARGET est refusé par AMD)
    ((AVD3D11VAFramesContext *) fc->hwctx)->BindFlags = D3D11_BIND_RENDER_TARGET;  // requis par l'encodeur (cf. Sunshine)
    if (av_hwframe_ctx_init(hwframes) < 0) { logf("av_hwframe_ctx_init a échoué"); return false; }

    c = avcodec_alloc_context3(codec);
    c->width = w; c->height = h;
    c->time_base = {1, 1000000};
    c->framerate = {o.fps, 1};
    c->pix_fmt = AV_PIX_FMT_D3D11; c->sw_pix_fmt = AV_PIX_FMT_NV12;
    c->hw_frames_ctx = av_buffer_ref(hwframes);
    c->max_b_frames = 0;
    c->gop_size = std::numeric_limits<int16_t>::max();  // GOP infini : IDR seulement à la demande
    c->keyint_min = std::numeric_limits<int>::max();
    c->flags |= AV_CODEC_FLAG_CLOSED_GOP | AV_CODEC_FLAG_LOW_DELAY;
    c->flags2 |= AV_CODEC_FLAG2_FAST;
    c->color_range = AVCOL_RANGE_MPEG; c->colorspace = AVCOL_SPC_BT709;
    c->color_primaries = AVCOL_PRI_BT709; c->color_trc = AVCOL_TRC_BT709;
    c->slices = 1;
    set_bitrate(o.kbps);
    AVDictionary *d = nullptr;
    if (o.codec.find("_amf") != std::string::npos) {  // réglages Sunshine (amdvce, H.264)
      av_dict_set(&d, "usage", "ultralowlatency", 0);
      av_dict_set(&d, "rc", "cbr", 0);
      av_dict_set(&d, "quality", "speed", 0);
      av_dict_set(&d, "latency", "1", 0);
      av_dict_set(&d, "async_depth", "1", 0);
      av_dict_set(&d, "forced_idr", "1", 0);
      av_dict_set(&d, "filler_data", "0", 0);
      av_dict_set(&d, "frame_skipping", "0", 0);
      av_dict_set(&d, "enforce_hrd", "0", 0);
      av_dict_set(&d, "preencode", "0", 0);
      av_dict_set(&d, "vbaq", "1", 0);
      if (o.codec == "hevc_amf") av_dict_set(&d, "header_insertion_mode", "idr", 0);
    } else if (o.codec.find("_nvenc") != std::string::npos) {  // réglages Sunshine (nvenc)
      av_dict_set(&d, "delay", "0", 0);
      av_dict_set(&d, "forced-idr", "1", 0);
      av_dict_set(&d, "zerolatency", "1", 0);
      av_dict_set(&d, "surfaces", "1", 0);
      av_dict_set(&d, "preset", "p1", 0);
      av_dict_set(&d, "tune", "ull", 0);
      av_dict_set(&d, "rc", "cbr", 0);
    }
    int err = avcodec_open2(c, codec, &d);
    av_dict_free(&d);
    if (err < 0) { char e[128]; av_strerror(err, e, sizeof e); logf("ouverture de %s : %s", o.codec.c_str(), e); return false; }
    logf("encodeur %s %dx%d @%d i/s, %d kbit/s", o.codec.c_str(), w, h, o.fps, o.kbps);
    return true;
  }

  void set_bitrate(int kbps) {  // tampon VBV d'une seule image, comme Sunshine
    int64_t b = int64_t(kbps) * 1000;
    c->bit_rate = b; c->rc_max_rate = b; c->rc_buffer_size = int(b / fps);
  }
};

static void write_packet(const AVPacket *p, int64_t present_us) {
  static std::mutex mu;
  std::lock_guard<std::mutex> l(mu);
  uint8_t hdr[21];
  uint32_t n = p->size;
  int64_t out = qpc_us();
  std::memcpy(hdr, &n, 4);
  hdr[4] = (p->flags & AV_PKT_FLAG_KEY) ? 1 : 0;
  std::memcpy(hdr + 5, &present_us, 8);
  std::memcpy(hdr + 13, &out, 8);
  std::fwrite(hdr, 1, sizeof hdr, stdout);
  std::fwrite(p->data, 1, p->size, stdout);
  std::fflush(stdout);
}

static bool parse(int argc, wchar_t **argv, Options &o) {
  for (int i = 1; i < argc; i++) {
    std::wstring a = argv[i];
    auto next = [&]() -> std::wstring { return i + 1 < argc ? argv[++i] : L""; };
    if (a == L"--output") o.output = _wtoi(next().c_str());
    else if (a == L"--window") o.window = next();
    else if (a == L"--fps") o.fps = _wtoi(next().c_str());
    else if (a == L"--kbps") o.kbps = _wtoi(next().c_str());
    else if (a == L"--width") o.width = _wtoi(next().c_str());
    else if (a == L"--height") o.height = _wtoi(next().c_str());
    else if (a == L"--codec") { auto s = next(); o.codec.assign(s.begin(), s.end()); }
    else { logf("option inconnue : %ls", a.c_str()); return false; }
  }
  return o.fps > 0 && o.fps <= 240 && o.kbps > 0;
}

int wmain(int argc, wchar_t **argv) {
  _setmode(_fileno(stdout), _O_BINARY);
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS);
  timeBeginPeriod(1);
  Options o;
  if (!parse(argc, argv, o)) return 2;
  av_log_set_level(AV_LOG_ERROR);

  Capturer cap;
  if (!cap.init(o.output)) return 1;
  const int dw = cap.desk.right - cap.desk.left, dh = cap.desk.bottom - cap.desk.top;
  RECT crop{0, 0, dw, dh};
  if (!o.window.empty()) {
    crop = window_rect_on_output(o.window, cap.desk);
    if (crop.right <= crop.left) { logf("fenêtre « %ls » introuvable sur cet écran", o.window.c_str()); return 3; }
  }
  int ow = o.width ? o.width : crop.right - crop.left, oh = o.height ? o.height : crop.bottom - crop.top;
  ow &= ~1; oh &= ~1;

  Converter conv;
  if (!conv.init(cap.dev.Get(), cap.ctx.Get(), dw, dh, crop, ow, oh)) { logf("processeur vidéo indisponible"); return 1; }
  Encoder enc;
  if (!enc.init(cap.dev.Get(), o, ow, oh)) return 1;

  std::thread(stdin_thread).detach();
  AVFrame *frame = av_frame_alloc();
  const int64_t interval = 1000000 / o.fps;
  int64_t last_encode = 0, last_present = 0;
  bool have_frame = false, pending = false;

  while (!g_quit) {
    if (int k = g_kbps.exchange(0)) { enc.set_bitrate(k); logf("débit : %d kbit/s", k); }
    int64_t now = qpc_us();
    int64_t wait_us = pending ? std::max<int64_t>(0, last_encode + interval - now) : 100000;
    DXGI_OUTDUPL_FRAME_INFO fi{};
    ComPtr<IDXGIResource> res;
    HRESULT hr = cap.dup->AcquireNextFrame(UINT(wait_us / 1000), &fi, &res);
    if (hr == DXGI_ERROR_ACCESS_LOST || hr == DXGI_ERROR_INVALID_CALL) {
      logf("capture perdue (0x%08lx), on recommence", hr);
      Sleep(200);
      cap.reopen();
      continue;
    }
    if (SUCCEEDED(hr)) {
      if (fi.LastPresentTime.QuadPart) {  // nouvelle image (pas seulement la souris)
        ComPtr<ID3D11Texture2D> tex;
        res.As(&tex);
        cap.ctx->CopyResource(conv.src.Get(), tex.Get());
        last_present = qpc_to_us(fi.LastPresentTime.QuadPart);
        have_frame = pending = true;
      }
      cap.dup->ReleaseFrame();
    } else if (hr != DXGI_ERROR_WAIT_TIMEOUT) {
      logf("AcquireNextFrame : 0x%08lx", hr);
      Sleep(50);
      continue;
    }
    if (!have_frame) continue;
    bool idr = g_idr.load();
    now = qpc_us();
    // Limite d'images/s : on encode toujours la plus récente, au plus tôt possible.
    if (!idr && (!pending || now - last_encode < interval - 1000)) continue;

    av_frame_unref(frame);
    if (av_hwframe_get_buffer(enc.hwframes, frame, 0) < 0) { logf("plus de texture libre"); continue; }
    auto nv12 = (ID3D11Texture2D *) frame->data[0];
    if (!conv.blt(nv12, UINT(intptr_t(frame->data[1])))) { logf("conversion NV12 échouée"); continue; }
    frame->pts = now;
    if (idr) {
      g_idr = false;
      frame->pict_type = AV_PICTURE_TYPE_I;
      frame->flags |= AV_FRAME_FLAG_KEY;
    }
    if (avcodec_send_frame(enc.c, frame) < 0) { logf("envoi à l'encodeur échoué"); continue; }
    while (avcodec_receive_packet(enc.c, enc.pkt) == 0) {
      write_packet(enc.pkt, last_present);
      av_packet_unref(enc.pkt);
    }
    last_encode = now;
    pending = false;
  }
  return 0;
}
