export type EventPayload = {
  event_type: string;
  timestamp?: string;
  data: Record<string, unknown>;
};

export type SnapshotListItem = {
  id: string;
  session_id: string;
  created_at: string;
  current_goal?: string | null;
  summary_text?: string | null;
};

export type StorageSession = {
  sessionId: string;
  projectId?: string | null;
};

export interface StorageAdapter {
  readonly mode: 'local' | 'remote';
  startSession(rootPath: string, projectName: string): Promise<StorageSession>;
  flushEvents(sessionId: string, events: EventPayload[]): Promise<void>;
  endSession(sessionId: string): Promise<Record<string, unknown>>;
  createCheckpoint(sessionId: string, reason: string): Promise<Record<string, unknown>>;
  fetchLatestSnapshot(rootPath: string): Promise<Record<string, unknown> | null>;
  listSnapshots(rootPath: string, limit: number): Promise<SnapshotListItem[]>;
  getSnapshot(snapshotId: string): Promise<Record<string, unknown>>;
  updateSnapshot?(snapshotId: string, snapshot: Record<string, unknown>): Promise<void>;
  getDataDir(): string;
}
