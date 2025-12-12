"""Optional, bounded LLM helpers (disabled by default).

Design goal: never invent facts.
We only allow rewriting/formatting of a draft snapshot using a facts JSON block.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict

import httpx

from .config import settings

logger = logging.getLogger(__name__)


def _enabled() -> bool:
    return (settings.THREADS_LLM_MODE or "off").lower() in {"rewrite", "rewrite_summary"}


def maybe_rewrite_snapshot(snapshot: Dict[str, Any], facts: Dict[str, Any]) -> Dict[str, Any]:
    """Rewrite snapshot text using an LLM (if enabled).

    Returns the original snapshot on any failure.
    """

    if not _enabled():
        return snapshot
    if not settings.OPENAI_API_KEY:
        logger.warning("THREADS_LLM_MODE enabled but OPENAI_API_KEY is missing; skipping LLM.")
        return snapshot

    draft = dict(snapshot)

    system = (
        "You are a summarization function for developer activity.\n"
        "You MUST ONLY use the provided facts. Do not add any facts, file paths, commands, or claims.\n"
        "If a detail is not in the facts, omit it.\n"
        "Return strict JSON with keys: summary_text, current_goal, next_steps.\n"
        "- summary_text: 2-4 short sentences.\n"
        "- current_goal: a single sentence.\n"
        "- next_steps: an array of 3-6 concise bullets.\n"
    )

    user = {
        "facts": facts,
        "draft": {
            "current_goal": draft.get("current_goal"),
            "next_steps": draft.get("next_steps"),
            "summary_text": draft.get("summary_text"),
        },
    }

    payload = {
        "model": settings.OPENAI_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
        ],
        "temperature": 0.2,
        "max_tokens": 350,
        "response_format": {"type": "json_object"},
    }

    try:
        with httpx.Client(timeout=settings.OPENAI_TIMEOUT_S) as client:
            resp = client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {settings.OPENAI_API_KEY}"},
                json=payload,
            )
        resp.raise_for_status()
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        parsed = json.loads(content)
        if isinstance(parsed, dict):
            if isinstance(parsed.get("summary_text"), str):
                draft["summary_text"] = parsed["summary_text"]
            if isinstance(parsed.get("current_goal"), str):
                draft["current_goal"] = parsed["current_goal"]
            if isinstance(parsed.get("next_steps"), list):
                draft["next_steps"] = [str(x) for x in parsed["next_steps"] if str(x).strip()]
        return draft
    except Exception as exc:
        logger.warning("LLM rewrite failed; using heuristic snapshot. Error: %s", exc)
        return snapshot

