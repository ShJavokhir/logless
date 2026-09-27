"""The published workspace for this deployment: its name, description and the assistant's
intended uses (which drive the "Surprising" flag)."""
from __future__ import annotations

WORKSPACE_NAME = "WildChat · public research sample"
WORKSPACE_DESCRIPTION = (
    "A free public chatbot (GPT-3.5 / GPT-4) whose users consented to research release of their conversations; "
    "a 5,000-conversation sample from April–May 2023."
)

# What a general writing / coding / Q&A assistant is designed for. A leaf that is "not covered"
# by this list is a candidate "surprising" workflow.
INTENDED_USES = [
    "Answering factual and everyday questions",
    "Writing, rewriting and editing text such as emails, essays and documents",
    "Programming help: writing, explaining and debugging code",
    "Translating text between languages",
    "Explaining concepts and helping people learn a subject",
]

SURPRISING_THRESHOLD = 0.6

SAMPLE_NOTE = (
    "Seeded uniform sample of {real:,} conversations from shard 0 of WildChat-1M ({shard_rows:,} conversations), "
    "plus {canary} planted canary and {injection} injection-bait fixtures used to test the privacy gate. "
    "\"People\" are distinct hashed IP addresses, so shared or changing addresses make them approximate."
)
SHARD_ROWS = 59857
