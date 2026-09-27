"""Deterministic privacy checks shared by the gate (stage 8), publish (stage 9) and the eval report.

Functions return check names and match counts, never the matched text, so callers can log results
without echoing private strings."""
from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from typing import Iterable

N_GRAM = 6
MAX_DOCS = 3


def normalize(s: str) -> str:
    """NFKC + casefold + collapsed whitespace (also folds full-width / compatibility forms)."""
    s = unicodedata.normalize("NFKC", s).casefold()
    return re.sub(r"\s+", " ", s)


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s)


# ---------------------------------------------------------------- (a) canary / injection tokens

class TokenScanner:
    """Case-insensitive, Unicode-normalized scanner for fixture tokens.

    Word-like tokens match on word boundaries of the normalized text; digit-only tokens (phones) also
    match against the text with all non-digits removed."""

    def __init__(self, tokens: Iterable[str]):
        self.word: list[re.Pattern] = []
        self.digits: list[str] = []
        seen = set()
        for t in tokens:
            n = normalize(t).strip()
            if not n or n in seen:
                continue
            seen.add(n)
            if re.fullmatch(r"[\d\s()+\-.]+", n):
                d = _digits(n)
                if len(d) >= 7:
                    self.digits.append(d)
                continue
            self.word.append(re.compile(r"(?<!\w)" + re.escape(n) + r"(?!\w)"))

    def __len__(self) -> int:
        return len(self.word) + len(self.digits)

    def hits(self, text: str) -> int:
        n = normalize(text)
        c = sum(1 for p in self.word if p.search(n))
        if self.digits:
            d = _digits(n)
            c += sum(1 for t in self.digits if t in d)
        return c


# ---------------------------------------------------------------- (b) contact / secret patterns, (c) source ids

CONTACT_PATTERNS: dict[str, re.Pattern] = {
    "email": re.compile(r"[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+", re.U),
    "phone": re.compile(r"(?<!\w)(?:\+?\d[\d\s().\-]{6,}\d)(?!\w)"),
    "url": re.compile(r"(?:https?://|www\.)\S+|\b(?<!asp\.)(?!asp\.net\b)[\w\-]+\.(?:com|net|org|io|ru|cn|co|uk|de|fr|info|biz|me|app|dev|xyz)\b(?:/\S*)?", re.I),
    "handle": re.compile(r"(?<![\w@])@[A-Za-z0-9_]{2,}"),
    "user_path": re.compile(r"(?:/Users/|/home/|C:\\\\Users\\\\|C:\\Users\\)[^\s/\\]+", re.I),
    "ip_address": re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
    "secret": re.compile(r"\b(?:sk|pk|rk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}\b|\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+/]{40,}={0,2}"),
    "card_or_account": re.compile(r"\b(?:\d[ \-]?){13,19}\b"),
}

SOURCE_ID_PATTERNS: dict[str, re.Pattern] = {
    "conversation_id": re.compile(r"\bc_[0-9a-f]{12}\b"),
    "user_pseudonym": re.compile(r"\bu_[0-9a-f]{10}\b"),
    "build_id": re.compile(r"\bb_\d{8}T\d{6}\b"),
    "hashed_ip": re.compile(r"\b[0-9a-f]{64}\b"),
    "turn_identifier": re.compile(r"(?<![\w.])\d{6,9}(?![\w.])"),
    "theme_id": re.compile(r"\bt\d_\d{2}\b"),
}


def pattern_hits(text: str, patterns: dict[str, re.Pattern]) -> list[str]:
    return [name for name, p in patterns.items() if p.search(text)]


def contact_hits(text: str) -> list[str]:
    return pattern_hits(text, CONTACT_PATTERNS)


def source_id_hits(text: str) -> list[str]:
    return pattern_hits(text, SOURCE_ID_PATTERNS)


# ---------------------------------------------------------------- (d) distinctive-phrase overlap

def word_tokens(s: str) -> list[str]:
    return re.findall(r"\w+", normalize(s))


def ngrams(tokens: list[str], n: int = N_GRAM) -> set[tuple[str, ...]]:
    return {tuple(tokens[i:i + n]) for i in range(len(tokens) - n + 1)}


def distinctive_ngrams(texts: dict[str, str], corpus: Iterable[str], n: int = N_GRAM,
                       max_docs: int = MAX_DOCS) -> dict[str, int]:
    """For each published text key, the number of its n-grams that occur verbatim in 1..max_docs
    source conversations (a distinctive phrase copied from a few sources). 0 means clean."""
    want: dict[tuple[str, ...], list[str]] = defaultdict(list)
    for k, t in texts.items():
        for g in ngrams(word_tokens(t), n):
            want[g].append(k)
    if not want:
        return {k: 0 for k in texts}
    docs: dict[tuple[str, ...], int] = defaultdict(int)
    for doc in corpus:
        toks = word_tokens(doc)
        for g in ngrams(toks, n) & want.keys():
            docs[g] += 1
    out = {k: 0 for k in texts}
    for g, keys in want.items():
        if 1 <= docs.get(g, 0) <= max_docs:
            for k in keys:
                out[k] += 1
    return out


# ---------------------------------------------------------------- whole-payload scan (publish, eval)

def scan_payload(payload: str, scanner: TokenScanner | None = None) -> dict[str, int]:
    """Counts per check over one serialized public payload. Keys: canary_or_injection, contact:<name>,
    source_id:<name>. Contact patterns that legitimately appear in public metadata (the dataset URL,
    ISO timestamps) are excluded by scanning only string values the caller passes."""
    out: dict[str, int] = {}
    if scanner is not None:
        out["fixture_tokens"] = scanner.hits(payload)
    for name, p in CONTACT_PATTERNS.items():
        out[f"contact:{name}"] = len(p.findall(payload))
    for name, p in SOURCE_ID_PATTERNS.items():
        out[f"source_id:{name}"] = len(p.findall(payload))
    return out


def iter_strings(obj, path: str = "") -> Iterable[tuple[str, str]]:
    """Yield (path, string) for every string value in a JSON-like object."""
    if isinstance(obj, str):
        yield path, obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield from iter_strings(v, f"{path}.{k}" if path else str(k))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from iter_strings(v, f"{path}[{i}]")


# Public fields whose values are system metadata (ids, timestamps, dataset URL/hash, model ids) and
# are therefore exempt from contact/source-id pattern checks — but never from the fixture-token scan.
METADATA_KEYS = {"snapshot_id", "created_at", "source_url", "revision", "dataset_hash", "id", "parent_id", "children",
                 "started_at", "finished_at", "pipeline_version", "period_start", "period_end", "generated_at",
                 "cluster_id", "run_id", "job_id", "code_sha256", "image", "host", "citations", "metric_refs"}


def text_strings(obj) -> list[tuple[str, str]]:
    """Human-readable string values (excluding metadata keys) for pattern checks."""
    out = []
    for path, s in iter_strings(obj):
        last = re.sub(r"\[\d+\]$", "", path.rsplit(".", 1)[-1])
        if last in METADATA_KEYS or path.startswith("provenance.") or path.startswith("dataset.source_url"):
            continue
        out.append((path, s))
    return out
