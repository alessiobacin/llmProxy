#!/usr/bin/env python3
"""
Persistent LLMLingua-2 compression process.
Reads JSON lines from stdin, outputs JSON lines to stdout.

Protocol:
  → {"id": "x", "text": "...", "rate": 0.3}
  ← {"id": "x", "compressed": "...", "original_tokens": N, "compressed_tokens": N, "rate": 0.3}

  → {"command": "ping"}
  ← {"pong": true, "model_loaded": true}

  → {"command": "stats"}
  ← {"requests": N, "total_original_tokens": N, "total_compressed_tokens": N}
"""
from __future__ import annotations

import json
import sys
import time
import os

# Suppress non-JSON output from transformers/etc
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["TRANSFORMERS_VERBOSITY"] = "error"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"

MODEL_NAME = "microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank"

_compressor = None
_stats = {"requests": 0, "total_original_tokens": 0, "total_compressed_tokens": 0}


def get_compressor():
    global _compressor
    if _compressor is None:
        from llmlingua import PromptCompressor

        _compressor = PromptCompressor(
            model_name=MODEL_NAME,
            use_llmlingua2=True,
            device_map="cpu",
        )
    return _compressor


def compress(text: str, rate: float = 0.3) -> dict:
    compressor = get_compressor()
    result = compressor.compress_prompt([text], rate=rate)
    compressed_list = result.get("compressed_prompt", [text])
    compressed_text = compressed_list[0] if isinstance(compressed_list, list) else compressed_list
    raw_orig = result.get("origin_tokens", 0)
    raw_comp = result.get("compressed_tokens", 0)
    info = {
        "original_tokens": raw_orig if isinstance(raw_orig, int) else (raw_orig[0] if isinstance(raw_orig, list) else 0),
        "compressed_tokens": raw_comp if isinstance(raw_comp, int) else (raw_comp[0] if isinstance(raw_comp, list) else 0),
        "rate": rate,
    }
    _stats["requests"] += 1
    _stats["total_original_tokens"] += info["original_tokens"]
    _stats["total_compressed_tokens"] += info["compressed_tokens"]
    return compressed_text, info


def main():
    # Pre-warm: load model on startup
    try:
        get_compressor()
        model_loaded = True
    except Exception as e:
        model_loaded = False
        # Will retry on first compression request

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            response = {"error": f"invalid JSON: {e}"}
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()
            continue

        # Handle commands
        if request.get("command") == "ping":
            sys.stdout.write(json.dumps({"pong": True, "model_loaded": model_loaded}) + "\n")
            sys.stdout.flush()
            continue

        if request.get("command") == "stats":
            sys.stdout.write(json.dumps(_stats) + "\n")
            sys.stdout.flush()
            continue

        # Handle compression
        req_id = request.get("id", "unknown")
        text = request.get("text", "")
        rate = float(request.get("rate", 0.3))

        if not text:
            sys.stdout.write(json.dumps({"id": req_id, "error": "empty text"}) + "\n")
            sys.stdout.flush()
            continue

        try:
            compressed, info = compress(text, rate)
            response = {"id": req_id, "compressed": compressed, **info}
        except Exception as e:
            response = {"id": req_id, "error": str(e)}

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
