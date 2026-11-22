"""Install pinned M2M-100 INT8 data files in the local model cache."""

import fcntl
import hashlib
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPException
from pathlib import Path
from urllib.request import Request, urlopen

MODEL = json.loads(Path(__file__).with_name("model.json").read_text())
CHUNK = 4 * 1024 * 1024


def verified(path, entry):
    if not path.is_file() or path.stat().st_size != entry["size"]:
        return False
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == entry["sha256"]


def fetch(url, output, size):
    def piece(start):
        stop = min(size, start + CHUNK)
        length = stop - start
        for attempt in range(3):
            try:
                headers = {"Range": f"bytes={start}-{stop - 1}"} if size > CHUNK else {}
                request = Request(
                    f"{url}?part={start}&attempt={attempt}", headers=headers
                )
                with urlopen(request, timeout=25) as reply:
                    if (
                        headers
                        and reply.getheader("Content-Range")
                        != f"bytes {start}-{stop - 1}/{size}"
                    ):
                        raise OSError("Unexpected model download range")
                    data = reply.read(length + 1)
                if len(data) != length:
                    raise OSError("Incomplete model download")
                with output.open("r+b") as stream:
                    stream.seek(start)
                    stream.write(data)
                return
            except (OSError, HTTPException):
                if attempt == 2:
                    raise
                time.sleep(0.5 * (attempt + 1))

    output.write_bytes(b"")
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(piece, range(0, size, CHUNK)))


def ensure_model(root, downloading):
    destination = root / "m2m100-int8" / MODEL["revision"]
    destination.mkdir(parents=True, exist_ok=True)
    with (destination / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for filename, entry in MODEL["files"].items():
            path = destination / filename
            if verified(path, entry):
                continue
            downloading(filename)
            url = f"https://huggingface.co/{MODEL['repository']}/resolve/{MODEL['revision']}/{filename}"
            temp = path.with_suffix(path.suffix + ".part")
            try:
                fetch(url, temp, entry["size"])
                if not verified(temp, entry):
                    raise OSError("Model checksum mismatch for " + filename)
                os.replace(temp, path)
            finally:
                temp.unlink(missing_ok=True)
    return destination


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    ensure_model(
        parser.parse_args().directory,
        lambda name: print("Downloading", name, flush=True),
    )
    print("Local translation model is ready.")
