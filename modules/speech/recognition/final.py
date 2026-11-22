"""Decode utterances in a separate process and align texts with acoustic turns."""

from pathlib import Path
import numpy as np


def turn_ranges(spans, start, end):
    if not spans:
        return [(start, end, "unknown", [])]
    if any(s["overlap"] for s in spans):
        return [(start, end, "unknown", spans)]
    groups = []
    for span in spans:
        if groups and groups[-1][-1]["speaker"] == span["speaker"]:
            groups[-1].append(span)
        else:
            groups.append([span])
    edges = [start]
    for left, right in zip(groups, groups[1:]):
        edges.append(round((left[-1]["end"] + right[0]["start"]) / 2))
    edges.append(end)
    return [
        (edges[i], edges[i + 1], group[0]["speaker"], group)
        for i, group in enumerate(groups)
    ]


def decode(model, samples, lang):
    parts = model.transcribe(samples, language=lang)
    separator = "" if lang == "zh" else " "
    return separator.join(
        part.text.strip() for part in parts if part.text.strip()
    ).strip()


def refine(root_path, profile, lang, jobs, results):
    root = Path(root_path)
    try:
        from pywhispercpp.model import Model
        from diarization.voices import Voices

        whisper = Model(
            str(root / "ggml-small-q5_1.bin"),
            n_threads=4,
            print_progress=False,
            print_realtime=False,
            print_timestamps=False,
            no_context=True,
            language=lang,
        )
        voices = Voices(root, profile)
        results.put({"kind": "finalReady"})
        while True:
            job = jobs.get()
            if job is None:
                break
            row, pcm = job
            samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
            try:
                spans = voices.detect(samples, row["start"])
            except Exception as exc:
                spans = []
                results.put(
                    {"kind": "warning", "code": "speakerError", "detail": str(exc)}
                )
            turns = turn_ranges(spans, row["start"], row["end"])
            if spans:
                results.put(
                    {
                        "kind": "speakers",
                        "id": row["id"],
                        "speaker": turns[0][2] if len(turns) == 1 else "unknown",
                        "spans": spans,
                    }
                )
            entries = []
            try:
                for start, end, speaker, intervals in turns:
                    begin_sample = max(0, round((start - row["start"]) * 16))
                    end_sample = min(len(samples), round((end - row["start"]) * 16))
                    text = decode(whisper, samples[begin_sample:end_sample], lang)
                    if text:
                        entries.append(
                            {
                                **row,
                                "id": row["id"]
                                if not entries
                                else row["id"] + "-" + str(len(entries)),
                                "start": start,
                                "end": end,
                                "stage": "final",
                                "streamId": row["id"],
                                "refinement": "recognized",
                                "raw": text,
                                "speaker": speaker,
                                "spans": intervals,
                            }
                        )
            except Exception as exc:
                results.put(
                    {"kind": "warning", "code": "refineError", "detail": str(exc)}
                )
                entries = []
            if not entries:
                entries = [{**row, "stage": "final", "spans": spans, "refinement": "fallback"}]
            for entry in entries:
                results.put({"kind": "segment", "segment": entry})
    except Exception as exc:
        results.put({"kind": "warning", "code": "refineError", "detail": str(exc)})
    finally:
        results.put({"kind": "finalEnd"})
