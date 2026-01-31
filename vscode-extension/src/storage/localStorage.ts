import * as path from 'path';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { generateLocalSnapshot, LocalSnapshot } from './localMemory';
import { EventPayload, SnapshotListItem, StorageAdapter, StorageSession } from './types';

type SessionRecord = {
  id: string;
  root_path: string;
  project_name: string;
  started_at: string;
  ended_at?: string;
};

type SnapshotRecord = {
  id: string;
  session_id: string;
  created_at: string;
  reason?: string;
  snapshot: LocalSnapshot & { id?: string };
};

export class LocalStorageAdapter implements StorageAdapter {
  readonly mode = 'local' as const;
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  getDataDir(): string {
    return this.dataDir;
  }

  private sessionsDir(): string {
    return path.join(this.dataDir, 'sessions');
  }

  private eventsDir(): string {
    return path.join(this.dataDir, 'events');
  }

  private snapshotsDir(): string {
    return path.join(this.dataDir, 'snapshots');
  }

  private async ensureDirs() {
    await Promise.all([
      fs.mkdir(this.sessionsDir(), { recursive: true }),
      fs.mkdir(this.eventsDir(), { recursive: true }),
      fs.mkdir(this.snapshotsDir(), { recursive: true }),
      fs.mkdir(path.join(this.dataDir, 'exports'), { recursive: true })
    ]);
  }

  async startSession(rootPath: string, projectName: string): Promise<StorageSession> {
    await this.ensureDirs();
    const sessionId = randomUUID();
    const record: SessionRecord = {
      id: sessionId,
      root_path: rootPath,
      project_name: projectName,
      started_at: new Date().toISOString()
    };
    await fs.writeFile(path.join(this.sessionsDir(), `${sessionId}.json`), JSON.stringify(record, null, 2), 'utf8');
    return { sessionId, projectId: null };
  }

  async flushEvents(sessionId: string, events: EventPayload[]): Promise<void> {
    if (!events.length) {
      return;
    }
    await this.ensureDirs();
    const target = path.join(this.eventsDir(), `${sessionId}.jsonl`);
    const lines = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
    await fs.appendFile(target, lines, 'utf8');
  }

  private async readSession(sessionId: string): Promise<SessionRecord | null> {
    try {
      const raw = await fs.readFile(path.join(this.sessionsDir(), `${sessionId}.json`), 'utf8');
      return JSON.parse(raw) as SessionRecord;
    } catch {
      return null;
    }
  }

  private async readEvents(sessionId: string): Promise<EventPayload[]> {
    const target = path.join(this.eventsDir(), `${sessionId}.jsonl`);
    try {
      const raw = await fs.readFile(target, 'utf8');
      return raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as EventPayload);
    } catch {
      return [];
    }
  }

  private async readLatestSnapshot(): Promise<SnapshotRecord | null> {
    try {
      const entries = await fs.readdir(this.snapshotsDir());
      const jsonFiles = entries.filter((name) => name.endsWith('.json'));
      if (!jsonFiles.length) {
        return null;
      }
      const records = await Promise.all(
        jsonFiles.map(async (name) => {
          const raw = await fs.readFile(path.join(this.snapshotsDir(), name), 'utf8');
          return JSON.parse(raw) as SnapshotRecord;
        })
      );
      records.sort((a, b) => b.created_at.localeCompare(a.created_at));
      return records[0];
    } catch {
      return null;
    }
  }

  private async writeSnapshot(sessionId: string, reason?: string): Promise<SnapshotRecord> {
    await this.ensureDirs();
    const session = (await this.readSession(sessionId)) ?? {
      id: sessionId,
      root_path: '',
      project_name: '',
      started_at: new Date().toISOString()
    };
    const events = await this.readEvents(sessionId);
    const lastSnapshot = await this.readLatestSnapshot();
    const snapshot = generateLocalSnapshot(session, events as any, lastSnapshot?.snapshot);
    const snapshotId = randomUUID();
    const record: SnapshotRecord = {
      id: snapshotId,
      session_id: sessionId,
      created_at: new Date().toISOString(),
      reason,
      snapshot: { ...snapshot, id: snapshotId }
    };
    await fs.writeFile(path.join(this.snapshotsDir(), `${snapshotId}.json`), JSON.stringify(record, null, 2), 'utf8');
    return record;
  }

  async endSession(sessionId: string): Promise<Record<string, unknown>> {
    await this.ensureDirs();
    const session = await this.readSession(sessionId);
    if (session) {
      session.ended_at = new Date().toISOString();
      await fs.writeFile(path.join(this.sessionsDir(), `${sessionId}.json`), JSON.stringify(session, null, 2), 'utf8');
    }
    const record = await this.writeSnapshot(sessionId, 'end');
    return record.snapshot;
  }

  async createCheckpoint(sessionId: string, reason: string): Promise<Record<string, unknown>> {
    const record = await this.writeSnapshot(sessionId, reason);
    return record.snapshot;
  }

  async fetchLatestSnapshot(_rootPath: string): Promise<Record<string, unknown> | null> {
    const record = await this.readLatestSnapshot();
    return record ? record.snapshot : null;
  }

  async listSnapshots(_rootPath: string, limit: number): Promise<SnapshotListItem[]> {
    try {
      const entries = await fs.readdir(this.snapshotsDir());
      const jsonFiles = entries.filter((name) => name.endsWith('.json'));
      const records = await Promise.all(
        jsonFiles.map(async (name) => {
          const raw = await fs.readFile(path.join(this.snapshotsDir(), name), 'utf8');
          return JSON.parse(raw) as SnapshotRecord;
        })
      );
      records.sort((a, b) => b.created_at.localeCompare(a.created_at));
      return records.slice(0, limit).map((record) => ({
        id: record.id,
        session_id: record.session_id,
        created_at: record.created_at,
        current_goal: record.snapshot.current_goal ?? null,
        summary_text: record.snapshot.summary_text ?? null
      }));
    } catch {
      return [];
    }
  }

  async getSnapshot(snapshotId: string): Promise<Record<string, unknown>> {
    const raw = await fs.readFile(path.join(this.snapshotsDir(), `${snapshotId}.json`), 'utf8');
    const record = JSON.parse(raw) as SnapshotRecord;
    return record.snapshot;
  }

  async updateSnapshot(snapshotId: string, snapshot: Record<string, unknown>): Promise<void> {
    const target = path.join(this.snapshotsDir(), `${snapshotId}.json`);
    const raw = await fs.readFile(target, 'utf8');
    const record = JSON.parse(raw) as SnapshotRecord;
    record.snapshot = { ...(record.snapshot as any), ...(snapshot as any), id: snapshotId } as LocalSnapshot & { id?: string };
    await fs.writeFile(target, JSON.stringify(record, null, 2), 'utf8');
  }
}
