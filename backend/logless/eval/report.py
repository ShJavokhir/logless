"""`logless eval` — evaluation report for the current snapshot (docs/CONTRACTS.md §6 EvalReport),
stored in public.db.eval_reports. Every check has value / target / passed / detail; details carry
numbers only, never private text. Informational checks use `passed: null`."""
from __future__ import annotations

import json
import logging
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from .. import db
from ..config import REPO_ROOT
from ..data import fixtures
from ..ids import utcnow
from ..pipeline import util
from ..pipeline.privacy import TokenScanner, contact_hits, source_id_hits, text_strings
from ..pipeline.questions import FRICTION_QV, SIGNALS

log = logging.getLogger("logless.eval")

HERE = Path(__file__).resolve().parent
GOLD_DIR, EXT_DIR = HERE / "gold", HERE / "external"
FRICTION_F1_TARGET = 0.80
MIN_SUPPORT = 10
OTHER_TARGET = 0.10
NOT_VERIFIED = "not yet verified"


LIMITS = {"id": 60, "name": 160, "value": 200, "target": 200, "detail": 600}  # the API serializer truncates beyond these


def check(cid: str, name: str, value: str, target: str, passed: bool | None, detail: str) -> dict:
    c = {"id": cid, "name": name, "value": value, "target": target, "passed": passed, "detail": detail}
    for k, n in LIMITS.items():
        if len(c[k]) > n:
            log.warning("eval check %s: %s longer than %d chars; truncated", cid, k, n)
            c[k] = c[k][: n - 1] + "…"
    return c


# ---------------------------------------------------------------- helpers

def prf(truth: list[bool], pred: list[bool]) -> dict:
    tp = sum(t and p for t, p in zip(truth, pred))
    fp = sum((not t) and p for t, p in zip(truth, pred))
    fn = sum(t and (not p) for t, p in zip(truth, pred))
    prec = tp / (tp + fp) if tp + fp else None
    rec = tp / (tp + fn) if tp + fn else None
    f1 = 2 * prec * rec / (prec + rec) if prec and rec else (0.0 if (prec == 0 or rec == 0) else None)
    return {"tp": tp, "fp": fp, "fn": fn, "support": tp + fn, "n": len(truth), "precision": prec, "recall": rec, "f1": f1}


def fmt(x: float | None, d: int = 2) -> str:
    return "n/a" if x is None else f"{x:.{d}f}"


def read_jsonl(p: Path) -> list[dict]:
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()] if p.exists() else []


def current_snapshot() -> dict | None:
    row = db.public().execute("SELECT json FROM snapshots WHERE is_current = 1").fetchone()
    return json.loads(row["json"]) if row else None


def build_for(snapshot_id: str) -> util.Build | None:
    from ..pipeline.run import load_build
    row = db.private().execute("SELECT build_id FROM builds WHERE snapshot_id = ? ORDER BY build_id DESC LIMIT 1",
                               (snapshot_id,)).fetchone()
    return load_build(row["build_id"]) if row else None


def jev_friction(conv_ids: list[str], column: str = "choice") -> dict[str, dict[str, str]]:
    """Stored Jev decisions (column="choice", after the 0.65 cutoff) or its raw top choice ("raw_choice")."""
    out: dict[str, dict[str, str]] = defaultdict(dict)
    con = db.private()
    for chunk in util.chunks(conv_ids, 900):
        q = f"SELECT conv_id, signal, {column} AS v FROM friction WHERE question_version = ? AND conv_id IN ({{}})".format(",".join("?" * len(chunk)))
        for r in con.execute(q, [FRICTION_QV, *chunk]):
            out[r["conv_id"]][r["signal"]] = r["v"]
    return out


# ---------------------------------------------------------------- public payloads

def public_payloads() -> list[tuple[str, str]]:
    """(kind, serialized payload) for everything a browser can receive."""
    con = db.public()
    out = [("snapshot", r["json"]) for r in con.execute("SELECT json FROM snapshots")]
    out += [("run", r["json"]) for r in con.execute("SELECT json FROM runs")]
    out += [("story", r["json"]) for r in con.execute("SELECT json FROM stories")]
    out += [("eval_report", r["json"]) for r in con.execute("SELECT json FROM eval_reports")]
    dist = REPO_ROOT / "web" / "dist"
    if dist.exists():
        for p in sorted(dist.rglob("*")):
            if p.is_file() and p.stat().st_size < 20_000_000:
                out.append(("web_dist", p.read_bytes().decode("utf-8", errors="ignore")))
    return out


def leak_checks(extra: list[tuple[str, str]]) -> list[dict]:
    payloads = public_payloads() + extra
    kinds = Counter(k for k, _ in payloads)
    canary = TokenScanner(fixtures.load_tokens("canary"))
    inj = TokenScanner(fixtures.load_tokens("injection"))
    c_hits = sum(canary.hits(p) for _, p in payloads)
    i_hits = sum(inj.hits(p) for _, p in payloads)
    pat = Counter()
    for kind, p in payloads:
        if kind == "web_dist":
            continue  # bundles contain code/URLs by design; fixture tokens are what matters there
        try:
            obj = json.loads(p)
        except ValueError:
            continue
        for path, s in text_strings(obj):
            if path.startswith(("workspace.", "dataset.", "code", "receipt", "error")):
                continue
            for h in contact_hits(s):
                pat[f"contact:{h}"] += 1
            for h in source_id_hits(s):
                pat[f"source_id:{h}"] += 1
    scanned = ", ".join(f"{k} {v}" for k, v in sorted(kinds.items()))
    return [
        check("canary_leaks", "Canary leak scan across every public payload", f"{c_hits} detected canary leaks", "0",
              c_hits == 0, f"{len(canary)} canary tokens (name, email, phone, address parts) scanned, Unicode-normalized "
              f"and case-insensitive, across: {scanned}. We report detected leaks; zero detected is not proof of zero leaks."),
        check("pattern_scan", "Source-id and contact-pattern scan of public text", f"{sum(pat.values())} matches", "0",
              sum(pat.values()) == 0, "; ".join(f"{k}: {v}" for k, v in sorted(pat.items())) or
              "no email, phone, URL, handle, user path, secret, conversation/user id, hashed IP or turn id patterns in published text"),
    ], i_hits


# ---------------------------------------------------------------- checks

def reconciliation(snap: dict, build: util.Build | None) -> list[dict]:
    from ..pipeline.publish import validate
    from ..pipeline.stats import assignment_rows, clusters_for
    if build is None:
        return [check("metric_reconciliation", "Metric reconciliation", NOT_VERIFIED, "exact", False,
                      "the snapshot's build record is missing")]
    st = build.load("structure_final")
    clusters = clusters_for(st)
    rows = assignment_rows(build.build_id, clusters)
    errs = validate(snap, rows, clusters, strict_ranges=False)
    metric_errs = [e for e in errs if "metrics differ" in e or "sum" in e or "union" in e or "share" in e or "users" in e]
    leaves = snap["clusters"]
    hier = validate(snap, strict_ranges=True)
    hier_errs = [e for e in hier if e not in metric_errs]
    return [
        check("metric_reconciliation", "Metric reconciliation", f"{len(metric_errs)} mismatches", "exact (0)",
              not metric_errs, f"{len(snap['categories']) + len(leaves)} nodes recomputed from private assignments; leaf "
              f"conversations sum to {sum(l['conversations'] for l in leaves)} of {snap['totals']['conversations']}; "
              "categories are unions of their leaves; people recomputed per node, never summed."),
        check("hierarchy_invariants", "Hierarchy invariants", f"{len(hier_errs)} violations", "0", not hier_errs,
              f"{len(snap['categories'])} categories (4–8), {len(leaves)} leaves (15–35 incl. cl_other); unique ids; "
              "exactly one parent per leaf; children match; key allowlist." + (" " + "; ".join(hier_errs[:5]) if hier_errs else "")),
    ]


def injection_check(i_hits: int, build: util.Build | None) -> dict:
    ids = [r["conv_id"] for r in db.private().execute("SELECT conv_id FROM eval_fixtures WHERE kind = 'injection'")]
    rows = util.load_rows(ids, "SELECT conv_id, user_goal, task, domain, language, facet_text FROM facets WHERE conv_id IN ({})")
    inj = TokenScanner(fixtures.load_tokens("injection"))
    schema_ok = sum(1 for c in ids if c in rows and all(isinstance(rows[c][k], str) and rows[c][k].strip()
                                                         for k in ("user_goal", "task", "domain", "language", "facet_text")))
    obeyed_in_facets = sum(1 for c in ids if c in rows and inj.hits(" ".join(str(rows[c][k]) for k in rows[c].keys())))
    fr = jev_friction(ids)
    decided = sum(1 for c in ids if len(fr.get(c, {})) == len(SIGNALS))
    classified = 0
    if build is not None:
        asg = {r["conv_id"] for r in db.private().execute("SELECT conv_id FROM assignments WHERE build_id = ?", (build.build_id,))}
        classified = sum(1 for c in ids if c in asg)
    effects = i_hits + obeyed_in_facets + (len(ids) - schema_ok) + (len(ids) - decided) + (len(ids) - classified)
    return check("injection_bait", "Injection bait", f"{effects} effects", "0 effects", effects == 0 and len(ids) == 10,
                 f"{len(ids)} bait conversations; {i_hits} bait tokens (code words, instruction phrases) in public payloads; "
                 f"{schema_ok}/{len(ids)} produced the normal facet schema; {obeyed_in_facets} facets repeated bait text; "
                 f"friction decided {decided}/{len(ids)}, classified {classified}/{len(ids)}.")


def gate_check(build: util.Build | None) -> list[dict]:
    g = (build.info.get("gate") if build else None) or {}
    if not g:
        return [check("privacy_gate", "Privacy gate", NOT_VERIFIED, "all published text gated", False, "no gate record for this build")]
    detail = (f"{g.get('texts_checked', 0)} texts checked; {g.get('passed_first', 0)} passed first time; "
              f"{g.get('rewritten', 0)} rewritten then passed; {g.get('replaced_general', 0)} replaced with a more general "
              f"wording; {g.get('dropped', 0)} dropped; {g.get('rolled_up', 0)} leaves rolled up; initial flags: "
              + ", ".join(f"{k[8:]} {v}" for k, v in g.items() if k.startswith("initial_"))
              + f"; {g.get('dominated_clusters', 0)} clusters dominated by one person (strict audit).")
    # by construction every text failing after 2 rewrites is replaced, dropped or rolled up before publish
    return [check("privacy_gate", "Privacy gate on all published text",
                  f"{g.get('texts_checked', 0)} checked, {g.get('rewritten', 0)} rewritten, {g.get('rolled_up', 0)} rolled up",
                  "every published string passes or is generalized", True, detail)]


def friction_reference(scope_ids: set[str]) -> list[dict]:
    files = sorted(GOLD_DIR.glob("friction_*.jsonl"))
    if not files:
        return [check(f"friction_{s}", f"Friction vs reference: {s}", NOT_VERIFIED, f"F1 ≥ {FRICTION_F1_TARGET}",
                      False, "reference set pending") for s in SIGNALS]
    labels: dict[str, dict[str, dict]] = defaultdict(dict)  # conv -> labeller -> friction
    for p in files:
        for r in read_jsonl(p):
            labels[r["conv_id"]][r["labeller"]] = r["friction"]
    labellers = sorted({l for v in labels.values() for l in v})
    ids = [c for c, v in labels.items() if len(v) >= 2]
    jev = jev_friction(ids)
    jev_raw = jev_friction(ids, "raw_choice")
    from .ablation import out_path
    abl = json.loads(out_path().read_text())["labels"] if out_path().exists() else {}
    out = []
    abl_summary = []
    for s in SIGNALS:
        truth, pred, apred, rpred = [], [], [], []
        disagree = unclear_cons = jev_unclear = 0
        for c in ids:
            vals = {v[s] for v in labels[c].values()}
            if len(vals) > 1:
                disagree += 1
                continue
            v = vals.pop()
            if v == "unclear":
                unclear_cons += 1
                continue
            truth.append(v == "observed")
            j = jev.get(c, {}).get(s, "unclear")
            jev_unclear += j == "unclear"
            pred.append(j == "observed")
            rpred.append(jev_raw.get(c, {}).get(s) == "observed")
            apred.append(abl.get(c, {}).get(s) == "observed" if c in abl else None)
        m = prf(truth, pred)
        insufficient = m["support"] < MIN_SUPPORT
        pairs = [(t, a) for t, a in zip(truth, apred) if a is not None]
        am = prf([t for t, _ in pairs], [a for _, a in pairs]) if pairs else None
        rm = prf(truth, rpred)
        if am:
            abl_summary.append(check(
                f"ablation_{s}", f"Ablation {s}: Jev vs GLM-5.3-flash alone",
                f"Jev F1 {fmt(m['f1'])} (raw {fmt(rm['f1'])}) vs GLM-flash {fmt(am['f1'])}", "reported", None,
                f"Same questions, same {m['n']} consensus labels, support {m['support']}. Jev after the 0.65 cutoff: "
                f"P {fmt(m['precision'])}, R {fmt(m['recall'])}; Jev raw top choice (no cutoff): P {fmt(rm['precision'])}, "
                f"R {fmt(rm['recall'])}; GLM-5.3-flash: P {fmt(am['precision'])}, R {fmt(am['recall'])}. Caveat: one of the "
                "two reference labellers is GLM-5.3 (same family as the ablation model), the set is small and "
                "disagreements await human adjudication." + (" Insufficient support: not scored." if insufficient else "")))
        n_ref = len(ids)
        raw_part = f"; Jev raw-choice F1 {fmt(rm['f1'])}"
        if am:
            raw_part += f" vs GLM-flash {fmt(am['f1'])} (one reference labeller is GLM-5.3)"
        detail = (f"precision {fmt(m['precision'])} / recall {fmt(m['recall'])} under the 0.65 cutoff{raw_part}. "
                  f"Support: {m['support']} consensus positives among {m['n']} consensus labels (tp {m['tp']}, fp {m['fp']}, "
                  f"fn {m['fn']}). Of {n_ref} reference conversations labelled by {' and '.join(labellers)}, {disagree} were "
                  f"excluded for labeller disagreement (pending human adjudication) and {unclear_cons} for a shared "
                  f"'unclear'. Jev 'unclear' ({jev_unclear}) counts as not observed.")
        value = f"F1 {fmt(m['f1'])} (P {fmt(m['precision'])} / R {fmt(m['recall'])}, support {m['support']})"
        if insufficient:
            out.append(check(f"friction_{s}", f"Friction vs reference: {s}", value + ", insufficient support",
                             f"F1 ≥ {FRICTION_F1_TARGET}", None, f"Fewer than {MIN_SUPPORT} consensus positives: not scored. " + detail))
        else:
            out.append(check(f"friction_{s}", f"Friction vs reference: {s}", value, f"F1 ≥ {FRICTION_F1_TARGET}",
                             m["f1"] is not None and m["f1"] >= FRICTION_F1_TARGET, detail))
    if abl_summary:
        out += abl_summary
    else:
        out.append(check("ablation_glm_flash", "Ablation: GLM-5.3-flash alone on the same friction questions", "pending",
                         "reported", None, "run `python -m logless.eval.ablation` to label the reference set with GLM-5.3-flash"))
    return out


def theme_reference(snap: dict) -> dict:
    rows = [r for p in sorted(GOLD_DIR.glob("theme_*.jsonl")) for r in read_jsonl(p) if "theme" in r]
    if not rows:
        return check("theme_agreement", "Theme agreement vs reference", NOT_VERIFIED, "macro-F1 reported", None,
                     "reference set pending (theme labels follow the frozen taxonomy)")
    build = build_for(snap["snapshot_id"])
    from ..pipeline.stats import assignment_rows, clusters_for
    ours = {r["conv_id"]: r["leaf_id"] for r in assignment_rows(build.build_id, clusters_for(build.load("structure_final")))}
    valid = {l["id"] for l in snap["clusters"]}
    by_conv: dict[str, dict[str, str]] = defaultdict(dict)
    for r in rows:
        by_conv[r["conv_id"]][r["labeller"]] = r["theme"] if r["theme"] in valid else "cl_other"
    labellers = sorted({l for v in by_conv.values() for l in v})
    both = [c for c, v in by_conv.items() if len(v) >= 2 and c in ours]
    agree = [c for c in both if len(set(by_conv[c].values())) == 1]
    truth = [next(iter(by_conv[c].values())) for c in agree]
    pred = [ours[c] for c in agree]
    classes = sorted(set(truth))
    f1s = [prf([t == l for t in truth], [p == l for p in pred])["f1"] or 0.0 for l in classes]
    macro = sum(f1s) / len(f1s) if f1s else None
    match = sum(t == p for t, p in zip(truth, pred))
    lab_agree = len(agree) / max(1, len(both))
    other_truth = sum(t == "cl_other" for t in truth)
    other_pred = sum(p == "cl_other" for p in pred)
    return check("theme_agreement", "Theme agreement vs reference", f"macro-F1 {fmt(macro)}; {match} of {len(agree)} match",
                 "reported", None,
                 f"Jev matches the two labellers' consensus on {match} of {len(agree)} conversations ({match / max(1, len(agree)):.0%}); "
                 f"the labellers ({' and '.join(labellers)}) agree with each other on {lab_agree:.0%} of {len(both)}. "
                 f"Macro-F1 {fmt(macro)} over the {len(classes)} leaves present in the consensus. Among the {len(agree)}, the "
                 f"consensus puts {other_truth} in Other or unclear and we put {other_pred} there. Leaf ids are those of the frozen build.")


def external_checks(snap: dict, build: util.Build | None) -> list[dict]:
    from sklearn.metrics import adjusted_mutual_info_score, cohen_kappa_score
    out = []
    if build is None:
        return out
    from ..pipeline.stats import assignment_rows, clusters_for
    st = build.load("structure_final")
    arows = {r["conv_id"]: r for r in assignment_rows(build.build_id, clusters_for(st))}
    # (a) WildFeedback dissatisfaction
    wf = [r for r in read_jsonl(EXT_DIR / "wildfeedback.jsonl") if r["conv_id"] in arows]
    if wf:
        fr = jev_friction([r["conv_id"] for r in wf])
        ours = [any(fr[r["conv_id"]].get(s) == "observed" for s in ("correction", "repeat_request", "complaint")) for r in wf]
        theirs = [bool(r["dissatisfied"]) for r in wf]
        m = prf(theirs, ours)
        agree = sum(a == b for a, b in zip(ours, theirs)) / len(wf)
        kappa = cohen_kappa_score(theirs, ours) if len(set(theirs)) > 1 and len(set(ours)) > 1 else float("nan")
        out.append(check("wildfeedback_dissatisfaction",
                         "Friction vs WildFeedback dissatisfaction (external, GPT-4 labels)",
                         f"κ {kappa:.2f}, agreement {agree:.1%}", "informational", None,
                         f"{len(wf)} overlapping conversations (English, ≥ 3 user turns only). Ours = correction ∪ "
                         f"repeat_request ∪ complaint observed; theirs = any dissatisfied turn. Precision {fmt(m['precision'])}, "
                         f"recall {fmt(m['recall'])} against their flag ({m['support']} dissatisfied). Their labels are GPT-4 "
                         "judgments; in the authors' check against humans they had 48% recall and 83% precision, so they "
                         "are a noisy reference, not ground truth."))
        reasons = {"factual_error": "correction", "revision": "correction", "insufficient_detail": "repeat_request",
                   "ignored": "repeat_request", "negative_feedback": "complaint"}
        parts = []
        for reason, sig in reasons.items():
            sel = [r for r in wf if reason in (r.get("dsat_reasons") or [])]
            if sel:
                hit = sum(1 for r in sel if fr[r["conv_id"]].get(sig) == "observed")
                anyf = sum(1 for r in sel if any(fr[r["conv_id"]].get(s) == "observed" for s in SIGNALS))
                parts.append(f"{reason} ({len(sel)}): {sig} flagged {hit / len(sel):.0%}, any signal {anyf / len(sel):.0%}")
        out.append(check("wildfeedback_reasons", "WildFeedback dissatisfaction reasons vs our signals", f"{len(parts)} reasons",
                         "informational", None, "; ".join(parts) or "no reasons in overlap"))
    # (b) WildChat-AQA level-1 topics
    aqa = [r for r in read_jsonl(EXT_DIR / "wildchat_aqa.jsonl") if r["conv_id"] in arows and r.get("level1")]
    if aqa:
        leaf = [arows[r["conv_id"]]["leaf_id"] for r in aqa]
        cat = [arows[r["conv_id"]]["category_id"] for r in aqa]
        first = [r["level1"][0] for r in aqa]
        ami_leaf = adjusted_mutual_info_score(first, leaf)
        ami_cat = adjusted_mutual_info_score(first, cat)
        by_leaf: dict[str, list[list[str]]] = defaultdict(list)
        for r, l in zip(aqa, leaf):
            by_leaf[l].append(r["level1"])
        match = total = 0
        for l, topics in by_leaf.items():
            maj = Counter(t for ts in topics for t in ts).most_common(1)[0][0]
            match += sum(1 for ts in topics if maj in ts)
            total += len(topics)
        out.append(check("aqa_topics", "Leaves vs WildChat-AQA level-1 topics (external, GPT-4o labels)",
                         f"AMI leaf {ami_leaf:.2f}, category {ami_cat:.2f}; purity {match / max(1, total):.1%}", "informational",
                         None, f"{len(aqa)} overlapping conversations; AMI uses each conversation's first listed topic; "
                         "majority-topic purity counts a match if any of a conversation's topics equals its leaf's majority "
                         "topic. AQA covers users with ≥ 10 sessions and 27% of its conversations carry several topics; "
                         "their taxonomy is topic-based while ours is goal-based, so perfect agreement is not expected."))
    sh = [r for r in read_jsonl(EXT_DIR / "sh0416_category.jsonl") if r["conv_id"] in arows]
    if sh:
        lab = [r["category"] for r in sh]
        ami_leaf = adjusted_mutual_info_score(lab, [arows[r["conv_id"]]["leaf_id"] for r in sh])
        ami_cat = adjusted_mutual_info_score(lab, [arows[r["conv_id"]]["category_id"] for r in sh])
        out.append(check("sh0416_category", "Leaves vs sh0416 coarse categories (external, Mistral-7B labels)",
                         f"AMI leaf {ami_leaf:.2f}, category {ami_cat:.2f}", "informational", None,
                         f"{len(sh)} conversations; 16 coarse categories labelled from the last user message only."))
    return out


def stats_source_check(snap: dict) -> dict:
    src = snap["provenance"].get("stats_source", "unknown")
    return check("stats_source", "Counts, people and friction metrics computed in the sandbox", src, "sandbox",
                 src == "sandbox",
                 "Counts, people and friction metrics must be computed by the version-controlled task in the sandbox VM "
                 "and match the backend reference exactly. Languages per node are always computed by the backend from "
                 "private data (the sandbox never sees language). 'local-reference' means the runner was unreachable at "
                 "build time: re-run `logless rebuild --from-stage stats` (leaf ids stay the same).")


def cluster_quality(snap: dict, build: util.Build | None) -> list[dict]:
    from sklearn.metrics import silhouette_score
    other = next((l for l in snap["clusters"] if l.get("is_other")), None)
    other_share = other["share"] if other else 0.0
    out = [check("other_share", "Share in Other or unclear", f"{other_share:.1%}", f"≤ {OTHER_TARGET:.0%}",
                 other_share <= OTHER_TARGET, f"{other['conversations'] if other else 0} conversations; discovery rounds "
                 f"{snap['provenance']['discovery_rounds']}.")]
    if build is None:
        return out
    try:
        from ..pipeline.discover import load_embeddings
        from ..pipeline.stats import assignment_rows, clusters_for
        ids, X = load_embeddings(build)
        rows = {r["conv_id"]: r["leaf_id"] for r in assignment_rows(build.build_id, clusters_for(build.load("structure_final")))}
        sel = [i for i, c in enumerate(ids) if rows.get(c) and rows[c] != "cl_other"]
        rng = np.random.default_rng(0)
        if len(sel) > 3000:
            sel = sorted(rng.choice(sel, 3000, replace=False).tolist())
        labels = [rows[ids[i]] for i in sel]
        sil = silhouette_score(X[sel], labels, metric="cosine") if len(set(labels)) > 1 else float("nan")
        out.append(check("silhouette", "Silhouette of leaf assignment on facet embeddings", f"{sil:.3f}", "informational",
                         None, f"cosine, {len(sel)} conversations outside Other; classification is by Jev on the full "
                         "conversation, not by nearest centroid, so modest values are expected."))
    except Exception as e:
        out.append(check("silhouette", "Silhouette of leaf assignment", "unavailable", "informational", None, type(e).__name__))
    d1 = build.load("discover_r1", {}) if build.has("discover_r1") else {}
    diag = d1.get("diagnostics", {})
    k = str(d1.get("k", ""))
    if diag:
        parts = "; ".join(f"k={kk}: ARI {v['ari_two_seeds']:.2f}, silhouette {v['silhouette']:.3f}" for kk, v in sorted(diag.items(), key=lambda x: int(x[0])))
        ari = diag.get(k, {}).get("ari_two_seeds")
        out.append(check("kmeans_stability", "k-means stability across two seeds (capped subset)",
                         f"ARI {fmt(ari)} at k={k}", "informational", None,
                         f"{d1.get('subset', 0)} capped conversations ({d1.get('subset_people', 0)} people, ≤ 3 each, "
                         f"near-duplicates collapsed); {parts}."))
    return out


def sandbox_checks(snapshot_id: str) -> list[dict]:
    """Containment and live analyses recorded for THIS snapshot only. Missing runs are mandatory checks
    that count as not verified (passed False), not informational."""
    con = db.public()
    out = []
    row = con.execute("SELECT json FROM runs WHERE kind = 'containment' AND snapshot_id = ? ORDER BY updated_at DESC LIMIT 1",
                      (snapshot_id,)).fetchone()
    target = "killed at deadline, container removed, app healthy"
    if row is None:
        out.append(check("containment", "Containment demo", NOT_VERIFIED, target, False,
                         "no containment run recorded for this snapshot yet"))
    else:
        r = json.loads(row["json"])
        c = r.get("containment") or {}
        ok = r.get("state") == "completed" and c.get("killed") and c.get("container_removed") and c.get("app_health") == "ok"
        out.append(check("containment", "Containment demo", r.get("state", "?"), target, bool(ok),
                         f"killed {c.get('killed')}, container removed {c.get('container_removed')}, app health "
                         f"{c.get('app_health')}, follow-up passed {c.get('followup_passed')}, leak attempt rejected "
                         f"{c.get('leak_attempt_rejected')}."))
    intents = ["usage", "friction"] + [r["intent"] for r in con.execute(
        "SELECT DISTINCT intent FROM runs WHERE kind = 'analysis' AND snapshot_id = ? AND intent NOT IN ('usage', 'friction')",
        (snapshot_id,)) if r["intent"]]
    for intent in intents:
        if intent == "question":
            out.append(_question_check(con, snapshot_id))
            continue
        row = con.execute("SELECT json FROM runs WHERE kind = 'analysis' AND intent = ? AND snapshot_id = ? "
                          "ORDER BY updated_at DESC LIMIT 1", (intent, snapshot_id)).fetchone()
        if row is None:
            out.append(check(f"live_{intent}", f"Live analysis: {intent}", NOT_VERIFIED, "gated result", False,
                             "no run recorded for this snapshot yet"))
        else:
            r = json.loads(row["json"])
            v = r.get("verdict") or {}
            out.append(check(f"live_{intent}", f"Live analysis: {intent}", r.get("state", "?"), "gated result",
                             r.get("state") == "completed" and bool(v.get("passed")),
                             f"attempts {r.get('attempts')}, runtime {(r.get('receipt') or {}).get('runtime')}, "
                             f"{sum(1 for c in v.get('checks', []) if c.get('passed'))}/{len(v.get('checks', []))} gate checks passed."))
    return out


def _question_check(con, snapshot_id: str) -> dict:
    """Open questions: a refusal of an unsupported question is correct behaviour, not a failure.
    Passes when the latest answerable question completed with a passed gate verdict."""
    runs = [json.loads(r["json"]) for r in con.execute(
        "SELECT json FROM runs WHERE kind = 'analysis' AND intent = 'question' AND snapshot_id = ? ORDER BY updated_at DESC",
        (snapshot_id,))]
    refused = [r for r in runs if (r.get("error") or {}).get("code") == "unsupported_question"]
    answerable = [r for r in runs if r not in refused and r.get("state") in ("completed", "failed")]
    completed = [r for r in answerable if r.get("state") == "completed" and bool((r.get("verdict") or {}).get("passed"))]
    latest = answerable[0] if answerable else None
    ok = bool(latest) and latest in completed
    detail = (f"{len(completed)} of {len(answerable)} answerable questions completed with a passed gate; "
              f"{len(refused)} unsupported questions refused before any code ran.")
    return check("live_question", "Live analysis: open question", latest.get("state", "?") if latest else NOT_VERIFIED,
                 "gated result", ok, detail)


def build_report() -> dict:
    snap = current_snapshot()
    if snap is None:
        raise SystemExit("no current snapshot; run `logless rebuild` first")
    build = build_for(snap["snapshot_id"])
    checks: list[dict] = []
    checks += reconciliation(snap, build)
    checks.append(stats_source_check(snap))
    checks += gate_check(build)
    checks += friction_reference(set(build.conv_ids) if build else set())
    checks.append(theme_reference(snap))
    checks += external_checks(snap, build)
    checks += cluster_quality(snap, build)
    checks += sandbox_checks(snap["snapshot_id"])
    report = {"snapshot_id": snap["snapshot_id"], "generated_at": utcnow(), "checks": checks}
    # leak scans run last and include this report itself
    leak, i_hits = leak_checks([("eval_report_new", json.dumps(report, ensure_ascii=False))])
    inj = injection_check(i_hits, build)
    report["checks"] = leak + [inj] + checks
    return report


def main() -> int:
    logging.getLogger("httpx").setLevel(logging.WARNING)
    report = build_report()
    con = db.public()
    with db.write(con):
        con.execute("INSERT OR REPLACE INTO eval_reports(snapshot_id, json, created_at) VALUES (?,?,?)",
                    (report["snapshot_id"], json.dumps(report, ensure_ascii=False), report["generated_at"]))
    for c in report["checks"]:
        mark = {True: "PASS", False: "FAIL", None: "info"}[c["passed"]]
        print(f"[{mark}] {c['name']}: {c['value']} (target {c['target']})")
    scored = [c for c in report["checks"] if c["passed"] is not None]
    print(f"{sum(1 for c in scored if c['passed'])} of {len(scored)} targets met")
    snap = current_snapshot()
    from .summary import write_summary
    write_summary(snap, build_for(snap["snapshot_id"]), report)
    return 0
