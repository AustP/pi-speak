# Pi TTS + Winston Listener

This project adds hands-free voice I/O to Pi by combining:

1. **Speak mode extension** (`extensions/speak-mode.ts`)
2. **Session injector extension** (`extensions/pi-session-injector.ts`)
3. **Winston listener** Swift package (`listener/`)

When speak mode is ON, Pi loads a streaming Qwen3 TTS daemon and starts the Winston listener. When speak mode is OFF (or the session shuts down), both are stopped.

---

## Repository layout

- `extensions/speak-mode.ts` — `/speak` command, TTS lifecycle, listener lifecycle, streaming speech output
- `extensions/qwen3_tts_daemon.py` — long-lived Qwen3 TTS daemon (stdin JSON protocol)
- `extensions/pi-session-injector.ts` — UNIX socket server for external message injection
- `listener/` — Swift hotword listener + Superwhisper handoff
  - `listener/Sources/main.swift`
  - `listener/scripts/pi-inject.sh`
- `qwen3_tts_speak.py` / `speak` — one-shot local TTS helper
- `setup_venv.sh` / `requirements.txt` — Python environment setup
- `winston.wav` — reference voice sample used by TTS

---

## Behavior summary

### `/speak` OFF → ON

- Starts `extensions/qwen3_tts_daemon.py`
- Waits for daemon readiness
- Starts `swift run --package-path listener`
- Sets Pi status to `🔊 Speak: ON`

### While ON

- Assistant responses are spoken incrementally as sentences stream in
- On new user message, current playback is interrupted
- User gets an audible acknowledgment (`"Message received. Working..."`)
- If generation is taking a while, periodic `"Still working..."` updates are spoken
- A TTS control socket is exposed at:
  - `<os-tmpdir>/pi-tts-control.sock`
  - Sending `interrupt\n` to that socket interrupts current playback

### `/speak` ON → OFF (or session shutdown)

- Stops listener process
- Sends shutdown to TTS daemon and terminates it
- Cleans up control socket
- Sets Pi status to `🔇 Speak: OFF`

---

## Prerequisites

- macOS
- Python 3 (for TTS)
- Swift toolchain / Xcode command line tools (`xcode-select --install`)
- Superwhisper (used by listener flow)

---

## Setup

From repo root:

### 1) Create Python virtualenv + install dependencies

```bash
./setup_venv.sh
```

### 2) Install Pi extensions (symlinks)

```bash
ln -sf "$(pwd)/extensions/speak-mode.ts" "$HOME/.pi/agent/extensions/speak-mode.ts"
ln -sf "$(pwd)/extensions/pi-session-injector.ts" "$HOME/.pi/agent/extensions/pi-session-injector.ts"
```

### 3) Reload Pi extensions

In Pi:

```text
/reload
```

Optional verification in Pi:

```text
/inject-status
```

Expected injector socket path:

- `<os-tmpdir>/pi-session-inject.sock`

---

## Usage

In Pi:

- `/speak` — toggle speak mode ON/OFF

### End-to-end workflow (including Superwhisper)

1. Enable speak mode with `/speak`.
2. Pi starts:
   - the TTS daemon (`extensions/qwen3_tts_daemon.py`)
   - the Winston listener (`swift run --package-path listener`)
3. You say **Winston**.
4. Listener begins recording (with start cue + output ducking).
5. You speak your prompt.
6. You say **Winston** again to stop (or **Nevermind** to cancel).
7. On stop, listener sends the captured `.wav` to **Superwhisper**.
8. Superwhisper transcribes audio and writes text to clipboard.
9. Listener reads that transcript and injects it into your active Pi session through `pi-session-injector.ts` (`<os-tmpdir>/pi-session-inject.sock`).
10. Pi receives that as your user message and starts responding.
11. While Pi responds, `speak-mode.ts` streams spoken output sentence-by-sentence.
12. If you start a new request, current speech is interrupted and Pi acknowledges with: `"Message received. Working..."`.

For listener-level details (focus handling, clipboard restore, capture cleanup), see: `listener/README.md`.

---

## Standalone one-shot TTS

From repo root:

```bash
./speak "Hello from Winston"
```

---

## Socket paths

- Injector socket: `<os-tmpdir>/pi-session-inject.sock`
- TTS control socket: `<os-tmpdir>/pi-tts-control.sock`

Both are derived from OS temp dir (`os.tmpdir()` in Node / `$TMPDIR` fallback in shell).

---

## Troubleshooting

- If `/speak` fails with missing Python executable, run `./setup_venv.sh`.
- If injection fails, check `/inject-status` and confirm the injector extension is loaded.
- If listener fails to run, verify Swift CLI tools and Superwhisper installation.
- If permissions dialogs block capture, grant Microphone and Speech Recognition access in macOS settings.
