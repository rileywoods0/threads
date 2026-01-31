import { SnapshotListItem, StorageAdapter, StorageSession, EventPayload } from './types';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`status ${response.status}`);
  }
  return (await response.json()) as T;
}

export class RemoteStorageAdapter implements StorageAdapter {
  readonly mode = 'remote' as const;
  private readonly backendUrl: string;

  constructor(backendUrl: string) {
    this.backendUrl = backendUrl;
  }

  getDataDir(): string {
    return '';
  }

  async startSession(rootPath: string, projectName: string): Promise<StorageSession> {
    const payload = await fetchJson<{ session_id: string; project_id: string }>(`${this.backendUrl}/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root_path: rootPath, project_name: projectName })
    });
    return { sessionId: payload.session_id, projectId: payload.project_id };
  }

  async flushEvents(sessionId: string, events: EventPayload[]): Promise<void> {
    if (!events.length) {
      return;
    }
    await fetchJson(`${this.backendUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, events })
    });
  }

  async endSession(sessionId: string): Promise<Record<string, unknown>> {
    return await fetchJson<Record<string, unknown>>(`${this.backendUrl}/session/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId })
    });
  }

  async createCheckpoint(sessionId: string, reason: string): Promise<Record<string, unknown>> {
    return await fetchJson<Record<string, unknown>>(`${this.backendUrl}/snapshot/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, reason })
    });
  }

  async fetchLatestSnapshot(rootPath: string): Promise<Record<string, unknown> | null> {
    const response = await fetch(`${this.backendUrl}/project/latest_snapshot?root_path=${encodeURIComponent(rootPath)}`);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
    const payload = (await response.json()) as { snapshot: Record<string, unknown> };
    return payload.snapshot;
  }

  async listSnapshots(rootPath: string, limit: number): Promise<SnapshotListItem[]> {
    const list = await fetchJson<{ snapshots: SnapshotListItem[] }>(
      `${this.backendUrl}/project/snapshots?root_path=${encodeURIComponent(rootPath)}&limit=${limit}`
    );
    return list.snapshots ?? [];
  }

  async getSnapshot(snapshotId: string): Promise<Record<string, unknown>> {
    return await fetchJson<Record<string, unknown>>(`${this.backendUrl}/snapshot/${encodeURIComponent(snapshotId)}`);
  }
}
