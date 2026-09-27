"""GLM 5.3 on Vultr Serverless Inference (OpenAI-compatible).

Learned on 2026-09-26: strict json_schema mode is unreliable, so we use json_object mode,
put the schema in the prompt, validate, and retry with the validation error."""
from __future__ import annotations

import json
from typing import Any, Literal, TypeVar

from pydantic import BaseModel, ValidationError

from ..config import GLM, VULTR_INFERENCE_URL, settings
from .http import ProviderError, cache_get, cache_key, cache_put, post_json

Reasoning = Literal["off", "low", "medium", "high"]
T = TypeVar("T", bound=BaseModel)


class GLMOutputError(RuntimeError):
    pass


def _body(messages: list[dict], model: str, reasoning: Reasoning, temperature: float, max_tokens: int, json_mode: bool) -> dict:
    body: dict[str, Any] = {"model": model, "messages": messages, "temperature": temperature, "max_completion_tokens": max_tokens}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    if reasoning == "off":
        body["reasoning"] = {"enabled": False}
    else:
        body["reasoning_effort"] = reasoning
    return body


def chat(messages: list[dict], *, model: str = GLM, reasoning: Reasoning = "off", temperature: float = 0.2,
         max_tokens: int = 1200, json_mode: bool = False, use_cache: bool = True) -> tuple[str, dict]:
    """One chat completion. Returns (content, meta) where meta has model/usage."""
    if reasoning != "off":
        max_tokens = max(max_tokens, 4000)  # reasoning tokens count against max_tokens
    body = _body(messages, model, reasoning, temperature, max_tokens, json_mode)
    key = cache_key("glm", body)
    if use_cache and (hit := cache_get(key)) is not None:
        return hit["content"], {**hit["meta"], "cached": True}
    out = post_json("glm", f"{VULTR_INFERENCE_URL}/chat/completions", settings().vultr_inference_api_key, body)
    try:
        choice = out["choices"][0]
        content = choice["message"].get("content") or ""
    except (KeyError, IndexError) as e:
        raise ProviderError("glm", None, "malformed_response") from e
    meta = {"model": out.get("model", model), "usage": out.get("usage"), "finish_reason": choice.get("finish_reason")}
    if content and use_cache:
        cache_put(key, "glm", model, {"content": content, "meta": meta})
    return content, {**meta, "cached": False}


def _schema_text(schema: type[BaseModel] | dict) -> str:
    if isinstance(schema, dict):
        return json.dumps(schema, ensure_ascii=False)
    return json.dumps(schema.model_json_schema(), ensure_ascii=False)


def chat_json(system: str, user: str, schema: type[T], *, model: str = GLM, reasoning: Reasoning = "off",
              temperature: float = 0.2, max_tokens: int = 1200, retries: int = 2, use_cache: bool = True) -> tuple[T, dict]:
    """JSON-object completion validated against a Pydantic model, with repair retries."""
    sys_msg = system.rstrip() + "\n\nReturn exactly one JSON object matching this JSON Schema, and nothing else:\n" + _schema_text(schema)
    messages = [{"role": "system", "content": sys_msg}, {"role": "user", "content": user}]
    last_err = ""
    for attempt in range(retries + 1):
        content, meta = chat(messages, model=model, reasoning=reasoning, temperature=temperature,
                             max_tokens=max_tokens, json_mode=True, use_cache=use_cache and attempt == 0)
        try:
            parsed = schema.model_validate_json(_strip_fences(content))
            meta["attempts"] = attempt + 1
            return parsed, meta
        except ValidationError as e:
            last_err = _short_errors(e)
        except ValueError as e:
            last_err = f"invalid JSON: {e}"[:400]
        messages = messages[:2] + [
            {"role": "assistant", "content": content[:4000]},
            {"role": "user", "content": f"That output was invalid ({last_err}). Return only the corrected JSON object."},
        ]
    raise GLMOutputError(f"GLM output failed validation after {retries + 1} attempts: {last_err}")


def _strip_fences(s: str) -> str:
    s = s.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s[3:]
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3]
    return s.strip()


def _short_errors(e: ValidationError) -> str:
    parts = []
    for err in e.errors()[:5]:
        loc = ".".join(str(x) for x in err.get("loc", ()))
        parts.append(f"{loc}: {err.get('msg')}")
    return "; ".join(parts)[:600]
