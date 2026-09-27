#!/usr/bin/env bash
# gVisor sandbox smoke tests. Run as root ON logless-sandbox (works locked or unlocked):
#   ssh -F infra/ssh_config logless-sandbox 'bash -s' < infra/sandbox-smoke.sh
set -uo pipefail

IMG=${IMG:-logless-analysis:1}
RUNTIME=${RUNTIME:-runsc}
HARD=(--runtime="$RUNTIME" --network=none --read-only --tmpfs /tmp:rw,size=64m --cap-drop=ALL
      --security-opt=no-new-privileges --pids-limit=64 --memory=512m --memory-swap=512m --cpus=1
      --user 10001:10001)
now() { date +%s.%N; }
dt()  { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.3f", b-a}'; }

echo "== host: $(uname -r) | $(runsc --version | head -n1) | runtime=$RUNTIME | image=$(docker image inspect -f '{{.Id}}' "$IMG" | cut -c1-19)"

echo; echo "== 1. hardened run: import pandas/numpy"
docker run --rm "${HARD[@]}" "$IMG" python -c "import pandas, numpy; print('ok', pandas.__version__)"
echo "exit=$?"

echo; echo "== 2. gVisor evidence (host kernel is $(uname -r))"
echo "-- dmesg inside runsc:"
docker run --rm "${HARD[@]}" "$IMG" dmesg
echo "-- uname -a inside runsc:"
docker run --rm "${HARD[@]}" "$IMG" uname -a
echo "-- same image under runc for comparison:"
docker run --rm --runtime=runc --network=none "$IMG" uname -r

echo; echo "== 3. network is off"
docker run --rm "${HARD[@]}" "$IMG" python -c "import socket; print('interfaces:', socket.if_nameindex())"
docker run --rm "${HARD[@]}" "$IMG" python -c "import socket; socket.create_connection(('1.1.1.1',53),2)" 2>&1 | tail -n1
echo "exit=${PIPESTATUS[0]} (non-zero = connection failed, as intended)"

echo; echo "== 4. runaway kill after 2.0s"
name="logless-runaway-$(date +%s%N)"
t0=$(now)
timeout --signal=KILL 2.0 docker run --rm --name "$name" "${HARD[@]}" "$IMG" python -c "while True: pass"
rc=$?
t1=$(now)
state=$(docker inspect -f '{{.State.Status}} pid={{.State.Pid}}' "$name" 2>&1)
docker rm -f "$name" >/dev/null 2>&1
t2=$(now)
left=$(docker ps -a --filter "name=^${name}\$" --format '{{.Names}}' | wc -l)
echo "container=$name timeout_rc=$rc state_at_deadline=[$state]"
echo "deadline_fired_after=$(dt "$t0" "$t1")s  docker_rm_f_took=$(dt "$t1" "$t2")s  total_elapsed=$(dt "$t0" "$t2")s"
echo "containers left with that name: $left"
pgrep -fa "$name" >/dev/null && echo "WARNING: leftover runsc process" || echo "no leftover runsc processes"

echo; echo "== 5. mounts: ro input, rw output owned by 10001"
rm -rf /tmp/in /tmp/out && mkdir -p /tmp/in /tmp/out
printf 'service,latency_ms\napi,120\napi,80\nweb,200\n' >/tmp/in/data.csv
chown 10001:10001 /tmp/out && chmod 700 /tmp/out
# /tmp/in is owned by 10001 too, so a failed write proves the :ro mount (not file permissions) blocks it.
chown -R 10001:10001 /tmp/in
docker run --rm "${HARD[@]}" -v /tmp/in:/in:ro -v /tmp/out:/out:rw "$IMG" python -c "
import json, pandas as pd
df = pd.read_csv('/in/data.csv')
res = {'rows': len(df), 'mean_latency_by_service': df.groupby('service').latency_ms.mean().to_dict()}
json.dump(res, open('/out/result.json', 'w'))
try:
    open('/in/should_fail', 'w')
except OSError as e:
    print('write to /in blocked:', e.strerror)
try:
    open('/work/should_fail', 'w')  # /work is owned by uid 10001, only --read-only can block this
except OSError as e:
    print('write to rootfs (/work) blocked:', e.strerror)
open('/tmp/scratch', 'w').write('x'); print('write to /tmp tmpfs: ok')
"
echo "host reads /tmp/out/result.json: $(cat /tmp/out/result.json)"
ls -ln /tmp/out

echo; echo "== 6. cold-start latency (python -c pass), 5 sequential runs"
for i in 1 2 3 4 5; do
  a=$(now); docker run --rm "${HARD[@]}" "$IMG" python -c pass; b=$(now)
  echo "run $i: $(dt "$a" "$b")s"
done
for i in 1 2; do
  a=$(now); docker run --rm "${HARD[@]}" "$IMG" python -c "import pandas"; b=$(now)
  echo "runsc 'import pandas' run $i: $(dt "$a" "$b")s"
done
a=$(now); docker run --rm --runtime=runc --network=none "$IMG" python -c "import pandas"; b=$(now)
echo "runc comparison ('import pandas'): $(dt "$a" "$b")s"
a=$(now); docker run --rm --runtime=runc --network=none "$IMG" python -c pass; b=$(now)
echo "runc comparison (python -c pass): $(dt "$a" "$b")s"

echo; echo "== 7. limits: 1 GiB allocation in a 512m container"
docker run --rm "${HARD[@]}" "$IMG" python -c "b = bytearray(1024*1024*1024); print('allocated?!')" 2>&1 | tail -n1
echo "exit=${PIPESTATUS[0]} (137 = OOM-killed)"
