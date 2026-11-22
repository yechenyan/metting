"""Assign meeting-scoped identities from audio independently of capture channels."""

import json
from pathlib import Path
import numpy as np
import sherpa_onnx as sherpa

RATE = 16000


class Voices:
    def __init__(self, root, profile):
        embedding = sherpa.SpeakerEmbeddingExtractorConfig(
            model=str(root / "nemo_en_titanet_small.onnx"), num_threads=2
        )
        segmentation = sherpa.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=str(
                    root / "sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx"
                ),
                window_shift_ratio=0.25,
            ),
            num_threads=2,
        )
        self.model = sherpa.OfflineSpeakerDiarization(
            sherpa.OfflineSpeakerDiarizationConfig(
                segmentation=segmentation,
                embedding=embedding,
                clustering=sherpa.FastClusteringConfig(num_clusters=-1, threshold=0.45),
                min_duration_on=0.25,
                min_duration_off=0.35,
            )
        )
        self.extractor = sherpa.SpeakerEmbeddingExtractor(embedding)
        self.path = Path(profile)
        saved = json.loads(self.path.read_text()) if self.path.exists() else {}
        self.centers = {k: np.array(v) for k, v in saved.items()}

    def assign(self, clips, excluded):
        if not clips:
            return "unknown"
        samples = np.concatenate(clips)
        if len(samples) < RATE * 0.9:
            return "unknown"
        stream = self.extractor.create_stream()
        stream.accept_waveform(RATE, samples)
        stream.input_finished()
        if not self.extractor.is_ready(stream):
            return "unknown"
        vector = np.asarray(self.extractor.compute(stream))
        vector = vector / max(float(np.linalg.norm(vector)), 1e-9)
        if not np.isfinite(vector).all():
            return "unknown"
        scores = sorted(
            (
                (float(vector @ v), k)
                for k, v in self.centers.items()
                if k not in excluded
            ),
            reverse=True,
        )
        if scores and scores[0][0] >= 0.50:
            score, key = scores[0]
            if len(scores) > 1 and score - scores[1][0] < 0.04:
                return "unknown"
            if score > 0.61:
                avg = self.centers[key] * 0.85 + vector * 0.15
                self.centers[key] = avg / np.linalg.norm(avg)
            return key
        if scores and scores[0][0] > 0.43:
            return "unknown"
        key = "S" + str(len(self.centers) + 1)
        self.centers[key] = vector
        return key

    def detect(self, samples, offset):
        turns = self.model.process(samples).sort_by_start_time()
        if not turns:
            return []
        clips = {}
        for turn in turns:
            # Only clean, non-overlapping samples enter the voice registry.
            clean = [(turn.start, turn.end)]
            for other in turns:
                if other.speaker == turn.speaker:
                    continue
                clean = [
                    (l, r)
                    for a, b in clean
                    for l, r in [(a, min(b, other.start)), (max(a, other.end), b)]
                    if r > l
                ]
            clips.setdefault(turn.speaker, []).extend(
                samples[int(a * RATE) : int(b * RATE)] for a, b in clean
            )
        labels = {}
        for key, audio in sorted(
            clips.items(), key=lambda x: -sum(len(c) for c in x[1])
        ):
            labels[key] = self.assign(audio, set(labels.values()))
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps({k: v.tolist() for k, v in self.centers.items()}))
        temp.chmod(0o600)
        temp.replace(self.path)
        return [
            dict(
                start=round(offset + t.start * 1000),
                end=round(offset + t.end * 1000),
                speaker=labels[t.speaker],
                overlap=any(
                    o.speaker != t.speaker
                    and min(t.end, o.end) - max(t.start, o.start) > 0.12
                    for o in turns
                ),
            )
            for t in turns
        ]
