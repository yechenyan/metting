"""Archive the selected PCM packets on the same clock as the transcript."""

import os
import queue
import struct
import threading
from pathlib import Path


HEADER = struct.Struct("<4sI4s4sIHHIIHH4sI")
MAX_FRAMES = (0xFFFFFFFF - 36) // 2


class WaveTake:
    def __init__(self, directory, start, name):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        seconds, ms = divmod(start, 1000)
        minutes, sec = divmod(seconds, 60)
        hours, minute = divmod(minutes, 60)
        stem = f"{name} - {hours:02d}h{minute:02d}m{sec:02d}.{ms:03d}s"
        copy = 1
        while True:
            suffix = "" if copy == 1 else f" ({copy})"
            try:
                fd = os.open(directory / (stem + suffix + ".wav"), os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
                break
            except FileExistsError:
                copy += 1
        self.file = os.fdopen(fd, "w+b")
        self.start = start
        self.frames = self.checkpoint = 0
        try:
            self.update_header()
        except OSError:
            self.file.close()
            raise

    def update_header(self):
        size = self.frames * 2
        self.file.seek(0)
        self.file.write(HEADER.pack(b"RIFF", size + 36, b"WAVE", b"fmt ", 16,
                                    1, 1, 16000, 32000, 2, 16, b"data", size))
        self.file.flush()
        self.file.seek(HEADER.size + size)
        self.checkpoint = self.frames

    def write(self, frame, pcm):
        # Packet timestamps are whole milliseconds. Preserve contiguous PCM across rounding jitter.
        if self.frames and abs(frame - self.frames) <= 16:
            frame = self.frames
        # Gaps in the capture clock are silence. Trim duplicate samples on overlap.
        if frame < self.frames:
            pcm = pcm[(self.frames - frame) * 2:]
            frame = self.frames
        if not pcm:
            return
        if frame > self.frames:
            self.file.seek(HEADER.size + frame * 2)
        self.file.write(pcm)
        self.frames = frame + len(pcm) // 2
        if self.frames - self.checkpoint >= 16000:
            self.update_header()

    def close(self):
        try:
            self.update_header()
        finally:
            self.file.close()


class RecordingWriter:
    def __init__(self, directory, on_error, name="Recording"):
        self.directory = Path(directory)
        self.on_error = on_error
        self.name = name
        self.packets = queue.Queue(maxsize=128)
        self.thread = None
        self.failed = False

    def write(self, stamp, pcm):
        if self.failed or not pcm:
            return
        if self.thread is None:
            self.thread = threading.Thread(target=self._save, daemon=True)
            self.thread.start()
        self.packets.put((stamp, pcm))

    def _save(self):
        take = None
        try:
            while (packet := self.packets.get()) is not None:
                stamp, pcm = packet
                frame = (stamp - take.start) * 16 if take else 0
                if take and frame + len(pcm) // 2 > MAX_FRAMES:
                    take.close()
                    take = None
                if take is None:
                    take = WaveTake(self.directory, stamp, self.name)
                    frame = 0
                take.write(frame, pcm)
        except OSError as error:
            self.failed = True
            self.on_error(error)
        finally:
            if take and not take.file.closed:
                try:
                    take.close()
                except OSError as error:
                    if not self.failed:
                        self.failed = True
                        self.on_error(error)
            # Release a producer that was waiting for space when the disk failed.
            if self.failed:
                while True:
                    try:
                        self.packets.get_nowait()
                    except queue.Empty:
                        break

    def close(self):
        if self.thread:
            if not self.failed:
                self.packets.put(None)
            self.thread.join()
