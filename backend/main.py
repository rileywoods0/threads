"""FastAPI entrypoint for the Threads prototype."""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import settings
from .memory import generate_memory_snapshot
from .schemas import (
    EventsBatchRequest,
    LatestSnapshotResponse,
    MemorySnapshotResponse,
    SessionEndRequest,
    SessionStartRequest,
    SessionStartResponse,
)
from .supabase_client import supabase

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("threads")

app = FastAPI(title="Threads Memory Backend", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _get_project_by_root(root_path: str) -> Optional[Dict[str, Any]]:
    response = supabase.table("projects").select("*").eq("root_path", root_path).execute()
    if getattr(response, "error", None):
        logger.error("Supabase error fetching project: %s", response.error)
    data = response.data or []
    return data[0] if data else None


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/session/start", response_model=SessionStartResponse)
def start_session(payload: SessionStartRequest):
    project_data = {
        "root_path": payload.root_path,
        "name": payload.project_name,
        "updated_at": _now().isoformat(),
    }

    project_response = supabase.table("projects").upsert(project_data, on_conflict="root_path").execute()
    if getattr(project_response, "error", None):
        logger.error("Supabase error upserting project: %s", project_response.error)
        raise HTTPException(status_code=500, detail="Unable to upsert project")

    project = _get_project_by_root(payload.root_path)
    if not project:
        raise HTTPException(status_code=500, detail="Unable to upsert project")

    project_id = project["id"]

    session_response = supabase.table("sessions").insert({"project_id": project_id, "started_at": _now().isoformat()}).execute()
    if getattr(session_response, "error", None):
        logger.error("Supabase error creating session: %s", session_response.error)
        raise HTTPException(status_code=500, detail="Unable to start session")

    session_rows = session_response.data or []
    if not session_rows:
        raise HTTPException(status_code=500, detail="Unable to start session")

    session_id = session_rows[0]["id"]
    logger.info("Starting session %s for project %s", session_id, payload.root_path)

    return SessionStartResponse(session_id=session_id, project_id=project_id)


@app.post("/events")
def record_events(payload: EventsBatchRequest):
    if not payload.events:
        return {"status": "no_events"}

    records = []
    for event in payload.events:
        timestamp = event.timestamp or _now()
        records.append(
            {
                "session_id": payload.session_id,
                "event_type": event.event_type,
                "timestamp": timestamp.isoformat() if isinstance(timestamp, datetime) else str(timestamp),
                "data": event.data,
            }
        )

    response = supabase.table("events").insert(records).execute()
    if getattr(response, "error", None):
        logger.error("Supabase error inserting events: %s", response.error)
        raise HTTPException(status_code=500, detail=str(response.error))

    logger.info("Received %d events for session %s", len(records), payload.session_id)
    return {"status": "ok", "inserted": len(records)}


@app.post("/session/end", response_model=MemorySnapshotResponse)
def end_session(payload: SessionEndRequest):
    session_id = payload.session_id

    update_response = supabase.table("sessions").update({"ended_at": _now().isoformat(), "summary_generated": True}).eq("id", session_id).execute()
    if getattr(update_response, "error", None):
        logger.error("Supabase error ending session: %s", update_response.error)
        raise HTTPException(status_code=500, detail="Failed to end session")

    # Re-fetch the session to ensure we have the latest data with ended_at set.
    session_lookup = supabase.table("sessions").select("*").eq("id", session_id).execute()
    if getattr(session_lookup, "error", None):
        logger.error("Supabase error fetching session after end: %s", session_lookup.error)
        raise HTTPException(status_code=500, detail="Failed to fetch session")

    session_rows = session_lookup.data or []
    if not session_rows:
        raise HTTPException(status_code=404, detail="Session not found")

    session = session_rows[0]

    events_response = (
        supabase.table("events")
        .select("*")
        .eq("session_id", session_id)
        .order("timestamp")
        .execute()
    )
    if getattr(events_response, "error", None):
        logger.error("Supabase error fetching events: %s", events_response.error)
        raise HTTPException(status_code=500, detail="Failed to fetch events")
    events = events_response.data or []

    last_snapshot_response = (
        supabase.table("memory_snapshots")
        .select("*")
        .eq("project_id", session["project_id"])
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    if getattr(last_snapshot_response, "error", None):
        logger.error("Supabase error fetching last snapshot: %s", last_snapshot_response.error)
    last_snapshot = (last_snapshot_response.data or [None])[0]

    snapshot_content = generate_memory_snapshot(session, events, last_snapshot)

    snapshot_record = {
        **snapshot_content,
        "project_id": session["project_id"],
        "session_id": session_id,
        "created_at": _now().isoformat(),
    }

    insert_response = supabase.table("memory_snapshots").insert(snapshot_record).execute()
    if getattr(insert_response, "error", None):
        logger.error("Supabase error inserting snapshot: %s", insert_response.error)
        raise HTTPException(status_code=500, detail="Failed to store memory snapshot")

    snapshot_rows = insert_response.data or []
    if not snapshot_rows:
        raise HTTPException(status_code=500, detail="Failed to store memory snapshot")

    snapshot_id = snapshot_rows[0]["id"]
    logger.info("Ended session %s, created snapshot %s", session_id, snapshot_id)

    return MemorySnapshotResponse(**snapshot_rows[0])


@app.get("/project/latest_snapshot", response_model=LatestSnapshotResponse)
def latest_snapshot(root_path: str):
    project = _get_project_by_root(root_path)
    if not project:
        logger.warning("Project not found for root_path=%s", root_path)
        raise HTTPException(status_code=404, detail="Project not found")

    snapshot_response = (
        supabase.table("memory_snapshots")
        .select("*")
        .eq("project_id", project["id"])
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    if getattr(snapshot_response, "error", None):
        logger.error("Supabase error fetching latest snapshot: %s", snapshot_response.error)
        raise HTTPException(status_code=500, detail="Failed to fetch snapshot")

    snapshot = (snapshot_response.data or [None])[0]

    if not snapshot:
        return JSONResponse(
            status_code=404,
            content=LatestSnapshotResponse(project_id=project["id"], snapshot=None, message="No snapshot yet").model_dump(),
        )

    return LatestSnapshotResponse(project_id=project["id"], snapshot=MemorySnapshotResponse(**snapshot))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("backend.main:app", host=settings.API_HOST, port=settings.API_PORT, reload=True)
