"""Stage 2 — discover themes: embed facet text (Fireworks), fit k-means on a per-person-capped,
near-duplicate-collapsed subset, name each cluster (GLM-5.3), consolidate into leaf themes.

Real WildChat has people who send hundreds of near-identical templated prompts; capping each
person's influence (<= 3 conversations, near-duplicates collapsed at cosine > 0.97) keeps one
template from claiming a dozen k-means centroids. Classification later counts every conversation."""
from __future__ import annotations

import hashlib
import json
import logging
import random
from collections import Counter, defaultdict

import numpy as np
from sklearn.cluster import KMeans
from sklearn.metrics import adjusted_rand_score, silhouette_score

from .. import db
from ..config import EMBEDDING_DIMS, EMBEDDING_MODEL, GLM, settings
from ..ids import utcnow
from ..providers import fireworks
from . import util
from .prompts import CONSOLIDATE_SYS, NAMING_SYS, ClusterName, Consolidation

log = logging.getLogger("logless.pipeline.discover")

PER_PERSON_CAP = 3
DUP_COSINE = 0.97
FULL_K = 40
SEEDS = (20260926, 7)

EMB_SCHEMA = "CREATE TABLE IF NOT EXISTS embedding_cache (key TEXT PRIMARY KEY, model TEXT, vec BLOB NOT NULL)"


# ---------------------------------------------------------------- embeddings

def _key(text: str) -> str:
    return hashlib.sha256((EMBEDDING_MODEL + "\n" + text).encode()).hexdigest()


def embed_texts(texts: list[str]) -> np.ndarray:
    """Embeddings with a private cache keyed by (model, text)."""
    if not texts:
        return np.empty((0, EMBEDDING_DIMS), dtype=np.float32)
    from .facets import safe_embedding_text
    texts = [safe_embedding_text(text) for text in texts]
    con = db.private()
    con.execute(EMB_SCHEMA)
    keys = [_key(t) for t in texts]
    have: dict[str, np.ndarray] = {}
    for chunk in ([] if util.no_cache() else util.chunks(sorted(set(keys)), 900)):
        for row in con.execute(f"SELECT key, vec FROM embedding_cache WHERE key IN ({','.join('?' * len(chunk))})", chunk):
            have[row["key"]] = np.frombuffer(row["vec"], dtype=np.float32)
    missing = sorted({k: t for k, t in zip(keys, texts) if k not in have}.items())
    if missing:
        log.info("embedding %d new texts (%d cached)", len(missing), len(have))
        vecs = fireworks.embed([t for _, t in missing])
        util.USAGE.add("fireworks", EMBEDDING_MODEL, prompt=sum(len(t) for _, t in missing) / 4, estimated=True)
        with db.write(con):
            con.executemany("INSERT OR REPLACE INTO embedding_cache(key, model, vec) VALUES (?,?,?)",
                            [(k, EMBEDDING_MODEL, v.astype(np.float32).tobytes()) for (k, _), v in zip(missing, vecs)])
        for (k, _), v in zip(missing, vecs):
            have[k] = v.astype(np.float32)
    X = np.stack([have[k] for k in keys]).astype(np.float32)
    return X / np.maximum(np.linalg.norm(X, axis=1, keepdims=True), 1e-12)


def load_facets(conv_ids: list[str]) -> dict[str, dict]:
    rows = util.load_rows(conv_ids, "SELECT f.conv_id, f.facet_text, f.user_goal, f.task, f.domain, c.user_id "
                                    "FROM facets f JOIN conversations c USING(conv_id) WHERE f.conv_id IN ({})")
    return {k: dict(v) for k, v in rows.items()}


def build_embeddings(build: util.Build) -> tuple[list[str], np.ndarray]:
    """Embed every conversation in scope; saved as embeddings/<build_id>.npy + ids json."""
    from .facets import ensure_schema
    ensure_schema()  # sanitize legacy fallback rows even when resuming at discovery
    f = load_facets(build.conv_ids)
    ids = [c for c in build.conv_ids if c in f]
    X = embed_texts([f[c]["facet_text"] for c in ids])
    d = settings().data_dir / "embeddings"
    d.mkdir(parents=True, exist_ok=True)
    np.save(d / f"{build.build_id}.npy", X)
    (d / f"{build.build_id}.ids.json").write_text(json.dumps(ids))
    return ids, X


def load_embeddings(build: util.Build) -> tuple[list[str], np.ndarray]:
    d = settings().data_dir / "embeddings"
    p = d / f"{build.build_id}.npy"
    if not p.exists():
        return build_embeddings(build)
    return json.loads((d / f"{build.build_id}.ids.json").read_text()), np.load(p)


# ---------------------------------------------------------------- capping

def capped_subset(users: list[str], X: np.ndarray, *, cap: int = PER_PERSON_CAP, dup: float = DUP_COSINE,
                  seed: int = SEEDS[0]) -> list[int]:
    """Greedy, seeded: keep a conversation if its person has < cap kept and it is not a near-duplicate
    (cosine > dup) of anything already kept. Returns kept indices (sorted)."""
    n = len(users)
    order = list(range(n))
    random.Random(seed).shuffle(order)
    per: Counter = Counter()
    covered = np.zeros(n, dtype=bool)
    kept: list[int] = []
    for i in order:
        if covered[i] or per[users[i]] >= cap:
            continue
        kept.append(i)
        per[users[i]] += 1
        covered |= (X @ X[i]) > dup
    return sorted(kept)


# ---------------------------------------------------------------- k-means

def fit_kmeans(Xs: np.ndarray, k: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    km = KMeans(n_clusters=k, n_init=4, random_state=seed, max_iter=300)
    labels = km.fit_predict(Xs)
    C = km.cluster_centers_.astype(np.float32)
    C /= np.maximum(np.linalg.norm(C, axis=1, keepdims=True), 1e-12)
    return labels, C


def choose_k(n_subset: int, full: bool) -> int:
    if full:
        return FULL_K
    return int(min(FULL_K, max(8, round(n_subset / 12))))


def diagnostics(Xs: np.ndarray, base_k: int) -> dict:
    out = {}
    for k in sorted({max(4, round(base_k * 0.75)), base_k, round(base_k * 1.25)}):
        if k >= len(Xs):
            continue
        a, _ = fit_kmeans(Xs, k, SEEDS[0])
        b, _ = fit_kmeans(Xs, k, SEEDS[1])
        if 1 < len(set(a)) < len(Xs):
            out[str(k)] = {"ari_two_seeds": round(float(adjusted_rand_score(a, b)), 4),
                           "silhouette": round(float(silhouette_score(Xs, a, metric="cosine")), 4)}
    return out


# ---------------------------------------------------------------- naming

def _sample_people(members: list[int], users: list[str], n: int, seed: int) -> list[int]:
    """Up to n members from distinct people (seeded)."""
    rng = random.Random(seed)
    by: dict[str, list[int]] = defaultdict(list)
    for i in members:
        by[users[i]].append(i)
    people = sorted(by)
    rng.shuffle(people)
    return [rng.choice(by[p]) for p in people[:n]]


def name_clusters(ids: list[str], X: np.ndarray, users: list[str], facets: dict[str, dict], sub: list[int],
                  labels: np.ndarray, C: np.ndarray, prefix: str, seed: int) -> list[dict]:
    """Name each k-means cluster from ~20 in-cluster facets (distinct people) + 10 neighbour facets."""
    k = len(C)
    members: dict[int, list[int]] = defaultdict(list)
    for pos, lab in zip(sub, labels):
        members[int(lab)].append(pos)
    # all-scope nearest-centroid assignment, for people shares
    full_lab = np.argmax(X @ C.T, axis=1)
    people_total = len(set(users))
    sims = C @ C.T
    np.fill_diagonal(sims, -1)
    jobs = []
    for c in range(k):
        nb = int(np.argmax(sims[c])) if k > 1 else None
        inside = _sample_people(members[c], users, 20, seed + c)
        outside = _sample_people(members[nb], users, 10, seed + 1000 + c) if nb is not None else []
        ppl = len({users[i] for i in np.where(full_lab == c)[0]})
        jobs.append({"id": f"{prefix}{c:02d}", "c": c, "nb": nb, "inside": inside, "outside": outside,
                     "people_share": ppl / max(1, people_total), "conv_share": float(np.mean(full_lab == c)),
                     "subset_size": len(members[c])})

    def one(j: dict) -> dict:
        lines = ["Facets from the cluster:"] + [f"- {facets[ids[i]]['facet_text']}" for i in j["inside"]]
        lines += ["", "Facets from the nearest neighbouring cluster (for contrast only):"]
        lines += [f"- {facets[ids[i]]['facet_text']}" for i in j["outside"]]
        out = util.glm_json(NAMING_SYS, "\n".join(lines), ClusterName, model=GLM, reasoning="low", temperature=0.2,
                            max_tokens=4000)
        return {**{k2: v for k2, v in j.items() if k2 not in ("inside", "outside")},
                "name": util.clip_words(out.name, 10), "description": out.description,
                "includes": out.includes, "excludes": out.excludes,
                "neighbour": f"{prefix}{j['nb']:02d}" if j["nb"] is not None else None}

    named, errs = util.pmap(one, jobs, settings().glm_concurrency, "naming")
    result = []
    for j, r in zip(jobs, named):
        if r is None:  # naming failed twice: keep a placeholder so consolidation still sees the cluster
            r = {**{k2: v for k2, v in j.items() if k2 not in ("inside", "outside")}, "name": f"Unnamed cluster {j['id']}",
                 "description": "", "includes": "", "excludes": "", "neighbour":
                     f"{prefix}{j['nb']:02d}" if j["nb"] is not None else None}
        result.append(r)
    return result


def consolidate(named: list[dict]) -> list[dict]:
    lines = []
    for c in named:
        lines.append(json.dumps({"id": c["id"], "name": c["name"], "description": c["description"],
                                 "includes": c["includes"], "excludes": c["excludes"],
                                 "share_of_people": f"{100 * c['people_share']:.1f}%"}, ensure_ascii=False))
    out = util.glm_json(CONSOLIDATE_SYS, "Candidate clusters (one JSON per line):\n" + "\n".join(lines), Consolidation,
                        model=GLM, reasoning="low", temperature=0.2, max_tokens=12000)
    # a dropped grab-bag cluster may not take more than a fifth of the capped subset with it
    total = sum(c["subset_size"] for c in named) or 1
    dropped, budget = [], 0
    for cid in out.dropped:
        c = next((x for x in named if x["id"] == cid), None)
        if c and budget + c["subset_size"] <= 0.2 * total:
            dropped.append(cid)
            budget += c["subset_size"]
    return fix_coverage(named, [t.model_dump() for t in out.themes], dropped)


def fix_coverage(named: list[dict], themes: list[dict], dropped: list[str] | None = None) -> list[dict]:
    """Every input cluster in exactly one theme (or explicitly dropped); unique names; no empty themes."""
    valid = {c["id"] for c in named}
    seen: set[str] = set(dropped or [])
    names: set[str] = {"other or unclear"}
    out = []
    for t in themes:
        cl = [c for c in dict.fromkeys(t.get("clusters", [])) if c in valid and c not in seen]
        if not cl:
            continue
        seen.update(cl)
        name = util.clip_words(t["name"].strip(), 10)
        base, n = name, 2
        while name.lower() in names:
            name = f"{base} ({n})"
            n += 1
        names.add(name.lower())
        out.append({**t, "name": name, "clusters": cl})
    for c in named:
        if c["id"] not in seen:
            name = c["name"]
            if name.lower() in names:
                name = f"{name} ({c['id']})"
            names.add(name.lower())
            out.append({"name": name, "description": c["description"], "includes": c["includes"],
                        "excludes": c["excludes"], "clusters": [c["id"]]})
    return out


def save_themes(build: util.Build, themes: list[dict], rnd: int) -> list[dict]:
    con = db.private()
    rows = []
    for i, t in enumerate(themes):
        tid = t.get("theme_id") or f"t{rnd}_{i:02d}"
        t["theme_id"] = tid
        rows.append((build.build_id, tid, rnd, t["name"], t.get("description"), t.get("includes"), t.get("excludes"),
                     None, "active"))
    with db.write(con):
        con.executemany("INSERT OR REPLACE INTO themes(build_id, theme_id, round, name, description, includes, excludes,"
                        " category_id, status) VALUES (?,?,?,?,?,?,?,?,?)", rows)
    return themes


def active_themes(build_id: str) -> list[dict]:
    rows = db.private().execute("SELECT * FROM themes WHERE build_id = ? AND status = 'active' ORDER BY theme_id",
                                (build_id,)).fetchall()
    return [dict(r) for r in rows]


def discover_round(build: util.Build, conv_ids: list[str], rnd: int, k: int | None = None,
                   with_diagnostics: bool = False) -> dict:
    """Cap, cluster and name one set of conversations. Returns the round record (private artifact)."""
    all_ids, X_all = load_embeddings(build)
    pos = {c: i for i, c in enumerate(all_ids)}
    ids = [c for c in conv_ids if c in pos]
    X = X_all[[pos[c] for c in ids]]
    facets = load_facets(ids)
    users = [facets[c]["user_id"] for c in ids]
    sub = capped_subset(users, X, seed=SEEDS[0] + rnd)
    if not sub:
        raise RuntimeError("discovery requires at least one conversation with extracted facets")
    Xs = X[sub]
    if k is None:
        k = choose_k(len(sub), full=build.limit is None)
    k = max(1, min(k, max(1, len(sub) // 3)))
    diag = diagnostics(Xs, k) if with_diagnostics else {}
    labels, C = fit_kmeans(Xs, k, SEEDS[0])
    named = name_clusters(ids, X, users, facets, sub, labels, C, prefix=f"k{rnd}_", seed=SEEDS[0] + rnd)
    rec = {"round": rnd, "conversations": len(ids), "people": len(set(users)), "subset": len(sub),
           "subset_people": len({users[i] for i in sub}), "k": k, "diagnostics": diag, "clusters": named,
           "created_at": utcnow()}
    return rec


def run(build: util.Build) -> dict:
    ids, X = build_embeddings(build)
    rec = discover_round(build, ids, 1, with_diagnostics=True)
    themes = consolidate(rec["clusters"])
    themes = save_themes(build, themes, 1)
    rec["themes"] = themes
    build.save("discover_r1", rec)
    # diagnostics (ARI, silhouette) stay in the private build record and the eval report; public stage
    # counts are non-negative integer counts only
    build.info.setdefault("diagnostics", {})["discover_r1"] = rec["diagnostics"]
    return {"conversations": rec["conversations"], "embedded": len(ids), "capped_subset": rec["subset"],
            "k": rec["k"], "themes": len(themes), "rounds": 1}
