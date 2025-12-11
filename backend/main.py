from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from backend.config import settings
from backend.memory import generate_memory_snapshot
from backend.schemas import (
    EndSessionRequest,
    EventsRequest,
    LatestSnapshotResponse,
    StartSessionRequest,
    StartSessionResponse,
)
from backend.supabase_client import supabase


app = FastAPI(title="Threads Memory Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_project_by_root(root_path: str) -> Optional[Dict[str, Any]]:
    response = supabase.table("projects").select("*").eq("root_path", root_path).execute()
    data = response.data or []
    return data[0] if data else None


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/session/start", response_model=StartSessionResponse)
def start_session(payload: StartSessionRequest):
    project_data = {
        "root_path": payload.root_path,
        "name": payload.project_name,
        "updated_at": _now(),
    }

    project_response = (
        supabase.table("projects")
        .upsert(project_data, on_conflict="root_path")
        .select("id")
        .execute()
    )
    project_rows = project_response.data or []
    if not project_rows:
        raise HTTPException(status_code=500, detail="Unable to upsert project")

    project_id = project_rows[0]["id"]

    session_response = (
        supabase.table("sessions")
        .insert({"project_id": project_id, "started_at": _now()})
        .select("id, project_id, started_at")
        .execute()
    )
    session_rows = session_response.data or []
    if not session_rows:
        raise HTTPException(status_code=500, detail="Unable to start session")

    session_id = session_rows[0]["id"]

    return StartSessionResponse(session_id=session_id, project_id=project_id)


@app.post("/events")
def record_events(payload: EventsRequest):
    if not payload.events:
        return {"status": "no_events"}

    records = [
        {
            "session_id": payload.session_id,
            "event_type": event.event_type,
            "timestamp": event.timestamp,
            "data": event.data,
        }
        for event in payload.events
    ]
    response = supabase.table("events").insert(records).execute()
    if response.error:
        raise HTTPException(status_code=500, detail=str(response.error))
    return {"status": "ok", "inserted": len(records)}


@app.post("/session/end")
def end_session(payload: EndSessionRequest):
    session_id = payload.session_id

    update_response = (
        supabase.table("sessions")
        .update({"ended_at": _now()})
        .eq("id", session_id)
        .select("*")
        .execute()
    )
    session_rows = update_response.data or []
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
    events = events_response.data or []

    last_snapshot_response = (
        supabase.table("memory_snapshots")
        .select("*")
        .eq("project_id", session["project_id"])
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    last_snapshot = (last_snapshot_response.data or [None])[0]

    snapshot_content = generate_memory_snapshot(session, events, last_snapshot)

    snapshot_record = {
        **snapshot_content,
        "project_id": session["project_id"],
        "session_id": session_id,
        "created_at": _now(),
    }

    insert_response = (
        supabase.table("memory_snapshots")
        .insert(snapshot_record)
        .select("*")
        .execute()
    )
    snapshot_rows = insert_response.data or []
    if not snapshot_rows:
        raise HTTPException(status_code=500, detail="Failed to store memory snapshot")

    supabase.table("sessions").update({"summary_generated": True}).eq("id", session_id).execute()

    return snapshot_rows[0]


@app.get("/project/latest_snapshot", response_model=LatestSnapshotResponse)
def latest_snapshot(root_path: str):
    project = _get_project_by_root(root_path)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    snapshot_response = (
        supabase.table("memory_snapshots")
        .select("*")
        .eq("project_id", project["id"])
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    snapshot = (snapshot_response.data or [None])[0]

    return LatestSnapshotResponse(project_id=project["id"], snapshot=snapshot)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.api_host, port=settings.api_port)
