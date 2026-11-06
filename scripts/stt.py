#!/usr/bin/env python3
"""Transcribe one inbound voice attachment to plain text.

Bundled with @ruqinhu/dsh-weixin-link. WeChat delivers voice as SILK, which
faster-whisper cannot read, so the audio is converted to 24 kHz mono WAV with `pilk`
first — the same path the inherited Hermes gateway used.

Configuration through the environment (all optional):
  DSH_STT_MODEL      faster-whisper model name (default: base)
  DSH_STT_LANGUAGE   spoken language (default: zh for this deployment)
  DSH_STT_PROMPT     initial prompt; unset by default, as in the official adapter
  DSH_STT_VAD        "0" disables VAD (default: on)

The transcription kwargs mirror the official `tools/transcription_local.py`
(`build_local_transcribe_kwargs`): beam_size 5, condition_on_previous_text False,
VAD on by default with a 500 ms minimum silence, and the confidence gates pushed into
faster-whisper itself so low-confidence non-English segments are not dropped before
our post-filter sees them. The default model is `base` (`DEFAULT_LOCAL_MODEL`).
"""

from __future__ import annotations

import os
import sys
import tempfile

# Set before importing faster_whisper: its loader checks Hugging Face for a newer
# model, and on a host that cannot reach HF that check blocks for minutes. The model is
# cached (`~/.cache/huggingface/hub/models--Systran--faster-whisper-base`), so offline
# mode is the correct default here.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("OMP_NUM_THREADS", "2")

SILK_SUFFIXES = (".silk", ".slk")

# Defaults from the official adapter.
VAD_MIN_SILENCE_MS = 500
NO_SPEECH_THRESHOLD = 0.6
LOG_PROB_THRESHOLD = -1.0


def die(message: str, code: int = 1) -> int:
    print(message, file=sys.stderr)
    return code


def silk_to_wav(silk: str, wav: str) -> None:
    import pilk

    pilk.silk_to_wav(silk, wav, rate=24_000)


def main() -> int:
    if len(sys.argv) < 2:
        return die("usage: stt.py <audio-file>", 2)

    source = sys.argv[1]
    if not os.path.exists(source):
        return die(f"audio file not found: {source}")

    workdir = tempfile.mkdtemp(prefix="dsh-stt-")
    wav = source
    if source.lower().endswith(SILK_SUFFIXES):
        wav = os.path.join(workdir, "audio.wav")
        try:
            silk_to_wav(source, wav)
        except Exception as error:  # noqa: BLE001 - the reason goes to stderr for the caller
            return die(f"silk decode failed: {error}")

    try:
        from faster_whisper import WhisperModel
    except Exception as error:  # noqa: BLE001
        return die(f"faster_whisper is not available: {error}")

    model_name = os.environ.get("DSH_STT_MODEL", "base")
    language = os.environ.get("DSH_STT_LANGUAGE", "zh")
    prompt = os.environ.get("DSH_STT_PROMPT", "").strip()
    vad_enabled = os.environ.get("DSH_STT_VAD", "1") not in {"0", "false", "False", ""}

    kwargs = {
        "language": language,
        "beam_size": 5,
        "condition_on_previous_text": False,
        "vad_filter": vad_enabled,
        "no_speech_threshold": NO_SPEECH_THRESHOLD,
        "log_prob_threshold": LOG_PROB_THRESHOLD,
    }
    if vad_enabled:
        kwargs["vad_parameters"] = {"min_silence_duration_ms": VAD_MIN_SILENCE_MS}
    if prompt:
        kwargs["initial_prompt"] = prompt

    try:
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
        segments, _info = model.transcribe(wav, **kwargs)
        text = "".join(segment.text for segment in segments).strip()
    except Exception as error:  # noqa: BLE001
        return die(f"transcription failed: {error}")

    if not text:
        return die("transcription produced no text")

    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
