from logless.pipeline.describe import has_number
from logless.pipeline.privacy import (TokenScanner, contact_hits, distinctive_ngrams, scan_payload, source_id_hits,
                                      text_strings)


def test_token_scanner_normalizes_case_and_unicode():
    sc = TokenScanner(["Quillan Marrowby", "quillan.marrowby@fenwarp.net", "+1 (415) 555-0142", "VELVET-ORCHID-17"])
    assert sc.hits("Letter from QUILLAN MARROWBY") == 1
    assert sc.hits("Ｑｕｉｌｌａｎ　Ｍａｒｒｏｗｂｙ wrote") == 1  # full-width forms fold under NFKC
    assert sc.hits("call 1-415-555-0142 today") == 1  # digits-only phone match
    assert sc.hits("code velvet-orchid-17") == 1
    assert sc.hits("Quillanx Marrowbys") == 0  # word boundaries
    assert sc.hits("People ask for cover letters") == 0


def test_contact_patterns():
    assert "email" in contact_hits("write to a.b@c.net")
    assert "phone" in contact_hits("call +1 (415) 555-0142")
    assert "url" in contact_hits("see https://example.org/x") and "url" in contact_hits("visit example.com")
    assert "handle" in contact_hits("ping @someone_42 on there")
    assert "user_path" in contact_hits("file at /Users/jdoe/Desktop/a.txt")
    assert "user_path" in contact_hits(r"C:\Users\jdoe\file.txt")
    assert "secret" in contact_hits("key sk-abcdefghijklmnopqrstuv")
    assert "ip_address" in contact_hits("server 192.168.1.20")
    # common technology names are not contacts
    for ok in ("Build an ASP.NET web app", "Use GPT-4 with Python 3", "Explain Node.js streams", "Debug React hooks"):
        assert contact_hits(ok) == [], ok


def test_source_id_patterns():
    assert "conversation_id" in source_id_hits("record c_0123456789ab")
    assert "user_pseudonym" in source_id_hits("user u_0123456789")
    assert "hashed_ip" in source_id_hits("a" * 64)
    assert "turn_identifier" in source_id_hits("turn 123456")
    assert "build_id" in source_id_hits("b_20260927T004302")
    assert source_id_hits("Windows 10 setup help") == []


def test_distinctive_ngrams():
    corpus = ["my grandmother's blue bicycle shop in the old harbour is closing",
              "people want help writing cover letters for retail jobs",
              "people want help writing cover letters for retail jobs",
              "people want help writing cover letters for retail jobs",
              "people want help writing cover letters for retail jobs"]
    texts = {"a": "Their grandmother's blue bicycle shop in the old harbour",  # copied from one source
             "b": "People want help writing cover letters for retail jobs",    # common (4 docs > 3)
             "c": "Short text"}
    out = distinctive_ngrams(texts, corpus)
    assert out["a"] > 0
    assert out["b"] == 0
    assert out["c"] == 0


def test_has_number():
    assert has_number("Most people ask twice")
    assert has_number("About 40% of requests")
    assert has_number("Seen 12 times")
    assert has_number("Hundreds of requests")
    assert not has_number("Write code with GPT-4 and Python 3")
    assert not has_number("Create 3D models for games")
    assert not has_number("Fix errors on Windows 10")
    assert not has_number("People want working code that runs")


def test_scan_payload_and_text_strings():
    snap = {"snapshot_id": "snap_20260927T000000_abcd", "clusters": [{"id": "cl_abc123", "title": "Write cover letters"}],
            "dataset": {"source_url": "https://huggingface.co/datasets/allenai/WildChat-1M"}}
    paths = [p for p, _ in text_strings(snap)]
    assert "clusters[0].title" in paths
    assert not any(p.endswith(".id") or p == "snapshot_id" or "source_url" in p for p in paths)
    sc = TokenScanner(["Quillan Marrowby"])
    assert scan_payload('{"title": "Quillan Marrowby"}', sc)["fixture_tokens"] == 1
