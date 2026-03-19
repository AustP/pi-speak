# Winston Listener (macOS, no Picovoice)

This version uses only Apple frameworks for live listening:

1. Continuous shared-mic listening in background
2. Live transcription via Apple Speech framework
3. Keyword toggle using the same word
   - Say **Winston** to start recording
   - Say **Winston** again to stop recording
4. Captured file is opened in Superwhisper for transcription
5. While recording, system output volume is ducked, then restored when recording stops
6. Audible cues play on start/stop recording
7. Say **Nevermind** to cancel the current recording (listener stays running)

## Requirements

- macOS 13+
- Xcode command line tools (`xcode-select --install`)
- Superwhisper installed

## Pi Extension Setup (one-time)

This repo ships the injector extension at:

- `extensions/pi-session-injector.ts`

Install it into Pi's extension directory as a symlink (run from repo root):

```bash
ln -sf "$(pwd)/extensions/pi-session-injector.ts" "$HOME/.pi/agent/extensions/pi-session-injector.ts"
```

In your interactive Pi terminal, run:

```text
/reload
```

Then verify:

```text
/inject-status
```

It should show socket path:

- `<os-tmpdir>/pi-session-inject.sock`

## Run

From this folder:

```bash
swift run
```

On first run, macOS will ask for:
- Microphone permission
- Speech Recognition permission

## Output

Captured files are saved to:

- `./captures`

Each completed file is handed to Superwhisper via:

```bash
open -g -j -a Superwhisper /path/to/file.wav
```

After Superwhisper writes transcription to clipboard, this listener will:
1. Inject text into your active Pi session through the socket extension
2. Restore your prior clipboard text
3. Delete the `.wav` file

## Notes

- This uses normal shared mic access, so Discord/Zoom/etc can still use your microphone.
- The listener restarts each recognition task automatically when Apple returns a final result or an error.
- Keyword matching is whole-word, case-insensitive (`winston`).
- Output ducking uses macOS volume controls via AppleScript (`osascript`).
- Default duck level is 0% (mute while recording); change `duckedOutputVolumePercent` in `Sources/main.swift` if you want a different level.
- Start/stop cues use macOS system sounds (`Glass` on start, `Pop` on stop, `Funk` on Nevermind-cancel).
- Stop keyword is ignored for ~1.8s right after start to prevent immediate self-stop.
- Stop keyword is matched from the latest recognized word while recording (final or partial), with de-duplication to avoid repeated triggers.
- Start keyword is ignored for ~2.0s after stop/cancel to prevent immediate retrigger from trailing recognition updates.
- Say `never mind` (or `nevermind`) while recording to cancel the current capture without stopping the listener.
- Superwhisper handoff uses `open -g -j`; if macOS/Superwhisper still steals focus, the listener re-activates the previously frontmost app after clipboard capture/injection completes.
