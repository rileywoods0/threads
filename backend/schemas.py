"""Pydantic models for request and response payloads."""

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class SessionStartRequest(BaseModel):
    root_path: str
    project_name: Optional[str] = None


class SessionStartResponse(BaseModel):
    session_id: str
    project_id: str


class EventPayload(BaseModel):
    event_type: str
    timestamp: Optional[datetime] = None
    data: Dict[str, Any] = Field(default_factory=dict)


class EventsBatchRequest(BaseModel):
    session_id: str
    events: List[EventPayload]


class SessionEndRequest(BaseModel):
    session_id: str


class MemorySnapshotResponse(BaseModel):
    id: Optional[str] = None
    project_id: str
    session_id: str
    created_at: datetime
    current_goal: Optional[str]
    completed_work: List[str]
    open_issues: List[str]
    next_steps: List[str]
    decisions: List[str]
    summary_text: Optional[str]


class LatestSnapshotResponse(BaseModel):
    project_id: str
    snapshot: Optional[MemorySnapshotResponse] = None
    message: Optional[str] = None
