import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

source = Path(__file__).resolve().parents[1] / "modules" / "local-translation"
spec = importlib.util.spec_from_file_location("model_store", source / "model_store.py")
store = importlib.util.module_from_spec(spec)
spec.loader.exec_module(store)


class ModelCacheTest(unittest.TestCase):
    def test_rejects_bad_bytes_then_reuses_verified_offline_model(self):
        payload = b"verified model fixture"
        model = {
            "repository": "example/translation",
            "revision": "fixture",
            "files": {
                "model.bin": {
                    "size": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                }
            },
        }
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(store, "MODEL", model),
        ):
            root = Path(directory)
            destination = root / "m2m100-int8" / model["revision"]
            announce = Mock()

            def invalid(_url, path, _size):
                path.write_bytes(b"x" * len(payload))

            with (
                patch.object(store, "fetch", invalid),
                self.assertRaisesRegex(OSError, "checksum"),
            ):
                store.ensure_model(root, announce)
            self.assertFalse((destination / "model.bin").exists())
            self.assertFalse(list(destination.glob("*.part")))

            def download(_url, path, _size):
                path.write_bytes(payload)

            with patch.object(store, "fetch", download):
                self.assertEqual(store.ensure_model(root, announce), destination)
            with patch.object(
                store, "fetch", side_effect=AssertionError("Unexpected network access")
            ):
                store.ensure_model(root, announce)
            self.assertEqual((destination / "model.bin").read_bytes(), payload)
            self.assertEqual(announce.call_count, 2)
