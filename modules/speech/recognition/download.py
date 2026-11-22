"""Install the local speech assets. Downloads are verified before installation."""

import fcntl
import hashlib
import shutil
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

VOSK = "https://alphacephei.com/vosk/models/"
SHERPA = "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
assets = [
    (
        "vosk-model-small-cn-0.22",
        VOSK + "vosk-model-small-cn-0.22.zip",
        "3af8b0e7e0f835ae9d414ce5df580237a3cfb08d586c9fbbb0f7ff29ad5b14ba",
    ),
    (
        "vosk-model-small-en-us-0.15",
        VOSK + "vosk-model-small-en-us-0.15.zip",
        "30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498",
    ),
    (
        "vosk-model-small-de-0.15",
        VOSK + "vosk-model-small-de-0.15.zip",
        "b7e53c90b1f0a38456f4cd62b366ecd58803cd97cd42b06438e2c131713d5e43",
    ),
    (
        "ggml-small-q5_1.bin",
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
        "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    ),
    (
        "nemo_en_titanet_small.onnx",
        SHERPA + "speaker-recongition-models/nemo_en_titanet_small.onnx",
        "ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e",
    ),
    (
        "sherpa-onnx-pyannote-segmentation-3-0",
        SHERPA
        + "speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
        "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488",
    ),
]


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def install(root, name, url, checksum):
    dest = root / name
    archive_model = url.endswith((".zip", ".tar.bz2"))
    if archive_model and dest.is_dir():
        return
    if not archive_model and dest.is_file() and digest(dest) == checksum:
        return
    print("Downloading", name, flush=True)
    with tempfile.TemporaryDirectory(dir=root) as work:
        archive = Path(work) / "download"
        with (
            urllib.request.urlopen(url, timeout=90) as response,
            archive.open("wb") as out,
        ):
            shutil.copyfileobj(response, out)
        if digest(archive) != checksum:
            raise RuntimeError("Checksum mismatch for " + name)
        if url.endswith(".zip"):
            with zipfile.ZipFile(archive) as source:
                source.extractall(work)
        elif url.endswith(".tar.bz2"):
            with tarfile.open(archive) as source:
                source.extractall(work, filter="data")
        else:
            archive.replace(dest)
            return
        (Path(work) / name).replace(dest)


if __name__ == "__main__":
    root = Path(sys.argv[1])
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".download.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for asset in assets:
            install(root, *asset)
    print("Local speech models are ready.")
