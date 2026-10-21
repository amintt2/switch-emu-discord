// son.exe : capture le son d'un seul programme (Ryubing et ses processus enfants) et l'écrit sur stdout.
// Seulement ce programme : les voix de Discord qui sortent des haut-parleurs de l'hôte ne repartent
// pas vers ses amis (pas d'écho). Nécessite Windows 10 21H2 / Windows 11 (« process loopback »).
//
//   son.exe <pid>
// Paquets sur stdout : u32 taille | i64 position (µs, QPC) | PCM 16 bits, 48 kHz, stéréo entrelacé.
// Les silences ne sont pas envoyés. Commande sur stdin : "quit".

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <wrl/client.h>
#include <wrl/implements.h>

#include <fcntl.h>
#include <io.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;
using namespace Microsoft::WRL;

static std::atomic<bool> g_quit{false};

static void logf(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vfprintf(stderr, fmt, ap);
  va_end(ap);
  fputc('\n', stderr);
  fflush(stderr);
}

static void stdin_thread() {
  char line[64];
  while (fgets(line, sizeof line, stdin)) {
    if (!strncmp(line, "quit", 4)) break;
  }
  g_quit = true;  // "quit" ou stdin fermé (l'agent est parti)
}

// L'activation du client audio en mode « process loopback » est asynchrone.
class Activation : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler> {
 public:
  HANDLE fini = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT resultat = E_FAIL;
  ComPtr<IAudioClient> client;
  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation *op) override {
    ComPtr<IUnknown> unk;
    HRESULT hr = E_FAIL;
    if (SUCCEEDED(op->GetActivateResult(&hr, &unk)) && SUCCEEDED(hr)) hr = unk.As(&client);
    resultat = hr;
    SetEvent(fini);
    return S_OK;
  }
};

static bool ecrire(const void *p, size_t n) { return fwrite(p, 1, n, stdout) == n; }

int main(int argc, char **argv) {
  if (argc < 2) { logf("usage : son.exe <pid>"); return 2; }
  DWORD pid = strtoul(argv[1], nullptr, 10);
  if (!pid) { logf("pid invalide"); return 2; }
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) { logf("COM indisponible"); return 1; }
  _setmode(_fileno(stdout), _O_BINARY);

  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT pv{};
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(params);
  pv.blob.pBlobData = reinterpret_cast<BYTE *>(&params);

  auto act = Make<Activation>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> op;
  HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, act.Get(), &op);
  if (FAILED(hr) || WaitForSingleObject(act->fini, 5000) != WAIT_OBJECT_0 || FAILED(act->resultat)) {
    logf("capture du son impossible (0x%08lx) : Windows 10 21H2 ou plus récent requis", FAILED(hr) ? hr : act->resultat);
    return 1;
  }
  ComPtr<IAudioClient> client = act->client;

  // Format imposé (le mode « process loopback » n'a pas de format de mixage) : Windows convertit.
  WAVEFORMATEX fmt{};
  fmt.wFormatTag = WAVE_FORMAT_PCM;
  fmt.nChannels = 2;
  fmt.nSamplesPerSec = 48000;
  fmt.wBitsPerSample = 16;
  fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
  fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                          200000 /* 20 ms */, 0, &fmt, nullptr);
  if (FAILED(hr)) { logf("initialisation audio : 0x%08lx", hr); return 1; }
  HANDLE evenement = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  ComPtr<IAudioCaptureClient> capture;
  if (FAILED(client->SetEventHandle(evenement)) || FAILED(client->GetService(IID_PPV_ARGS(&capture))) || FAILED(client->Start())) {
    logf("démarrage audio impossible");
    return 1;
  }
  logf("son : capture du processus %lu (48 kHz stéréo)", pid);
  std::thread(stdin_thread).detach();

  while (!g_quit) {
    WaitForSingleObject(evenement, 100);
    UINT32 n = 0;
    while (SUCCEEDED(capture->GetNextPacketSize(&n)) && n > 0) {
      BYTE *data = nullptr;
      UINT32 trames = 0;
      DWORD drapeaux = 0;
      UINT64 position = 0, qpc = 0;
      if (FAILED(capture->GetBuffer(&data, &trames, &drapeaux, &position, &qpc))) break;
      const uint32_t taille = trames * fmt.nBlockAlign;
      bool silence = (drapeaux & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
      if (!silence) {
        // Un tampon rempli de zéros est aussi un silence : rien à envoyer.
        silence = true;
        for (uint32_t i = 0; i < taille && silence; i++) silence = data[i] == 0;
      }
      if (!silence && taille) {
        const int64_t us = int64_t(qpc / 10);  // unités de 100 ns
        if (!ecrire(&taille, 4) || !ecrire(&us, 8) || !ecrire(data, taille)) g_quit = true;
        fflush(stdout);
      }
      capture->ReleaseBuffer(trames);
    }
  }
  client->Stop();
  return 0;
}
