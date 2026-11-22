import json
import struct
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory, TemporaryFile
from unittest.mock import Mock, patch

from modules.speech import worker
from modules.speech.capture.recording import RecordingWriter


def saved_pcm(path):
    with wave.open(str(path), "rb") as audio:
        assert (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) == (1, 2, 16000)
        return audio.readframes(audio.getnframes())


class InputSelectionTests(unittest.TestCase):
    def test_only_selected_packets_reach_the_stream_and_sentence_decoders(self):
        frames = [struct.pack("<160h", *([level] * 160)) for level in (2000, 700)]
        for source_id, name in enumerate(("system", "mic")):
            with self.subTest(source=name), TemporaryDirectory() as directory, TemporaryFile(buffering=0) as pipe:
                pipe.write(bytes([source_id]))
                for slot in range(24):
                    for channel, frame in enumerate(frames):
                        stamp = 1800 + slot * 10
                        pipe.write(worker.HEADER.pack(channel, stamp, len(frame)) + frame)
                pipe.write(b"\x00\x02")  # The last capture header was interrupted.
                pipe.seek(0)
                decoder = Mock()
                decoder.AcceptWaveform.return_value = False
                decoder.PartialResult.return_value = json.dumps({"partial": "live"})
                decoder.FinalResult.return_value = json.dumps({"text": "finished"})
                submit = Mock()
                events = []
                writer = RecordingWriter(directory, self.fail)
                with patch.object(worker, "KaldiRecognizer", return_value=decoder) as factory, \
                     patch.object(worker, "emit", events.append):
                    try:
                        worker.transcribe_capture(pipe, object(), "de", 3400, submit, writer.write)
                    finally:
                        writer.close()
                factory.assert_called_once()
                submit.assert_called_once()
                row, audio = submit.call_args.args
                self.assertEqual(audio, frames[source_id] * 24)
                take, = Path(directory).glob("*.wav")
                self.assertEqual(take.name, "Recording - 00h00m03.400s.wav")
                self.assertEqual(saved_pcm(take), audio)
                self.assertEqual([args[0][0] for args in decoder.AcceptWaveform.call_args_list],
                                 [frames[source_id]] * 24)
                self.assertEqual((row["start"], row["end"], row["captureSource"]),
                                 (3400, 3640, name))
                segments = [e["segment"] for e in events if e["kind"] == "segment"]
                self.assertEqual([s["stage"] for s in segments], ["partial", "stream"])
                self.assertEqual({s["id"] for s in segments}, {row["id"]})
                self.assertTrue(all(e["levels"][1 - source_id] == 0
                                    for e in events if e["kind"] == "levels"))

    def test_selected_silence_is_saved_without_a_transcript_and_an_interrupted_sample_is_trimmed(self):
        with TemporaryDirectory() as directory, TemporaryFile(buffering=0) as pipe:
            folder = Path(directory) / "audio"
            writer = RecordingWriter(folder, self.fail)
            pipe.write(bytes([1]))
            pipe.write(worker.HEADER.pack(0, 400, 18) + bytes(18))
            pipe.write(worker.HEADER.pack(1, 700, 320) + bytes(320))
            pipe.write(worker.HEADER.pack(1, 710, 320) + bytes(15))
            pipe.seek(0)
            with patch.object(worker, "KaldiRecognizer"), patch.object(worker, "emit"):
                worker.transcribe_capture(pipe, object(), "en", 0, self.fail, writer.write)
            writer.close()
            take, = folder.glob("*.wav")
            self.assertEqual(saved_pcm(take), bytes(334))

    def test_takes_preserve_gaps_bound_overlaps_and_append_on_resume(self):
        with TemporaryDirectory() as directory:
            folder = Path(directory) / "audio"
            writer = RecordingWriter(folder, self.fail)
            writer.close()
            self.assertFalse(folder.exists())
            packet = struct.pack("<160h", *range(1, 161))
            writer.write(300, packet)
            writer.write(309, packet)  # One millisecond of native timestamp rounding.
            writer.write(335, packet)  # Fifteen milliseconds of missing samples.
            writer.write(340, packet)  # The first five milliseconds already exist.
            writer.close()
            first, = folder.glob("*.wav")
            expected = packet * 2 + bytes(480) + packet + packet[160:]
            self.assertEqual(saved_pcm(first), expected)
            resumed = RecordingWriter(folder, self.fail)
            resumed.write(500, packet)
            resumed.close()
            takes = sorted(folder.glob("*.wav"))
            self.assertEqual(len(takes), 2)
            self.assertEqual(saved_pcm(takes[0]), expected)
            self.assertEqual(saved_pcm(takes[1]), packet)

    def test_duplicate_start_times_preserve_both_named_takes(self):
        with TemporaryDirectory() as directory:
            for sample in (b"\x01\x00", b"\x02\x00"):
                writer = RecordingWriter(directory, self.fail, "Review - Discussion")
                writer.write(1234, sample)
                writer.close()
            stem = "Review - Discussion - 00h00m01.234s"
            self.assertEqual(saved_pcm(Path(directory) / (stem + ".wav")), b"\x01\x00")
            self.assertEqual(saved_pcm(Path(directory) / (stem + " (2).wav")), b"\x02\x00")

    def test_an_archive_error_is_reported_once_and_does_not_block_capture(self):
        with TemporaryDirectory() as directory:
            occupied = Path(directory) / "audio"
            occupied.touch()
            errors = []
            writer = RecordingWriter(occupied, errors.append)
            for stamp in range(450):
                writer.write(stamp, bytes(32))
            writer.close()
            self.assertEqual(len(errors), 1)
            self.assertIsInstance(errors[0], OSError)
