"""Heuristic memory snapshot generation for Threads sessions."""

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set


def _collect_files(events: List[Dict[str, Any]]) -> List[str]:
    files: Set[str] = set()
    for event in events:
        data = event.get("data") or {}
        file_path = data.get("filePath") or data.get("file") or data.get("path")
        if file_path:
            files.add(str(file_path))
    return sorted(files)


def _event_summary(events: List[Dict[str, Any]]) -> str:
    if not events:
        return "No notable activity recorded."
    types = {}
    for event in events:
        event_type = event.get("event_type") or "unknown"
        types[event_type] = types.get(event_type, 0) + 1
    return ", ".join(f"{key}: {value}" for key, value in types.items())


def _build_summary_text(
    started_at: Optional[str], event_summary: str, files_touched: List[str]
) -> str:
    lines = [
        f"Session started at {started_at or datetime.now(timezone.utc).isoformat()}",
        f"Events observed: {event_summary}.",
    ]
    if files_touched:
        lines.append(f"Files touched: {', '.join(files_touched[:10])}.")
    lines.append("Threads recorded this state so you can quickly get back into flow.")
    return "\n".join(lines)


def generate_memory_snapshot(
    session: Dict[str, Any],
    events: List[Dict[str, Any]],
    last_snapshot: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Generate a simple heuristic summary for a session."""

    files_touched = _collect_files(events)
    event_summary = _event_summary(events)
    used_debugger = any(evt.get("event_type") in {"debug_start", "debugStart"} for evt in events)

    completed_work: List[str] = []
    if files_touched:
        completed_work.append(f"Edited or reviewed {len(files_touched)} file(s): {', '.join(files_touched[:5])}.")
    if used_debugger:
        completed_work.append("Ran the debugger during this session.")
    if events and not completed_work:
        completed_work.append(f"Captured {len(events)} IDE events including {event_summary}.")

    current_goal = None
    if last_snapshot:
        previous_steps = last_snapshot.get("next_steps") or []
        if previous_steps:
            current_goal = f"Continue: {previous_steps[0]}"
    if not current_goal:
        if files_touched:
            current_goal = f"Continue working on {', '.join(files_touched[:3])}."
        else:
            current_goal = "Ongoing development work."

    open_issues: List[str] = last_snapshot.get("open_issues") if last_snapshot else []

    next_steps: List[str] = []
    if files_touched:
        next_steps.append("Keep iterating on recently touched files.")
    next_steps.append("Consider running tests to validate recent changes.")
    if last_snapshot and last_snapshot.get("next_steps"):
        next_steps.extend(last_snapshot.get("next_steps") or [])

    decisions: List[str] = []

    summary_text = _build_summary_text(session.get("started_at"), event_summary, files_touched)

    snapshot = {
        "current_goal": current_goal,
        "completed_work": completed_work,
        "open_issues": open_issues or [],
        "next_steps": next_steps,
        "decisions": decisions,
        "summary_text": summary_text,
    }
    return snapshot
