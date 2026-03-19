#!/usr/bin/env python3

import json
import queue
import signal
import sys
import threading
from pathlib import Path

import numpy as np
import sounddevice as sd

from mlx_audio.tts.utils import load_model

MODEL_PATH = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit"
REFERENCE_AUDIO_FILENAME = "winston.wav"
STREAMING_INTERVAL_SECONDS = 0.2
PLAYBACK_PREBUFFER_SECONDS = 0.1
PLAYBACK_GAIN = 2.5

_SHUTTING_DOWN = False


def _handle_signal(_signum, _frame) -> None:
    global _SHUTTING_DOWN
    _SHUTTING_DOWN = True


def _drain_queue(speak_queue: queue.Queue[str | None]) -> None:
    while True:
        try:
            speak_queue.get_nowait()
        except queue.Empty:
            break


def speak_text(model, text: str, reference_audio_path: str, stop_event: threading.Event) -> None:
    audio_queue: queue.Queue[np.ndarray | None] = queue.Queue()
    playback_ready = threading.Event()
    buffered_samples_lock = threading.Lock()
    buffered_samples = 0
    sample_rate = None

    def playback_worker(sr: int) -> None:
        nonlocal buffered_samples

        playback_ready.wait()
        with sd.OutputStream(
            samplerate=sr,
            channels=1,
            dtype="float32",
            blocksize=0,
            latency="high",
        ) as stream:
            while True:
                if stop_event.is_set() or _SHUTTING_DOWN:
                    break

                chunk = audio_queue.get()
                if chunk is None:
                    break

                stream.write(chunk)
                with buffered_samples_lock:
                    buffered_samples -= len(chunk)

    playback_thread: threading.Thread | None = None

    try:
        for chunk in model.generate(
            text=text,
            ref_audio=reference_audio_path,
            stream=True,
            streaming_interval=STREAMING_INTERVAL_SECONDS,
        ):
            if stop_event.is_set() or _SHUTTING_DOWN:
                break

            audio = np.asarray(chunk.audio, dtype=np.float32).reshape(-1)
            if audio.size == 0:
                continue

            audio = np.clip(audio * PLAYBACK_GAIN, -1.0, 1.0)

            if sample_rate is None:
                sample_rate = chunk.sample_rate
                playback_thread = threading.Thread(
                    target=playback_worker,
                    args=(sample_rate,),
                    daemon=True,
                )
                playback_thread.start()

            audio_queue.put(audio)
            with buffered_samples_lock:
                buffered_samples += len(audio)
                buffered_duration = buffered_samples / sample_rate

            if buffered_duration >= PLAYBACK_PREBUFFER_SECONDS:
                playback_ready.set()

        if playback_thread is not None:
            playback_ready.set()
            audio_queue.put(None)
            playback_thread.join()
    finally:
        if playback_thread is not None and playback_thread.is_alive():
            playback_ready.set()
            audio_queue.put(None)
            playback_thread.join()


def main() -> None:
    global _SHUTTING_DOWN

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    model = load_model(MODEL_PATH)
    if getattr(model, "tokenizer", None) is None:
        print("STARTUP_ERROR: tokenizer failed to load", file=sys.stderr, flush=True)
        sys.exit(1)

    reference_audio_path = str(Path.cwd() / REFERENCE_AUDIO_FILENAME)

    speak_queue: queue.Queue[str | None] = queue.Queue()
    interrupt_event = threading.Event()

    def speaker_worker() -> None:
        while not _SHUTTING_DOWN:
            text = speak_queue.get()
            if text is None:
                break

            interrupt_event.clear()

            try:
                speak_text(model, text, reference_audio_path, interrupt_event)
            except Exception as error:
                print(f"SPEAK_ERROR: {error}", file=sys.stderr, flush=True)
                continue

    worker = threading.Thread(target=speaker_worker, daemon=True)
    worker.start()

    print("READY", flush=True)

    for line in sys.stdin:
        if _SHUTTING_DOWN:
            break

        raw = line.strip()
        if not raw:
            continue

        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            continue

        message_type = message.get("type")

        if message_type == "shutdown":
            _SHUTTING_DOWN = True
            interrupt_event.set()
            _drain_queue(speak_queue)
            speak_queue.put(None)
            break

        if message_type == "interrupt":
            interrupt_event.set()
            _drain_queue(speak_queue)
            continue

        if message_type != "speak":
            continue

        text = message.get("text")
        if not isinstance(text, str):
            continue

        trimmed = text.strip()
        if not trimmed:
            continue

        speak_queue.put(trimmed)

    worker.join()
    print("BYE", flush=True)


if __name__ == "__main__":
    main()
