# Reproducible Python installs

The backend and runner have separate checked-in `uv.lock` files, including their optional
`dev` dependencies. The locks were seeded from the package versions that already passed the
review suites, then installed successfully into clean environments. No dependency was upgraded.
Build-system requirements are also pinned to the tested Hatchling dependency set.
Project cache keys include application source and packaged fixture files, so changing code
invalidates a cached non-editable wheel even when the project version stays the same.

Use Python **3.12** and `uv` with project locking support; this procedure was verified with
`uv 0.7.3`. `.python-version` selects the 3.12 series, not a patch downgrade. Existing deployments
can retain their supported 3.12 patch version; clean local verification used CPython 3.12.9 on
macOS arm64. The Linux execution sandbox's Python and libraries are a separate image contract.

## Development checkout

From the repository root:

```bash
uv sync --project backend --locked --extra dev --python 3.12
uv sync --project runner --locked --extra dev --python 3.12
backend/.venv/bin/python -m pytest -q backend/tests
runner/.venv/bin/python -m pytest -q runner/tests
```

`dev` is currently an **optional extra**, not a dependency group: use `--extra dev` explicitly
for tests. Production omits that extra:

```bash
uv sync --project backend --locked --no-dev --python /path/to/existing/python3.12
uv sync --project runner --locked --no-dev --python /path/to/existing/python3.12
```

`uv sync` exactly synchronizes the selected environment and can remove packages not in the
selected dependency set. Use a separate environment for verification when preserving an existing
installation matters. `--locked` refuses a stale lock instead of silently resolving new versions;
`--frozen` skips that freshness check. Do not use `uv pip install -e .` for a locked deployment.
These are installation instructions, not authorization to restart or replace a deployed service.
See the [official uv locking and syncing documentation](https://docs.astral.sh/uv/concepts/projects/sync/).

## Clean verification without modifying existing environments

```bash
repro_dir=$(mktemp -d "${TMPDIR:-/tmp}/logless-repro.XXXXXX")
UV_PROJECT_ENVIRONMENT="$repro_dir/backend" \
  uv sync --project backend --locked --extra dev --no-editable --python 3.12
UV_PROJECT_ENVIRONMENT="$repro_dir/runner" \
  uv sync --project runner --locked --extra dev --no-editable --python 3.12

# Copy test assets without application source so imports exercise the installed wheels.
mkdir -p "$repro_dir/test-checkout/backend" "$repro_dir/test-checkout/runner"
cp -R backend/tests backend/scripts backend/sandbox_tasks "$repro_dir/test-checkout/backend/"
cp -R runner/tests "$repro_dir/test-checkout/runner/"
(cd "$repro_dir/test-checkout/backend" && "$repro_dir/backend/bin/python" -m pytest -q tests)
(cd "$repro_dir/test-checkout/runner" && "$repro_dir/runner/bin/python" -m pytest -q tests)
```

`--no-editable` installs a wheel rather than a source link. To verify packaging independently
of Python's working-directory imports, use the copied test checkout above and assert that
`logless.__file__` / `logless_runner.__file__` are under the new environment. Run each suite
from its copied package directory: two backend tests import siblings through the `tests`
namespace. The review used this layout with no application source packages in the test tree.
After concurrent source edits, finish the edits before verification and rebuild explicitly
with `--reinstall-package logless` / `--reinstall-package logless-runner` if needed; compare
installed bytes or a reviewed wheel digest so a stale build cannot masquerade as new code.

The backend wheel includes the four containment programs as `logless/sandbox/tasks/*.py`.
`test_packaged_fixtures.py` compares all four to the reviewed source bytes; it never executes
the runaway or destructive programs. Source/editable installs continue to load the canonical
`backend/sandbox_tasks` files. No destructive containment program is suitable for host execution.

Standalone backend wheel processes must set an **absolute `LOGLESS_DATA_DIR`** and supply their
configuration through the environment. Automatic repository-root `.env` discovery and the web
build leak-scan path are source-checkout conveniences, not a standalone wheel configuration API.

## Locked wheelhouse for an offline runner

Prepare wheels on an online Python 3.12 machine for the destination platform. The simplest option
is a Linux x86_64 build/staging machine matching the VM. No dependency resolution should occur
on the egress-locked host.

```bash
uv export --project runner --locked --no-dev --no-emit-project \
  --format requirements.txt --output-file runner/requirements-runtime.txt
uv build runner --wheel --out-dir runner/dist
python3.12 -m pip download --require-hashes --only-binary=:all: \
  -r runner/requirements-runtime.txt -d runner/wheelhouse

# After the locked requirements, wheelhouse, and reviewed project wheel are transferred:
/path/to/new-runner-env/bin/python -m pip install --no-index \
  --find-links /path/to/wheelhouse --require-hashes -r /path/to/requirements-runtime.txt
/path/to/new-runner-env/bin/python -m pip install --no-index --no-deps /path/to/logless_runner-0.1.0-py3-none-any.whl
/path/to/new-runner-env/bin/python -m pip check
```

The generated requirements retain SHA-256 hashes from `uv.lock`; do not pass `--no-hashes`.
Record and verify the project wheel's SHA-256 when transferring it as well. To include test
dependencies in a separate verification wheelhouse, add `--extra dev` to `uv export`.

For cross-platform downloads from macOS, specify the Linux wheel tags explicitly (`--platform
manylinux_2_28_x86_64 --platform manylinux2014_x86_64 --python-version 3.12 --implementation cp
--abi cp312` to `pip download`). Only binary Linux-compatible wheels should be accepted. The
review successfully hash-verified and staged the runtime closures for CPython 3.12 / Linux
x86_64, but did not execute those Linux packages; that remains a VM verification step.

## Intentional dependency updates

```bash
uv lock --project backend --check
uv lock --project runner --check
# When deliberately changing one package, review the resulting lock diff and rerun relevant tests:
uv lock --project backend --upgrade-package PACKAGE_NAME
```

Keep manifests and lockfiles together in a change. Do not regenerate all packages opportunistically
during deployment. Version/hash pinning improves repeatability; it is not a security audit,
availability guarantee, or substitute for testing the actual Linux/gVisor environment.
