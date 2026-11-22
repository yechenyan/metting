"""Serve M2M-100 text translations over a persistent JSON-lines pipe."""

import json
import sys
from http.client import HTTPException
from pathlib import Path

from model_store import ensure_model


def emit(**event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


def main():
    import ctranslate2
    import sentencepiece
    from opencc import OpenCC

    announced = False

    def downloading(_filename):
        nonlocal announced
        if not announced:
            emit(kind="downloading")
            announced = True

    folder = ensure_model(Path(sys.argv[1]), downloading)
    tokens = sentencepiece.SentencePieceProcessor(
        model_file=str(folder / "sentencepiece.bpe.model")
    )
    runtime = ctranslate2.Translator(
        str(folder), device="cpu", compute_type="int8", inter_threads=1, intra_threads=2
    )
    simplified = OpenCC("t2s")
    emit(kind="ready")
    for line in sys.stdin:
        request = json.loads(line)
        try:
            source = [
                f"__{request['source']}__",
                *tokens.encode(request["text"], out_type=str),
                "</s>",
            ]
            target = f"__{request['target']}__"
            result = runtime.translate_batch(
                [source],
                target_prefix=[[target]],
                beam_size=2,
                max_decoding_length=min(384, 3 * len(source) + 24),
            )[0].hypotheses[0]
            if result and result[0] == target:
                result = result[1:]
            text = tokens.decode_pieces(result).strip()
            if request["target"] == "zh":
                text = simplified.convert(text)
            emit(kind="result", id=request["id"], text=text)
        except (IndexError, KeyError, RuntimeError, TypeError, ValueError) as exc:
            emit(kind="error", id=request["id"], detail=str(exc))


if __name__ == "__main__":
    try:
        main()
    except (HTTPException, ImportError, OSError, RuntimeError, ValueError) as exc:
        emit(kind="failed", detail=str(exc))
        sys.exit(1)
