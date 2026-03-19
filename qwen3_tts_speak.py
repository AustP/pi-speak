#!/usr/bin/env python3

import argparse
import queue
import threading

import numpy as np
import sounddevice as sd
from transformers import AutoTokenizer

from mlx_audio.tts.utils import load_model

MODEL_PATH = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit"
STREAMING_INTERVAL_SECONDS = 0.2
PLAYBACK_PREBUFFER_SECONDS = 0.1

_ORIGINAL_AUTO_TOKENIZER_FROM_PRETRAINED = AutoTokenizer.from_pretrained


def _patch_tokenizer_loader() -> None:
    def _from_pretrained_with_fixed_regex(*args, **kwargs):
        if "fix_mistral_regex" not in kwargs:
            kwargs["fix_mistral_regex"] = True

        return _ORIGINAL_AUTO_TOKENIZER_FROM_PRETRAINED(*args, **kwargs)

    AutoTokenizer.from_pretrained = _from_pretrained_with_fixed_regex


def speak_text(model, text: str) -> None:
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
            ref_audio="winston.wav",
            stream=True,
            streaming_interval=STREAMING_INTERVAL_SECONDS,
        ):
            audio = np.asarray(chunk.audio, dtype=np.float32).reshape(-1)
            if audio.size == 0:
                continue

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
    parser = argparse.ArgumentParser(
        description="Generate speech with Qwen3-TTS and play it immediately on macOS."
    )
    parser.add_argument("text", help="Text to speak")
    args = parser.parse_args()

    _patch_tokenizer_loader()
    model = load_model(MODEL_PATH)
    speak_text(model, args.text)


if __name__ == "__main__":
    main()
