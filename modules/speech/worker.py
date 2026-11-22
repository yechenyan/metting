"""Consume framed 16 kHz PCM. Keep the streaming decoder independent of refinement."""

import argparse
import json
import multiprocessing as mp
import queue
import re
import select
import struct
import sys
import threading
import uuid
from collections import deque
from pathlib import Path
import numpy as np
from vosk import Model, KaldiRecognizer, SetLogLevel

MODELS = {
    "en": "vosk-model-small-en-us-0.15",
    "zh": "vosk-model-small-cn-0.22",
    "de": "vosk-model-small-de-0.15",
}
HEADER = struct.Struct("<BQI")
LOCK = threading.Lock()


def emit(event):
    with LOCK:
        print(json.dumps(event, ensure_ascii=False, separators=(",", ":")), flush=True)


def normalize(text, language):
    if language == "zh":
        return re.sub(r"(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])", "", text).strip()
    return text.strip()


class Track:
    def __init__(self, model, lang, source, submit):
        self.rec = KaldiRecognizer(model, 16000)
        self.lang, self.source, self.submit = lang, source, submit
        self.pre = deque()
        self.pre_bytes = 0
        self.pcm = bytearray()
        self.last_partial = ""
        self.last_poll = -1000
        self.start = None
        self.end = 0
        self.identifier = ""
        self.input_end = None

    def row(self, text, stage):
        return dict(
            id=self.identifier,
            start=int(self.start),
            end=int(self.end),
            raw=normalize(text, self.lang),
            stage=stage,
            language=self.lang,
            captureSource=self.source,
            speaker="unknown",
            revision=0,
        )

    def feed(self, stamp, pcm, rms):
        if self.input_end is not None and stamp > self.input_end + 1:
            gap = round((stamp - self.input_end) * 16)
            if gap <= 12800:
                self.accept(self.input_end, bytes(gap * 2), 0.0)
            else:
                self.finish()
                self.pre.clear()
                self.pre_bytes = 0
        self.input_end = stamp + len(pcm) / 32
        self.accept(stamp, pcm, rms)

    def accept(self, stamp, pcm, rms):
        if self.start is None:
            if rms < 0.002:
                self.pre.append((stamp, pcm))
                self.pre_bytes += len(pcm)
                while self.pre_bytes > 9600:
                    self.pre_bytes -= len(self.pre.popleft()[1])
                return
            self.start = self.pre[0][0] if self.pre else stamp
            self.identifier = uuid.uuid4().hex
            for _, prior in self.pre:
                self.rec.AcceptWaveform(prior)
                self.pcm.extend(prior)
            self.pre.clear()
            self.pre_bytes = 0
        self.pcm.extend(pcm)
        self.end = stamp + len(pcm) / 32
        endpoint = self.rec.AcceptWaveform(pcm)
        if endpoint or len(self.pcm) >= 16000 * 2 * 14:
            self.finish(endpoint)
        elif stamp - self.last_poll >= 70:
            self.last_poll = stamp
            text = json.loads(self.rec.PartialResult()).get("partial", "")
            if text and text != self.last_partial:
                self.last_partial = text
                emit({"kind": "segment", "segment": self.row(text, "partial")})

    def finish(self, endpoint=False):
        if self.start is None:
            return
        result = self.rec.Result() if endpoint else self.rec.FinalResult()
        text = json.loads(result).get("text", "") or self.last_partial
        if text:
            row = self.row(text, "stream")
            emit({"kind": "segment", "segment": row})
            self.submit(row, bytes(self.pcm))
        self.rec.Reset()
        self.pcm.clear()
        self.start, self.last_partial = None, ""


def amplitude(pcm):
    if not pcm:
        return 0.0
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
    return float(np.sqrt(np.mean(samples * samples))) / 32768


def read_packet_bytes(pipe, size):
    data = pipe.read(size)
    if len(data) == size or not data:
        return data
    result = bytearray(data)
    while len(result) < size:
        part = pipe.read(size - len(result))
        if not part:
            break
        result.extend(part)
    return bytes(result)


def transcribe_capture(pipe, model, language, offset, submit, record=None):
    # The server sends the selected source byte on Start, after model preloading.
    selection = pipe.read(1)
    if not selection:
        return
    selected_channel = selection[0]
    if selected_channel not in (0, 1):
        raise ValueError("Unknown capture source")
    source = ("system", "mic")[selected_channel]
    track = Track(model, language, source, submit)
    levels, last_level = [0.0, 0.0], -250
    origin = None

    emit({"kind": "ready"})
    while True:
        if track.start is not None and not select.select([pipe], [], [], 0.8)[0]:
            track.finish()
            continue
        header = read_packet_bytes(pipe, HEADER.size)
        if len(header) < HEADER.size:
            break
        channel, stamp, size = HEADER.unpack(header)
        if channel > 1 or size > 320000 or size % 2:
            raise ValueError("Invalid audio packet")
        pcm = read_packet_bytes(pipe, size)
        # The native helper can exit in the middle of its last write on stop.
        if len(pcm) % 2:
            pcm = pcm[:-1]
        if not pcm or channel != selected_channel:
            continue
        if origin is None:
            origin = stamp
        timeline_stamp = offset + stamp - origin
        if record is not None:
            record(timeline_stamp, pcm)
        rms = amplitude(pcm)
        levels[channel] = min(1.0, rms * 9)
        if stamp - last_level >= 160:
            emit({"kind": "levels", "levels": levels})
            last_level = stamp
        track.feed(timeline_stamp, pcm, rms)
    track.finish()


def run(args):
    from recognition.final import refine
    from capture.recording import RecordingWriter

    SetLogLevel(-1)
    jobs, results = mp.Queue(maxsize=16), mp.Queue()
    child = mp.Process(
        target=refine, args=(args.models, args.profile, args.language, jobs, results)
    )
    child.start()
    pending = {}
    done = threading.Event()

    def forward():
        while True:
            try:
                event = results.get(timeout=0.5)
            except queue.Empty:
                if child.is_alive():
                    continue
                break
            if event["kind"] == "finalEnd":
                break
            if event["kind"] == "segment":
                pending.pop(event["segment"]["id"], None)
            emit(event)
        done.set()
        for key in list(pending):
            fallback = pending.pop(key, None)
            if fallback:
                emit({"kind": "segment", "segment": {**fallback, "stage": "final", "refinement": "fallback"}})

    relay = threading.Thread(target=forward, daemon=True)
    relay.start()

    def submit(row, pcm):
        if child.is_alive() and not done.is_set():
            try:
                pending[row["id"]] = row
                jobs.put_nowait((row, pcm))
                return
            except queue.Full:
                pending.pop(row["id"], None)
        emit({"kind": "warning", "code": "finalBacklog"})
        emit({"kind": "segment", "segment": {**row, "stage": "final", "refinement": "fallback"}})

    try:
        model = Model(str(Path(args.models) / MODELS[args.language]))
        # Unbuffered reads keep select and the parser on the same file descriptor.
        recording = RecordingWriter(
            args.audio_dir or Path(args.profile).parent / "audio",
            lambda error: emit({"kind": "warning", "code": "audioStorageError", "detail": str(error)}),
        )
        try:
            transcribe_capture(
                sys.stdin.buffer.raw, model, args.language, args.offset, submit, recording.write
            )
        finally:
            recording.close()
        if child.is_alive() and not done.is_set():
            while child.is_alive():
                try:
                    jobs.put(None, timeout=0.2)
                    break
                except queue.Full:
                    continue
        relay.join(timeout=60)
        for row in list(pending.values()):
            emit({"kind": "segment", "segment": {**row, "stage": "final", "refinement": "fallback"}})
    finally:
        child.join(timeout=2)
        if child.is_alive():
            child.terminate()
            child.join()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", required=True)
    parser.add_argument("--language", choices=MODELS, required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--audio-dir")
    parser.add_argument("--offset", type=int, default=0)
    run(parser.parse_args())
