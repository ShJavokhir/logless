"""Fireworks embeddings (qwen3-embedding-8b). Only generalized facet sentences are embedded —
never raw conversations."""
from __future__ import annotations

import numpy as np

from ..config import EMBEDDING_DIMS, EMBEDDING_MODEL, FIREWORKS_URL, settings
from .http import ProviderError, post_json


def embed(texts: list[str], *, dims: int = EMBEDDING_DIMS, batch: int = 128) -> np.ndarray:
    """Return an (n, dims) float32 array of L2-normalized embeddings."""
    if dims < 1 or batch < 1:
        raise ValueError("embedding dimensions and batch size must be positive")
    out = np.zeros((len(texts), dims), dtype=np.float32)
    for start in range(0, len(texts), batch):
        chunk = [t if t.strip() else "(empty)" for t in texts[start:start + batch]]
        body = {"model": EMBEDDING_MODEL, "input": chunk, "dimensions": dims}
        resp = post_json("fireworks", f"{FIREWORKS_URL}/embeddings", settings().fireworks_api_key, body)
        data = resp.get("data")
        if not isinstance(data, list) or len(data) != len(chunk):
            raise ProviderError("fireworks", None, "count_mismatch")
        if (any(not isinstance(d, dict) or type(d.get("index")) is not int for d in data)
                or {d["index"] for d in data} != set(range(len(chunk)))):
            raise ProviderError("fireworks", None, "index_mismatch")
        data = sorted(data, key=lambda d: d["index"])
        try:
            vectors = np.asarray([d["embedding"] for d in data], dtype=np.float32)
        except (KeyError, TypeError, ValueError) as e:
            raise ProviderError("fireworks", None, "malformed_embeddings") from e
        if (vectors.shape != (len(chunk), dims) or not np.isfinite(vectors).all()
                or np.any(np.linalg.norm(vectors.astype(np.float64), axis=1) == 0)):
            raise ProviderError("fireworks", None, "malformed_embeddings")
        out[start:start + len(chunk)] = vectors
    # Squaring large but finite float32 components can overflow a float32 norm.
    precise = out.astype(np.float64)
    norms = np.linalg.norm(precise, axis=1, keepdims=True)
    return (precise / np.maximum(norms, 1e-300)).astype(np.float32)
