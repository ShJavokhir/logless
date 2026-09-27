import json
from pathlib import Path
import pytest
from logless.synthetic.models import SIGNALS
from logless.synthetic.pipeline import freeze, build_snapshot, reduce_records, map_records, load_records
from logless.synthetic.seed import generate
from logless.synthetic.questions import questions
from logless.providers import jev
from logless.providers.http import ProviderError


def taxonomy():
    return freeze({"categories": [{"name": "Organize together", "leaves": [{"name": "Coordinate changing plans", "short_name": "Shared plans", "definition": "Coordinate availability, constraints and follow-up across several people.", "includes": ["Shared plans with changing constraints"], "excludes": ["A reminder for one person"]}]}]})


def answer(question, chosen, confidence=1):
    return {"type": "choice", "choice": chosen, "probabilities": {key: int(key == chosen) for key in question['criteria']}, "confidence": confidence}


def test_frozen_taxonomy_versions_change_with_membership_rules():
    old = taxonomy()
    raw = {"categories": [{"name": c['name'], "leaves": [{k: v for k, v in leaf.items() if k != 'id'} for leaf in c['leaves']]} for c in old['categories']]}
    raw['categories'][0]['leaves'][0]['excludes'].append('Travel administration')
    new = freeze(raw, old['version'])
    assert new['version'] != old['version']
    assert new['parent_version'] == old['version']
    assert new['categories'][0]['leaves'][0]['id'] == old['categories'][0]['leaves'][0]['id']


def test_reduce_batches_questions_uses_confidence_and_reclassifies(tmp_data, monkeypatch):
    seen = []
    def evaluate(state, q):
        seen.append((state, q))
        assert set(q) == {'theme', *SIGNALS}
        assert set(state) == {'interaction'}
        leaf = next(k for k in q['theme']['criteria'] if k != 'other')
        return {'model': 'jev-test', 'answers': {name: answer(question, leaf if name == 'theme' else 'not_observed', .4 if name == 'theme' else 1) for name, question in q.items()}, 'usage': {'input_tokens': 1}}
    monkeypatch.setattr(jev, 'evaluate', evaluate)
    t = taxonomy(); facets = [{'goal': 'Make a shared plan', 'outcome': 'Proposal offered', 'evidence': 'No negative feedback'}] * 3
    rows = reduce_records(facets, t, tmp_data, 2, .65)
    assert len(rows) == 3 and len(seen) == 1
    assert all(row['theme'] == 'other' for row in rows)
    assert rows[0]['raw']['model'] == 'jev-test'
    reduce_records(facets, {**t, 'version': 'tax_changed'}, tmp_data, 2, .65)
    assert len(seen) == 2


def test_counts_reconcile_signal_union_and_distinct_people(tmp_data):
    generate(tmp_data / 'fixtures', 24)
    records = load_records(tmp_data / 'fixtures/conversations.jsonl')
    records[1]['user_id'] = records[0]['user_id']
    tax = taxonomy(); leaf = tax['categories'][0]['leaves'][0]['id']
    rows = [{'theme': leaf if i else 'other', 'signals': dict.fromkeys(SIGNALS, 'not_observed'), 'taxonomy_version': tax['version'], 'raw': {'model': 'jev-test'}} for i in range(len(records))]
    rows[1]['signals'].update(correction='observed', complaint='observed')
    rows[2]['signals']['unresolved_action_error'] = 'observed'
    rows[3]['signals']['correction'] = 'unclear'
    result = build_snapshot(records, rows, tax, 1)
    assert result['totals']['conversations'] == 24
    assert result['totals']['users'] == 23
    assert sum(c['conversations'] for c in result['clusters']) == 24
    assert result['totals']['friction']['conversations'] == 2
    assert result['totals']['friction']['unclear'] == 1
    assert result['totals']['friction']['signals'] == dict(correction=1, complaint=1, unresolved_action_error=1)
    assert result['dataset']['synthetic'] is True
    public = json.dumps(result)
    assert all(r['id'] not in public and r['user_id'] not in public for r in records)
    rows[0]['taxonomy_version'] = 'old'
    with pytest.raises(ValueError, match='mixed taxonomy'):
        build_snapshot(records, rows, tax, 1)


def test_map_does_not_send_ids_or_expected_labels(tmp_data, monkeypatch):
    from logless.providers import glm
    from logless.synthetic.models import FacetBatch
    generate(tmp_data / 'fixtures', 12)
    records = load_records(tmp_data / 'fixtures/conversations.jsonl')
    def chat(system, payload, schema, **kwargs):
        inputs = json.loads(payload)
        assert all(set(r) == {'index', 'messages', 'tool_events'} for r in inputs)
        assert all(r['id'] not in payload and r['user_id'] not in payload for r in records)
        assert 'goal_family' not in payload
        assert kwargs['model'] == 'glm-5.3'
        return FacetBatch(interactions=[{'index': r['index'], 'goal': 'Coordinate a shared plan', 'outcome': 'No completion confirmation', 'evidence': 'No negative feedback was given'} for r in inputs]), {'model': 'glm-5.3'}
    monkeypatch.setattr(glm, 'chat_json', chat)
    facets, _ = map_records(records, tmp_data, 2)
    assert len(facets) == len(records)


def test_map_retries_generalization_and_never_caches_unsafe_facets(tmp_data, monkeypatch):
    from logless.providers import glm
    from logless.synthetic.models import FacetBatch
    generate(tmp_data / 'fixtures', 12)
    records = load_records(tmp_data / 'fixtures/conversations.jsonl')
    calls = []
    def chat(system, payload, schema, **kwargs):
        calls.append(kwargs)
        return FacetBatch(interactions=[{
            'index': r['index'], 'goal': 'Coordinate a shared plan',
            'outcome': 'No confirmed result',
            'evidence': 'ORCHIDCANARY0000' if len(calls) == 1 else 'No negative feedback',
        } for r in json.loads(payload)]), {'model': 'glm-test'}
    monkeypatch.setattr(glm, 'chat_json', chat)
    facets, metadata = map_records(records, tmp_data, 1)
    assert len(calls) == 2 and calls[1]['use_cache'] is False
    assert metadata[0]['generalization_attempts'] == 2
    assert 'ORCHIDCANARY' not in json.dumps(facets)
    assert all('ORCHIDCANARY' not in p.read_text() for p in (tmp_data / 'map').glob('*.json'))


def test_strict_jev_rejects_unknown_choice(tmp_data, monkeypatch):
    q = questions(taxonomy())
    def post(*args, **kwargs):
        return {'model': 'jev-test', 'answers': {name: answer(question, 'invented') for name, question in q.items()}}
    monkeypatch.setattr(jev, 'post_json', post)
    with pytest.raises(ProviderError):
        jev.evaluate({'interaction': {}}, q)


@pytest.mark.parametrize('invalid', [None, [], {'probabilities': None}, {'probabilities': []}])
def test_strict_jev_rejects_malformed_answer(tmp_data, monkeypatch, invalid):
    q = questions(taxonomy())
    monkeypatch.setattr(jev, 'post_json', lambda *args, **kwargs: {
        'model': 'jev-test', 'answers': {name: invalid for name in q},
    })
    with pytest.raises(ProviderError, match='malformed_choice'):
        jev.evaluate({'interaction': {}}, q)


def test_search_sends_only_published_summaries_and_allows_no_matches(tmp_data, monkeypatch):
    from logless.api import search
    def evaluate(state, q, **kwargs):
        assert state == {'query': 'quantum potato', 'clusters': {'cl_abcdef': {'title': 'Shared plans', 'description': 'Coordinate schedules'}}}
        assert 'clusters.cl_abcdef' in q['cl_abcdef']['instructions']
        return {'answers': {'cl_abcdef': answer(q['cl_abcdef'], 'not_relevant')}}
    monkeypatch.setattr(jev, 'evaluate', evaluate)
    snapshot = {'snapshot_id': 's', 'dataset': {'synthetic': True}, 'private': 'DO NOT SEND', 'clusters': [{'id': 'cl_abcdef', 'title': 'Shared plans', 'description': 'Coordinate schedules', 'private': 'DO NOT SEND'}]}
    results, _ = search.run(snapshot, 'Quantum Potato')
    assert not any(r['relevance'] == 'relevant' for r in results)


def test_bounded_map_stops_scheduling_on_provider_failure():
    from logless.synthetic.pipeline import bounded_map
    attempted = []
    def fail(item):
        attempted.append(item)
        raise ProviderError('jev', 401, 'auth_error')
    with pytest.raises(ProviderError):
        bounded_map(fail, range(600), 3)
    assert len(attempted) <= 3


def test_rebuild_publishes_atomically_and_keeps_previous_on_failure(tmp_data, monkeypatch):
    from logless import db
    from logless.synthetic import pipeline
    from logless.providers import glm
    from logless.synthetic.models import FacetBatch, Taxonomy
    fixture = tmp_data / 'fixtures'
    generate(fixture, 24)
    raw_taxonomy = {'categories': [{'name': c['name'], 'leaves': [{k: v for k, v in leaf.items() if k != 'id'} for leaf in c['leaves']]} for c in taxonomy()['categories']]}
    def chat(system, payload, schema, **kwargs):
        if schema is FacetBatch:
            return FacetBatch(interactions=[{'index': r['index'], 'goal': 'Coordinate a shared plan', 'outcome': 'Proposal offered', 'evidence': 'No negative feedback'} for r in json.loads(payload)]), {'model': 'glm-test'}
        return Taxonomy.model_validate(raw_taxonomy), {'model': 'glm-test'}
    def evaluate(state, q):
        leaf = next(k for k in q['theme']['criteria'] if k != 'other')
        return {'model': 'jev-test', 'answers': {name: answer(question, leaf if name == 'theme' else 'not_observed') for name, question in q.items()}}
    monkeypatch.setattr(glm, 'chat_json', chat)
    monkeypatch.setattr(jev, 'evaluate', evaluate)
    report = pipeline.rebuild(fixture / 'conversations.jsonl')
    current = db.public().execute('SELECT json FROM snapshots WHERE is_current=1').fetchone()
    published = json.loads(current['json'])
    assert published['snapshot_id'] == report['snapshot_id']
    assert published['totals']['conversations'] == 24
    def fail(*args, **kwargs):
        raise ProviderError('jev', 401, 'auth_error')
    monkeypatch.setattr(jev, 'evaluate', fail)
    # A changed threshold invalidates decision artifacts and exercises a failed candidate.
    with pytest.raises(ProviderError):
        pipeline.rebuild(fixture / 'conversations.jsonl', cutoff=.7)
    assert db.public().execute('SELECT snapshot_id FROM snapshots WHERE is_current=1').fetchone()['snapshot_id'] == report['snapshot_id']


def test_evolution_reclassifies_clear_records_and_preserves_unchanged_lineage(tmp_data, monkeypatch):
    from logless.synthetic import pipeline
    from logless.providers import glm
    from logless.synthetic.models import Taxonomy
    generate(tmp_data / 'fixtures', 12)
    tax = taxonomy()
    leaf = tax['categories'][0]['leaves'][0]['id']
    facets = [{'goal': f'Goal {i}', 'outcome': 'No confirmed result', 'evidence': 'No feedback'} for i in range(12)]
    monkeypatch.setattr(pipeline, 'map_records', lambda *args: (facets, []))
    raw = {'categories': [{'name': c['name'], 'leaves': [{k: v for k, v in x.items() if k != 'id'} for x in c['leaves']]} for c in tax['categories']]}
    revision = [False]
    def chat(system, payload, schema, **kwargs):
        candidate = json.loads(json.dumps(raw))
        if revision[0]:
            candidate['categories'][0]['leaves'][0]['includes'].append('Changed group constraints')
        return Taxonomy.model_validate(candidate), {'model': 'glm-test'}
    seen = []
    def evaluate(state, q):
        seen.append(state['interaction']['goal'])
        chosen = 'other' if state['interaction']['goal'] == 'Goal 0' else leaf
        return {'model': 'jev-test', 'answers': {name: answer(question, chosen if name == 'theme' else 'not_observed') for name, question in q.items()}}
    monkeypatch.setattr(glm, 'chat_json', chat)
    monkeypatch.setattr(jev, 'evaluate', evaluate)
    source = tmp_data / 'fixtures/conversations.jsonl'
    first = pipeline.rebuild(source)
    assert len(seen) == 12
    revision[0] = True
    second = pipeline.rebuild(source, evolve=True)
    assert second['taxonomy_version'] != first['taxonomy_version']
    assert len(seen) == 24 and seen.count('Goal 1') == 2
    root = Path(second['private_artifacts'])
    current = json.loads((root / 'active-taxonomy.json').read_text())
    assert current['parent_version'] == first['taxonomy_version']
    third = pipeline.rebuild(source, evolve=True)
    assert third['taxonomy_version'] == second['taxonomy_version']
    assert json.loads((root / 'active-taxonomy.json').read_text()) == current
    assert len(seen) == 24
    assert third['jev_measured_requests'] == 0 and third['jev_p95_ms'] is None
    assert json.loads((root / 'unclear-review.json').read_text())['taxonomy_version'] == current['version']
