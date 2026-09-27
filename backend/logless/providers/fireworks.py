"""Fireworks embeddings (qwen3-embedding-8b). Only generalized facet sentences are embedded —
never raw conversations."""
from __future__ import annotations

import numpy as np

from ..config import EMBEDDING_DIMS, EMBEDDING_MODEL, FIREWORKS_URL, settings
from .http import ProviderError, post_json


def embed(texts: list[str], *, dims: int = EMBEDDING_DIMS, batch: int = 128) -> np.ndarray:
    """Return an (n, dims) float32 array of L2-normalized embeddings."""
    out = np.zeros((len(texts), dims), dtype=np.float32)
    for start in range(0, len(texts), batch):
        chunk = [t if t.strip() else "(empty)" for t in texts[start:start + batch]]
        body = {"model": EMBEDDING_MODEL, "input": chunk, "dimensions": dims}
        resp = post_json("fireworks", f"{FIREWORKS_URL}/embeddings", settings().fireworks_api_key, body)
        data = sorted(resp.get("data", []), key=lambda d: d.get("index", 0))
        if len(data) != len(chunk):
            raise ProviderError("fireworks", None, "count_mismatch")
        out[start:start + len(chunk)] = np.asarray([d["embedding"] for d in data], dtype=np.float32)
    norms = np.linalg.norm(out, axis=1, keepdims=True)
    return out / np.maximum(norms, 1e-12)
