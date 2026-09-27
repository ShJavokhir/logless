from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

SIGNALS = ("correction", "complaint", "unresolved_action_error")
QV = "synthetic-reduce-v2"
MAP_VERSION = "synthetic-map-v2"

class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")

class Message(Strict):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=12000)

class ToolEvent(Strict):
    action: str
    status: Literal["success", "error"]
    detail: str
    resolved: bool

class Conversation(Strict):
    id: str = Field(pattern=r"^c_[a-f0-9]{12}$")
    user_id: str = Field(pattern=r"^u_[a-f0-9]{10}$")
    timestamp: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    messages: list[Message]
    tool_events: list[ToolEvent]

class Facet(Strict):
    index: int
    goal: str = Field(min_length=1, max_length=400)
    outcome: str = Field(min_length=1, max_length=650)
    evidence: str = Field(min_length=1, max_length=900)

class FacetBatch(Strict):
    interactions: list[Facet]

class Leaf(Strict):
    name: str = Field(min_length=1, max_length=100)
    short_name: str = Field(min_length=1, max_length=24)
    definition: str = Field(min_length=1, max_length=500)
    includes: list[str] = Field(min_length=1, max_length=5)
    excludes: list[str] = Field(min_length=1, max_length=5)

class Category(Strict):
    name: str = Field(min_length=1, max_length=100)
    leaves: list[Leaf] = Field(min_length=1, max_length=15)

class Taxonomy(Strict):
    categories: list[Category] = Field(min_length=1, max_length=6)

    @model_validator(mode="after")
    def unique(self):
        names = [leaf.name.casefold() for category in self.categories for leaf in category.leaves]
        if len(names) != len(set(names)) or len(names) > 30:
            raise ValueError("Leaf names must be unique, with at most 30 leaves")
        if len({c.name.casefold() for c in self.categories}) != len(self.categories):
            raise ValueError("Category names must be unique")
        return self
