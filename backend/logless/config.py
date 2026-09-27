"""Settings, read once from the environment (and a local .env in development)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]

# Pinned input dataset (see docs/CONTRACTS.md §1).
DATASET_ID = "allenai/WildChat-1M"
DATASET_REVISION = "7d6490e462285cf85d91eabea0f9a954fbddcd1f"
DATASET_FILE = "data/train-00000-of-00014.parquet"
DATASET_URL = f"https://huggingface.co/datasets/{DATASET_ID}"
DATASET_ATTRIBUTION = (
    'Zhao et al., "WildChat: 1M ChatGPT Interaction Logs in the Wild", ICLR 2024 — ODC-BY 1.0'
)

# Model ids (Vultr Serverless Inference, TypeSafe, Fireworks).
GLM = "glm-5.3"
GLM_FLASH = "glm-5.3-flash"
JEV = "jev-latest"
EMBEDDING_MODEL = "fireworks/qwen3-embedding-8b"
EMBEDDING_DIMS = 1024

VULTR_INFERENCE_URL = "https://api.vultrinference.com/v1"
TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone"
FIREWORKS_URL = "https://api.fireworks.ai/inference/v1"

# Jev decisions below this top probability are stored as "unclear".
JEV_CONFIDENCE_CUTOFF = 0.65


@dataclass(frozen=True)
class Settings:
    vultr_inference_api_key: str
    typesafe_api_key: str
    fireworks_api_key: str
    pseudonym_salt: str
    runner_url: str
    runner_token: str
    data_dir: Path
    sample_size: int
    sample_seed: int
    n_canary: int = 40
    glm_concurrency: int = 16
    jev_concurrency: int = 24
    extra: dict = field(default_factory=dict)

    @property
    def private_db(self) -> Path:
        return self.data_dir / "private.db"

    @property
    def public_db(self) -> Path:
        return self.data_dir / "public.db"

    @property
    def raw_dir(self) -> Path:
        return self.data_dir / "raw"

    @property
    def artifacts_dir(self) -> Path:
        return self.data_dir / "artifacts"


@lru_cache(maxsize=1)
def settings() -> Settings:
    load_dotenv(REPO_ROOT / ".env", override=False)
    if os.environ.get("LOGLESS_ENV", "development") != "production":
        load_dotenv(REPO_ROOT / ".env.local", override=False)
    data_dir = Path(os.environ.get("LOGLESS_DATA_DIR", "./var"))
    if not data_dir.is_absolute():
        data_dir = (REPO_ROOT / data_dir).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    return Settings(
        vultr_inference_api_key=os.environ.get("VULTR_INFERENCE_API_KEY", ""),
        typesafe_api_key=os.environ.get("TYPESAFE_API_KEY", ""),
        fireworks_api_key=os.environ.get("FIREWORKS_API_KEY", ""),
        pseudonym_salt=os.environ.get("PSEUDONYM_SALT", ""),
        runner_url=os.environ.get("RUNNER_URL", "http://127.0.0.1:8787").rstrip("/"),
        runner_token=os.environ.get("RUNNER_TOKEN", ""),
        data_dir=data_dir,
        sample_size=int(os.environ.get("SAMPLE_SIZE", "5000")),
        sample_seed=int(os.environ.get("SAMPLE_SEED", "20260926")),
        n_canary=int(os.environ.get("N_CANARY", "40")),
    )
