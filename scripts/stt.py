#!/usr/bin/env python3
"""Transcribe one inbound voice attachment to plain text.

Bundled with @ruqinhu/dsh-weixin-link. WeChat delivers voice as SILK, which
faster-whisper cannot read, so the audio is converted to 24 kHz mono WAV with `pilk`
first — the same path the inherited Hermes gateway used.

Configuration through the environment (all optional):
  DSH_STT_MODEL     faster-whisper model name (default: base)
  DSH_STT_LANGUAGE  spoken language (default: zh)
  DSH_STT_PROMPT    initial prompt (default: simplified-Chinese hint)

The default model is `base` on purpose: this box has ~1.9 GB of memory shared with the
harness, and `small` was measured to starve the gateway. `int8` keeps the footprint
small; beam_size=5 and vad_filter=False are the settings the Hermes skill found
necessary for Mandarin (VAD was cutting short sentences into fragments).
"""

from __future__ import annotations

import os
import sys
import tempfile

SILK_SUFFIXES = (".silk", ".slk")


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
    prompt = os.environ.get("DSH_STT_PROMPT", "以下是简体中文普通话的对话内容。")

    try:
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
        segments, _info = model.transcribe(
            wav,
            language=language,
            vad_filter=False,
            beam_size=5,
            initial_prompt=prompt,
        )
        text = "".join(segment.text for segment in segments).strip()
    except Exception as error:  # noqa: BLE001
        return die(f"transcription failed: {error}")

    if not text:
        return die("transcription produced no text")

    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
