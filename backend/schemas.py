from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class StartSessionRequest(BaseModel):
    root_path: str
    project_name: str


class StartSessionResponse(BaseModel):
    session_id: str
    project_id: str


class EventModel(BaseModel):
    event_type: str
    timestamp: datetime
    data: Dict[str, Any] = Field(default_factory=dict)


class EventsRequest(BaseModel):
    session_id: str
    events: List[EventModel]


class EndSessionRequest(BaseModel):
    session_id: str


class MemorySnapshot(BaseModel):
    id: str
    project_id: str
    session_id: str
    created_at: datetime
    current_goal: Optional[str]
    completed_work: Optional[Any]
    open_issues: Optional[Any]
    next_steps: Optional[Any]
    decisions: Optional[Any]
    summary_text: Optional[str]


class LatestSnapshotResponse(BaseModel):
    project_id: str
    snapshot: Optional[MemorySnapshot]
