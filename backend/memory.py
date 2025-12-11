from collections import Counter
from datetime import datetime
from typing import Any, Dict, List, Optional


def _collect_files(events: List[Dict[str, Any]]) -> List[str]:
    files = set()
    for event in events:
        data = event.get("data") or {}
        file_path = data.get("filePath") or data.get("file") or data.get("path")
        if file_path:
            files.add(file_path)
    return sorted(files)


def _event_summary(events: List[Dict[str, Any]]) -> str:
    counter = Counter(event.get("event_type") for event in events)
    pieces = [f"{event_type}: {count}" for event_type, count in counter.items() if event_type]
    return ", ".join(pieces) if pieces else "No notable activity recorded."


def generate_memory_snapshot(
    session: Dict[str, Any],
    events: List[Dict[str, Any]],
    last_snapshot: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    files_touched = _collect_files(events)
    event_summary = _event_summary(events)

    completed_work = []
    decisions = []

    for event in events:
        event_type = event.get("event_type")
        data = event.get("data") or {}
        if event_type in {"save", "file_save"}:
            completed_work.append(f"Saved changes to {data.get('filePath') or 'a file'}")
        if event_type in {"debugStart", "debugStop"}:
            decisions.append(f"Debug session {event_type.lower()} at {data.get('name') or ''}".strip())

    if not completed_work and events:
        completed_work.append(f"Captured {len(events)} events including {event_summary}.")

    current_goal = None
    if last_snapshot:
        next_steps = last_snapshot.get("next_steps") or []
        if next_steps:
            current_goal = f"Continue: {next_steps[0]}"
    if not current_goal:
        current_goal = f"Keep progressing on project {session.get('project_id')}"

    open_issues = last_snapshot.get("open_issues") if last_snapshot else []
    next_steps = []

    if files_touched:
        next_steps.append(f"Review recent changes in: {', '.join(files_touched[:5])}")
    if last_snapshot and last_snapshot.get("next_steps"):
        next_steps.extend(last_snapshot["next_steps"])
    if not next_steps:
        next_steps.append("Plan the next task and capture it in Threads.")

    summary_lines = [
        f"Session started at {session.get('started_at', datetime.utcnow())}.",
        f"Events observed: {event_summary}.",
    ]
    if files_touched:
        summary_lines.append(f"Files touched: {', '.join(files_touched)}.")

    snapshot = {
        "current_goal": current_goal,
        "completed_work": completed_work,
        "open_issues": open_issues,
        "next_steps": next_steps,
        "decisions": decisions,
        "summary_text": " \n".join(summary_lines),
    }
    return snapshot
