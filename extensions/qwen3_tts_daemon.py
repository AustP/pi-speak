#!/usr/bin/env python3

import json
import queue
import re
import signal
import sys
import threading
from pathlib import Path

import numpy as np
import sounddevice as sd
from mlx_lm import generate as mlx_generate
from mlx_lm import load as mlx_load

from mlx_audio.tts.utils import load_model

MODEL_PATH = "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit"
SUMMARIZER_MODEL_PATH = "mlx-community/Qwen3.5-0.8B-MLX-8bit"
REFERENCE_AUDIO_FILENAME = "winston.wav"
STREAMING_INTERVAL_SECONDS = 0.2
PLAYBACK_PREBUFFER_SECONDS = 0.1
PLAYBACK_GAIN = 2.5
SUMMARY_INPUT_MAX_CHARS = 7000
SUMMARY_MAX_TOKENS = 8192

_SHUTTING_DOWN = False


def _handle_signal(_signum, _frame) -> None:
    global _SHUTTING_DOWN
    _SHUTTING_DOWN = True


def _drain_queue(speak_queue: queue.Queue[dict | None]) -> None:
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


def summarize_for_speech(tokenizer, model, text: str) -> str:
    trimmed = text.strip()
    if not trimmed:
        return ""

    prompt_text = trimmed[:SUMMARY_INPUT_MAX_CHARS]
    messages = [
        {
            "role": "system",
            "content": (
                "You rewrite assistant output for a text-to-speech engine. "
                "Return only plain text that sounds natural when spoken aloud. "
                "Use short, clear sentences and avoid markdown, code formatting, and symbols that are awkward to pronounce."
            ),
        },
        {
            "role": "user",
            "content": (
                "Summarize this into 2 to 4 short, speaker-friendly sentences for TTS playback. "
                "Keep the important outcome and concrete next step. "
                "Use plain spoken language with no markdown or list formatting.\n\n"
                f"{prompt_text}"
            ),
        },
    ]

    prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    summary = mlx_generate(
        model,
        tokenizer,
        prompt=prompt,
        max_tokens=SUMMARY_MAX_TOKENS,
        verbose=False,
    )
    return " ".join(summary.replace("\n", " ").split()).strip()


def spoken_path(value: str) -> str:
    spoken = re.sub(r"^\.?/", "", value)
    spoken = re.sub(r"[\\/]+", " slash ", spoken)
    spoken = spoken.replace(".", " dot ")
    spoken = re.sub(r"[-_]+", " ", spoken)
    return re.sub(r"\s+", " ", spoken).strip()


def speakify_text(text: str) -> str:
    without_links = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", text)
    without_headings = re.sub(r"^\s{0,3}#{1,6}\s+", "", without_links, flags=re.MULTILINE)
    without_code_fences = without_headings.replace("```", " ")
    without_markdown = re.sub(r"\*\*(.*?)\*\*", r"\1", without_code_fences)
    without_markdown = re.sub(r"`([^`]+)`", r"\1", without_markdown)

    def _path_replacer(match: re.Match[str]) -> str:
        prefix = match.group(1) or ""
        value = match.group(2) or ""
        if "/" not in value:
            return f"{prefix}{value}"
        return f"{prefix}{spoken_path(value)}"

    path_friendly = re.sub(
        r"(^|\s)([.~]?[A-Za-z0-9_./-]*/[A-Za-z0-9_./-]+)(?=\s|$)",
        _path_replacer,
        without_markdown,
    )

    stream_terms_friendly = re.sub(r"\bstderr\b", "STD err", path_friendly, flags=re.IGNORECASE)
    stream_terms_friendly = re.sub(r"\bstdout\b", "STD out", stream_terms_friendly, flags=re.IGNORECASE)
    stream_terms_friendly = re.sub(r"\bstdin\b", "STD in", stream_terms_friendly, flags=re.IGNORECASE)
    stream_terms_friendly = re.sub(
        r"\bwinston\b",
        "He Who Must Not Be Named",
        stream_terms_friendly,
        flags=re.IGNORECASE,
    )
    slash_friendly = stream_terms_friendly.replace("/", " slash ")
    decimal_friendly = re.sub(r"\b\d+(?:\.\d+)+\b", lambda m: m.group(0).replace(".", " point "), slash_friendly)

    cleaned_lines = [re.sub(r"[ \t]+", " ", line).strip() for line in decimal_friendly.splitlines()]
    return "\n".join(line for line in cleaned_lines if line).strip()


def split_into_tts_chunks(text: str) -> list[str]:
    normalized = re.sub(r"\s+", " ", text).strip()
    if not normalized:
        return []

    sentence_like = re.findall(r"[^.!?]+[.!?]+(?:[\"')\]]+)?|[^.!?]+$", normalized)
    sentences = [s.strip() for s in sentence_like if s.strip()]
    if not sentences:
        return [normalized]

    return sentences


def main() -> None:
    global _SHUTTING_DOWN

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    tts_model = load_model(MODEL_PATH)
    if getattr(tts_model, "tokenizer", None) is None:
        print("STARTUP_ERROR: tokenizer failed to load", file=sys.stderr, flush=True)
        sys.exit(1)

    summarize_model, summarize_tokenizer = mlx_load(SUMMARIZER_MODEL_PATH)

    reference_audio_path = str(Path.cwd() / REFERENCE_AUDIO_FILENAME)

    speak_queue: queue.Queue[dict | None] = queue.Queue()
    interrupt_event = threading.Event()

    def speaker_worker() -> None:
        while not _SHUTTING_DOWN:
            task = speak_queue.get()
            if task is None:
                break

            interrupt_event.clear()

            try:
                task_type = task.get("type")
                task_text = str(task.get("text", "")).strip()
                if not task_text:
                    continue

                text_to_speak = task_text
                if task_type == "summarize_speak":
                    text_to_speak = summarize_for_speech(summarize_tokenizer, summarize_model, task_text)
                    if not text_to_speak:
                        continue

                spoken_text = speakify_text(text_to_speak)
                if not spoken_text:
                    continue

                chunks = split_into_tts_chunks(spoken_text)
                for chunk in chunks:
                    if interrupt_event.is_set() or _SHUTTING_DOWN:
                        break
                    speak_text(tts_model, chunk, reference_audio_path, interrupt_event)
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

        if message_type not in {"speak", "summarize_speak"}:
            continue

        text = message.get("text")
        if not isinstance(text, str):
            continue

        trimmed = text.strip()
        if not trimmed:
            continue

        speak_queue.put({"type": message_type, "text": trimmed})

    worker.join()
    print("BYE", flush=True)


if __name__ == "__main__":
    main()
