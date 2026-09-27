"""Live classifier/search probes. Evaluation labels are read only after requests are constructed."""
from __future__ import annotations
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from ..config import REPO_ROOT
from ..providers import jev
from ..api import search
from .models import SIGNALS
from .pipeline import freeze, private_root, write
from .questions import questions


def main():
    os.environ.setdefault("LOGLESS_DATA_DIR", "./var-synthetic")
    cases = json.loads((REPO_ROOT / 'backend/fixtures/synthetic/classifier-cases.json').read_text())
    taxonomy = freeze({'categories': [{'name': 'Assistant work', 'leaves': [
        {'name': 'Coordinate shared plans', 'short_name': 'Shared plans', 'definition': 'Coordinate several people, changing availability, and follow-up.', 'includes': ['Group scheduling', 'Shared responsibilities'], 'excludes': ['Writing a message without coordinating constraints']},
        {'name': 'Draft messages', 'short_name': 'Draft messages', 'definition': 'Write or revise personal messages with an appropriate tone.', 'includes': ['Invitations', 'Polite refusals'], 'excludes': ['Multi-person planning with availability and follow-up']},
    ]}]})
    names = {taxonomy['categories'][0]['leaves'][0]['id']: 'coordination', taxonomy['categories'][0]['leaves'][1]['id']: 'writing', 'other': 'other'}
    q = questions(taxonomy)
    def one(case):
        t0 = time.perf_counter()
        result = jev.evaluate({'interaction': case['interaction']}, q)
        elapsed = round((time.perf_counter()-t0)*1000)
        decisions = {name: (a['choice'] if a['confidence'] >= .65 else ('other' if name == 'theme' else 'unclear')) for name, a in result['answers'].items()}
        decisions['theme'] = names[decisions['theme']]
        return {'case': case['case'], 'elapsed_ms': elapsed, 'model': result['model'], 'usage': result.get('usage'), 'decisions': decisions, 'expected': case['expected'], 'correct': decisions == case['expected'], 'confidence': {name: a['confidence'] for name,a in result['answers'].items()}}
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=3) as pool:
        rows = list(pool.map(one, cases))
    snapshot = {'snapshot_id': 'classifier-probe', 'dataset': {'synthetic': True}, 'clusters': [{'id': leaf['id'], 'title': leaf['name'], 'description': leaf['definition']} for leaf in taxonomy['categories'][0]['leaves']]}
    searches = []
    for query in ['coordinating people with changing availability', 'repairing the propulsion drive of an interstellar spacecraft']:
        start = time.perf_counter()
        results, elapsed = search.run(snapshot, query)
        searches.append({'query': query, 'matches': [r['cluster_id'] for r in results if r['relevance'] == 'relevant'], 'provider_ms': elapsed, 'wall_ms': round((time.perf_counter()-start)*1000)})
    times = sorted(r['elapsed_ms'] for r in rows)
    report = {'note': 'Authored synthetic regression abstractions and a fixed evaluation taxonomy; this probe does not claim GLM discovery.', 'records': len(rows), 'correct_records': sum(r['correct'] for r in rows), 'correct_decisions': sum(r['decisions'][k] == r['expected'][k] for r in rows for k in ['theme', *SIGNALS]), 'decisions': len(rows)*4, 'p50_ms': times[len(times)//2], 'p95_ms': times[-1], 'concurrency': 3, 'total_seconds_including_search': round(time.perf_counter()-t0, 3), 'cases': rows, 'search': searches}
    write(private_root() / 'live-verification.json', report)
    write(private_root() / f'live-verification-{time.time_ns()}.json', report)
    print(json.dumps(report, indent=2))

if __name__ == '__main__':
    main()
