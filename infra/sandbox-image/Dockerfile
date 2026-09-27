# logless analysis sandbox image: logless-analysis:1
# Runs untrusted, model-generated pandas/numpy code under gVisor (runsc) with --network=none,
# --read-only, --cap-drop=ALL, uid 10001. Nothing here needs network at runtime.
#
# Base pinned by digest (python:3.12-slim = Python 3.12.14 on Debian 13 trixie, pulled 2026-09-26).
# To bump: docker pull python:3.12-slim && docker inspect --format '{{index .RepoDigests 0}}' python:3.12-slim
FROM python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN pip install --no-cache-dir pandas==2.2.3 numpy==2.1.3 \
 && groupadd --system --gid 10001 sandbox \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /work \
      --shell /usr/sbin/nologin sandbox \
 && install -d -o 10001 -g 10001 -m 755 /work \
 && python -c "import pandas, numpy; print('pandas', pandas.__version__, 'numpy', numpy.__version__)"

WORKDIR /work
USER 10001:10001
# Root fs is mounted read-only at runtime; anything that wants a writable HOME gets /tmp (tmpfs).
ENV HOME=/tmp
CMD ["python"]
