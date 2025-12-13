import * as path from 'path';
import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { ThreadsPanel, ThreadsSnapshot } from './panel';
import { ThreadsViewProvider } from './threadsView';

type EventPayload = {
  event_type: string;
  timestamp?: string;
  data: Record<string, unknown>;
};

type SnapshotListItem = {
  id: string;
  session_id: string;
  created_at: string;
  current_goal?: string | null;
  summary_text?: string | null;
};

let sessionId: string | null = null;
let projectId: string | null = null;
let workspaceRoot: string | null = null;
let pendingEvents: EventPayload[] = [];
let flushTimer: NodeJS.Timeout | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let summaryFilePath: string | null = null;
let outputChannel: vscode.OutputChannel | undefined;
let resumePromptShown = false;
let stateFilePath: string | null = null;
let touchedFiles = new Set<string>();
let threadsViewProvider: ThreadsViewProvider | undefined;
let selectionByFile = new Map<string, { line: number; character: number }>();
let openFilesOrdered: string[] = [];
let activeFilePath: string | null = null;
let lastActivityAtMs = Date.now();
let eventsSinceSnapshot = 0;
let meaningfulScoreSinceSnapshot = 0;
let lastFlushAtMs: number | null = null;
let lastSnapshotAtMs: number | null = null;
let lastSnapshotId: string | null = null;
let lastBackendError: string | null = null;
let checkpointTimer: NodeJS.Timeout | undefined;
let gitBranchName: string | null = null;
let gitHeadPath: string | null = null;
let lastGitHeadValue: string | null = null;
let toastStampPath: string | null = null;
let extensionContext: vscode.ExtensionContext | null = null;
let lastCheckpointReason: string | null = null;
let focusTimestamps: number[] = [];
let editEventsSinceSnapshot = 0;
let lastFrictionEmittedAtMs = 0;

function getConfig() {
  const config = vscode.workspace.getConfiguration('threads');
  const resumeModeFromSetting = config.get<string>('resumeMode');
  const resumePrompt = config.get<boolean>('resumePrompt', true);
  const resumeMode = resumeModeFromSetting ?? (resumePrompt ? 'prompt' : 'off');
  const longBreakHours = config.get<number>('resume.longBreakHours', 8);
  const minMeaningfulScore = config.get<number>('autoCheckpoint.minMeaningfulScore', 15);
  const deprecatedMinEvents = config.get<number>('autoCheckpoint.minEvents', 20);
  return {
    backendUrl: config.get<string>('backendUrl', 'http://localhost:8000'),
    flushIntervalMs: config.get<number>('eventFlushIntervalMs', 5000),
    resumeMode,
    longBreakHours,
    autoCheckpoint: {
      enabled: config.get<boolean>('autoCheckpoint.enabled', true),
      intervalMinutes: config.get<number>('autoCheckpoint.intervalMinutes', 15),
      idleMinutes: config.get<number>('autoCheckpoint.idleMinutes', 8),
      minMeaningfulScore,
      minEvents: deprecatedMinEvents,
      onShutdown: config.get<boolean>('autoCheckpoint.onShutdown', true),
      onBranchChange: config.get<boolean>('autoCheckpoint.onBranchChange', true)
    }
  };
}

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Threads');
  }
  return outputChannel;
}

function logInfo(message: string) {
  getOutputChannel().appendLine(message);
  console.log(message);
}

function logError(message: string, err?: unknown) {
  lastBackendError = `${message}${err ? `: ${String(err)}` : ''}`;
  getOutputChannel().appendLine(`${message}${err ? `: ${String(err)}` : ''}`);
  console.error(message, err);
}

function ensureStatusBarItem(context: vscode.ExtensionContext) {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = 'Threads: In session';
    statusBarItem.tooltip = 'Threads is capturing session context.';
    statusBarItem.command = 'threads.statusMenu';
    context.subscriptions.push(statusBarItem);
  }
  statusBarItem.show();
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\//g, path.sep);
}

function shouldIgnoreFile(filePath: string): boolean {
  const normalized = normalizePath(filePath).toLowerCase();
  const ignoredSegments = [
    `${path.sep}.threads${path.sep}`,
    `${path.sep}.git${path.sep}`,
    `${path.sep}node_modules${path.sep}`,
    `${path.sep}.venv${path.sep}`,
    `${path.sep}backend${path.sep}.venv${path.sep}`,
    `${path.sep}vscode-extension${path.sep}out${path.sep}`
  ];
  return ignoredSegments.some((seg) => normalized.includes(seg));
}

type EventCategory =
  | 'FOCUS'
  | 'EDIT'
  | 'NAVIGATION'
  | 'EXECUTION'
  | 'STATE_CHANGE'
  | 'FRICTION'
  | 'BOUNDARY'
  | 'INTENT';

function scoreForEvent(event_type: string, _data: Record<string, unknown>): { score: number; category: EventCategory } {
  switch (event_type) {
    case 'file_edit':
      return { score: 5, category: 'EDIT' };
    case 'file_focus':
      return { score: 1, category: 'FOCUS' };
    case 'debug_start':
      return { score: 5, category: 'EXECUTION' };
    case 'debug_end':
      return { score: 1, category: 'EXECUTION' };
    case 'task_start':
      return { score: 4, category: 'EXECUTION' };
    case 'task_end':
      return { score: 1, category: 'EXECUTION' };
    case 'branch_change':
      return { score: 6, category: 'STATE_CHANGE' };
    case 'friction_switching':
      return { score: 2, category: 'FRICTION' };
    default:
      return { score: 1, category: 'NAVIGATION' };
  }
}

function pruneOldTimestamps(timestamps: number[], windowMs: number): number[] {
  const cutoff = Date.now() - windowMs;
  return timestamps.filter((t) => t >= cutoff);
}

function queueEvent(event_type: string, data: Record<string, unknown>) {
  const filePath = data.filePath;
  if (
    (event_type === 'file_edit' || event_type === 'file_focus') &&
    typeof filePath === 'string' &&
    shouldIgnoreFile(filePath)
  ) {
    return;
  }
  if (typeof filePath === 'string' && !shouldIgnoreFile(filePath)) {
    if (event_type === 'file_edit' || event_type === 'file_focus') {
      touchedFiles.add(filePath);
    }
  }

  lastActivityAtMs = Date.now();
  eventsSinceSnapshot += 1;
  const scored = scoreForEvent(event_type, data);
  meaningfulScoreSinceSnapshot += scored.score;
  if (event_type === 'file_edit') {
    editEventsSinceSnapshot += 1;
  }

  if (event_type === 'file_focus') {
    focusTimestamps.push(Date.now());
    focusTimestamps = pruneOldTimestamps(focusTimestamps, 2 * 60_000);
    const tooMuchSwitching = focusTimestamps.length >= 14 && editEventsSinceSnapshot === 0;
    const quietWindow = Date.now() - lastFrictionEmittedAtMs > 10 * 60_000;
    if (tooMuchSwitching && quietWindow) {
      lastFrictionEmittedAtMs = Date.now();
      pendingEvents.push({
        event_type: 'friction_switching',
        timestamp: new Date().toISOString(),
        data: { focusEventsIn2Min: focusTimestamps.length }
      });
      meaningfulScoreSinceSnapshot += scoreForEvent('friction_switching', {}).score;
    }
  }

  pendingEvents.push({
    event_type,
    timestamp: new Date().toISOString(),
    data
  });
}

function startFlushTimer(intervalMs: number) {
  if (flushTimer) {
    clearInterval(flushTimer);
  }
  flushTimer = setInterval(() => {
    void flushEvents();
  }, intervalMs);
}

function getWorkspaceRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`status ${response.status}`);
  }
  return (await response.json()) as T;
}

async function startSession(context: vscode.ExtensionContext) {
  const rootPath = getWorkspaceRoot();
  if (!rootPath) {
    vscode.window.showWarningMessage('Threads: No workspace folder open.');
    return;
  }

  workspaceRoot = rootPath;
  summaryFilePath = path.join(rootPath, '.threads', 'last-session.md');
  stateFilePath = path.join(rootPath, '.threads', 'last-session-state.json');
  toastStampPath = path.join(rootPath, '.threads', 'toast-stamps.json');
  gitHeadPath = path.join(rootPath, '.git', 'HEAD');
  lastGitHeadValue = null;
  touchedFiles = new Set<string>();
  selectionByFile = new Map<string, { line: number; character: number }>();
  openFilesOrdered = [];
  activeFilePath = null;
  lastActivityAtMs = Date.now();
  eventsSinceSnapshot = 0;
  meaningfulScoreSinceSnapshot = 0;
  editEventsSinceSnapshot = 0;
  focusTimestamps = [];
  lastSnapshotAtMs = Date.now();
  lastSnapshotId = null;
  const projectName = path.basename(rootPath);
  const { backendUrl } = getConfig();

  try {
    const payload = await fetchJson<{ session_id: string; project_id: string }>(`${backendUrl}/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root_path: rootPath, project_name: projectName })
    });

    sessionId = payload.session_id;
    projectId = payload.project_id;
    context.workspaceState.update('threads.sessionId', sessionId);
    logInfo(`Threads: Started session ${sessionId} for ${rootPath}`);
    ensureStatusBarItem(context);
  } catch (err) {
    logError('Threads: Failed to start session', err);
    vscode.window.showErrorMessage('Threads failed to start session. Check backend connectivity.');
  }
}

async function flushEvents() {
  if (!sessionId || pendingEvents.length === 0) {
    return;
  }

  const { backendUrl } = getConfig();
  const eventsToSend = [...pendingEvents];
  pendingEvents = [];

  try {
    await fetchJson(`${backendUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, events: eventsToSend })
    });
    logInfo(`Threads: Flushed ${eventsToSend.length} events.`);
    lastFlushAtMs = Date.now();
  } catch (err) {
    logError('Threads: Failed to flush events', err);
    vscode.window.showErrorMessage('Threads: Failed to send events to backend.');
    pendingEvents.unshift(...eventsToSend);
  }
}

async function endSession(showNotification = false, showPanel = true): Promise<ThreadsSnapshot | null> {
  if (!sessionId) {
    return null;
  }

  const { backendUrl } = getConfig();
  await flushEvents();

  try {
    const snapshot = await fetchJson<ThreadsSnapshot>(`${backendUrl}/session/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId })
    });

    await persistLatestSnapshotMarkdown(snapshot);
    await persistSnapshotArchiveMarkdown(snapshot);
    await persistLastSessionState(snapshot);
    threadsViewProvider?.refresh();
    await refreshMomentumUI();
    if (showPanel) {
      ThreadsPanel.render(snapshot);
    }

    if (showNotification) {
      vscode.window.showInformationMessage('Threads saved your session snapshot.');
    }

    sessionId = null;
    eventsSinceSnapshot = 0;
    meaningfulScoreSinceSnapshot = 0;
    editEventsSinceSnapshot = 0;
    focusTimestamps = [];
    lastSnapshotAtMs = Date.now();
    lastSnapshotId = getSnapshotId(snapshot);
    return snapshot;
  } catch (err) {
    logError('Threads: Failed to end session', err);
    vscode.window.showErrorMessage('Threads: Failed to end session. Check backend logs for details.');
    return null;
  }
}

async function createCheckpoint(reason: string, options?: { force?: boolean }) {
  const { backendUrl, autoCheckpoint } = getConfig();
  if (!sessionId) {
    return;
  }

  const force = options?.force ?? false;
  if (!autoCheckpoint.enabled && !force) {
    return;
  }
  const scoreThreshold = autoCheckpoint.minMeaningfulScore ?? autoCheckpoint.minEvents ?? 15;
  if (!force && meaningfulScoreSinceSnapshot < scoreThreshold) {
    return;
  }

  logInfo(`Threads: Checkpoint triggered (${reason}) score=${meaningfulScoreSinceSnapshot} events=${eventsSinceSnapshot}`);
  await flushEvents();

  try {
    const snapshot = await fetchJson<ThreadsSnapshot>(`${backendUrl}/snapshot/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, reason })
    });

    await persistLatestSnapshotMarkdown(snapshot);
    await persistSnapshotArchiveMarkdown(snapshot);
    await persistLastSessionState(snapshot);
    threadsViewProvider?.refresh();
    eventsSinceSnapshot = 0;
    meaningfulScoreSinceSnapshot = 0;
    editEventsSinceSnapshot = 0;
    focusTimestamps = [];
    lastSnapshotAtMs = Date.now();
    lastSnapshotId = getSnapshotId(snapshot);
    lastCheckpointReason = reason;
    await refreshMomentumUI();
    await maybeToastOncePerDay('Threads saved a checkpoint automatically.');
    await pulseStatusBar('Threads: checkpoint saved');
  } catch (err) {
    logError('Threads: Auto-checkpoint failed', err);
  }
}

async function fetchLatestSnapshot(rootPath: string): Promise<ThreadsSnapshot | null> {
  const { backendUrl } = getConfig();
  const response = await fetch(`${backendUrl}/project/latest_snapshot?root_path=${encodeURIComponent(rootPath)}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`status ${response.status}`);
  }
  const payload = (await response.json()) as { snapshot: ThreadsSnapshot };
  return payload.snapshot;
}

async function showLatestSnapshot() {
  const rootPath = getWorkspaceRoot();
  if (!rootPath) {
    vscode.window.showWarningMessage('Threads: No workspace folder open.');
    return;
  }

  try {
    const snapshot = await fetchLatestSnapshot(rootPath);
    if (!snapshot) {
      vscode.window.showInformationMessage('Threads: No snapshot available yet.');
      return;
    }
    await persistLatestSnapshotMarkdown(snapshot);
    await persistSnapshotArchiveMarkdown(snapshot);
    await persistLastSessionState(snapshot);
    threadsViewProvider?.refresh();
    await refreshMomentumUI();
    ThreadsPanel.render(snapshot);
  } catch (err) {
    logError('Threads: Unable to load snapshot', err);
    vscode.window.showErrorMessage('Threads: Unable to load latest snapshot.');
  }
}

async function saveStateNow(context: vscode.ExtensionContext) {
  const snapshot = await endSession(true, true);
  if (!snapshot) {
    const choice = await vscode.window.showErrorMessage(
      'Threads: Failed to save this session.',
      'Retry',
      'Start New Session Anyway'
    );
    if (choice === 'Retry') {
      await saveStateNow(context);
      return;
    }
    if (choice !== 'Start New Session Anyway') {
      return;
    }
    sessionId = null;
  }

  await startSession(context);
  vscode.window.showInformationMessage('Threads: Session saved and a new one has started.');
}

type LastSessionState = {
  savedAt: string;
  snapshotId?: string;
  currentGoal?: string;
  nextSteps?: string[];
  files: string[];
  openFiles?: string[];
  activeFile?: string;
  cursors?: Record<string, { line: number; character: number }>;
};

function formatSnapshotMarkdown(snapshot: ThreadsSnapshot): string {
  const lines: string[] = [];
  lines.push('# Threads - Last Session');
  lines.push('');
  lines.push('## Current Goal');
  lines.push(snapshot.current_goal || 'Not set');
  lines.push('');

  const renderList = (title: string, items?: string[]) => {
    lines.push(`## ${title}`);
    if (items && items.length) {
      for (const item of items) {
        lines.push(`- ${item}`);
      }
    } else {
      lines.push('- None recorded.');
    }
    lines.push('');
  };

  renderList('Completed Work', snapshot.completed_work);
  renderList('Open Issues', snapshot.open_issues);
  renderList('Next Steps', snapshot.next_steps);
  renderList('Decisions', snapshot.decisions);

  lines.push('## Summary');
  lines.push(snapshot.summary_text || 'No summary.');
  lines.push('');
  lines.push('> Generated by Threads. Share this with your AI assistant to restore context.');
  return lines.join('\n');
}

function getSnapshotId(snapshot: ThreadsSnapshot): string | null {
  const anySnapshot = snapshot as unknown as { id?: unknown };
  return typeof anySnapshot.id === 'string' && anySnapshot.id.length ? anySnapshot.id : null;
}

async function listVisibleEditorFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.scheme !== 'file') {
      continue;
    }
    const filePath = editor.document.uri.fsPath;
    if (!shouldIgnoreFile(filePath)) {
      files.push(filePath);
    }
  }
  return files;
}

async function persistLastSessionState(snapshot: ThreadsSnapshot) {
  if (!workspaceRoot || !stateFilePath) {
    return;
  }

  const filesFromEditors = await listVisibleEditorFiles();
  const combined = [...new Set([...touchedFiles, ...filesFromEditors])].filter((file) => !shouldIgnoreFile(file));
  const snapshotId = getSnapshotId(snapshot) ?? undefined;

  const openFiles = openFilesOrdered.filter((f) => !shouldIgnoreFile(f));
  const cursors: Record<string, { line: number; character: number }> = {};
  for (const [file, pos] of selectionByFile.entries()) {
    if (!shouldIgnoreFile(file)) {
      cursors[file] = pos;
    }
  }

  const state: LastSessionState = {
    savedAt: new Date().toISOString(),
    snapshotId,
    currentGoal: snapshot.current_goal ?? undefined,
    nextSteps: snapshot.next_steps ?? undefined,
    files: combined.slice(0, 50),
    openFiles: openFiles.slice(0, 25),
    activeFile: activeFilePath ?? undefined,
    cursors
  };

  try {
    await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
    await fs.writeFile(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    logError('Threads: Failed to write last-session state', err);
  }
}

async function readLastSessionState(): Promise<LastSessionState | null> {
  if (!stateFilePath) {
    return null;
  }
  try {
    const raw = await fs.readFile(stateFilePath, 'utf8');
    return JSON.parse(raw) as LastSessionState;
  } catch {
    return null;
  }
}

async function writeSnapshotMarkdown(targetPath: string, snapshot: ThreadsSnapshot) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, formatSnapshotMarkdown(snapshot), 'utf8');
}

async function persistLatestSnapshotMarkdown(snapshot: ThreadsSnapshot) {
  if (!summaryFilePath) {
    return;
  }
  try {
    await writeSnapshotMarkdown(summaryFilePath, snapshot);
  } catch (err) {
    logError('Threads: Failed to write last-session markdown', err);
  }
}

async function persistSnapshotArchiveMarkdown(snapshot: ThreadsSnapshot) {
  if (!workspaceRoot) {
    return;
  }
  const snapshotId = getSnapshotId(snapshot);
  if (!snapshotId) {
    return;
  }
  const archivePath = path.join(workspaceRoot, '.threads', 'snapshots', `${snapshotId}.md`);
  try {
    await writeSnapshotMarkdown(archivePath, snapshot);
  } catch (err) {
    logError('Threads: Failed to write snapshot archive markdown', err);
  }
}

async function openOrCreateSummaryFile() {
  const rootPath = getWorkspaceRoot();
  if (!rootPath || !summaryFilePath) {
    vscode.window.showInformationMessage('Threads: No workspace folder open.');
    return;
  }

  try {
    await fs.access(summaryFilePath);
  } catch {
    try {
      const snapshot = await fetchLatestSnapshot(rootPath);
      if (!snapshot) {
        vscode.window.showInformationMessage('Threads: No snapshot available yet.');
        return;
      }
      await persistLatestSnapshotMarkdown(snapshot);
    } catch (err) {
      logError('Threads: Unable to create summary file from latest snapshot', err);
      vscode.window.showErrorMessage('Threads: Unable to create summary file. Is the backend running?');
      return;
    }
  }

  try {
    const doc = await vscode.workspace.openTextDocument(summaryFilePath);
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch (err) {
    logError('Threads: Unable to open summary file', err);
    vscode.window.showErrorMessage('Threads: Unable to open summary file.');
  }
}

async function maybeShowResumePrompt() {
  const { resumeMode, longBreakHours } = getConfig();
  if (resumeMode === 'off' || resumePromptShown) {
    return;
  }
  resumePromptShown = true;

  const state = await readLastSessionState();
  if (state?.savedAt) {
    const ts = Date.parse(state.savedAt);
    if (!Number.isNaN(ts)) {
      const hours = (Date.now() - ts) / 3_600_000;
      if (hours >= longBreakHours) {
        const choice = await vscode.window.showInformationMessage(
          'Resume where you left off?',
          'Resume',
          'Later'
        );
        if (choice === 'Resume') {
          await resumeWhereILeftOff();
        }
        return;
      }
    }
  }

  if (resumeMode === 'quiet') {
    return;
  }

  const rootPath = getWorkspaceRoot();
  if (!rootPath) {
    return;
  }

  try {
    const snapshot = await fetchLatestSnapshot(rootPath);
    if (!snapshot) {
      return;
    }

    const goal = (snapshot.current_goal || '').trim();
    const message = goal ? `Resume: ${goal}` : 'Resume: open your last Threads snapshot';
    const choice = await vscode.window.showInformationMessage(
      message,
      'Reopen Files',
      'Open Snapshot',
      'Open Summary Markdown'
    );
    if (choice === 'Reopen Files') {
      await resumeWhereILeftOff();
    } else if (choice === 'Open Snapshot') {
      await showLatestSnapshot();
    } else if (choice === 'Open Summary Markdown') {
      await openOrCreateSummaryFile();
    }
  } catch (err) {
    logError('Threads: Resume prompt failed', err);
  }
}

async function browseSnapshots() {
  const rootPath = getWorkspaceRoot();
  if (!rootPath) {
    vscode.window.showWarningMessage('Threads: No workspace folder open.');
    return;
  }

  const { backendUrl } = getConfig();
  try {
    const list = await fetchJson<{ snapshots: SnapshotListItem[] }>(
      `${backendUrl}/project/snapshots?root_path=${encodeURIComponent(rootPath)}&limit=30`
    );
    if (!list.snapshots.length) {
      vscode.window.showInformationMessage('Threads: No snapshots available yet.');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      list.snapshots.map((s) => {
        const when = new Date(s.created_at).toLocaleString();
        const goal = (s.current_goal || '').trim();
        const summary = (s.summary_text || '').trim();
        const hint = goal || summary || s.session_id;
        return {
          label: when,
          description: hint.length > 80 ? `${hint.slice(0, 77)}...` : hint,
          detail: summary || goal || '',
          snapshotId: s.id
        };
      }),
      { title: 'Threads: Browse snapshots', matchOnDescription: true, matchOnDetail: true }
    );
    if (!picked) {
      return;
    }

    const snapshot = await fetchJson<ThreadsSnapshot>(`${backendUrl}/snapshot/${encodeURIComponent(picked.snapshotId)}`);
    const archivePath = path.join(rootPath, '.threads', 'snapshots', `${picked.snapshotId}.md`);
    try {
      await writeSnapshotMarkdown(archivePath, snapshot);
    } catch (err) {
      logError('Threads: Failed to write snapshot markdown archive', err);
    }

    const choice = await vscode.window.showQuickPick(['Open Snapshot Panel', 'Open Markdown'], {
      title: 'Open snapshot',
      placeHolder: 'Choose how to view this snapshot'
    });
    if (choice === 'Open Markdown') {
      const doc = await vscode.workspace.openTextDocument(archivePath);
      await vscode.window.showTextDocument(doc, { preview: false });
      return;
    }

    ThreadsPanel.render(snapshot);
  } catch (err) {
    logError('Threads: Unable to browse snapshots', err);
    vscode.window.showErrorMessage('Threads: Unable to browse snapshots. Is the backend running?');
  }
}

async function checkBackendHealth() {
  const { backendUrl } = getConfig();
  try {
    const payload = await fetchJson<{ status: string }>(`${backendUrl}/health`);
    vscode.window.showInformationMessage(`Threads backend: ${payload.status}`);
  } catch (err) {
    logError('Threads: Backend health check failed', err);
    vscode.window.showErrorMessage('Threads: Backend health check failed.');
  }
}

async function exportContextBundle() {
  const rootPath = getWorkspaceRoot();
  if (!rootPath) {
    vscode.window.showWarningMessage('Threads: No workspace folder open.');
    return;
  }

  const { backendUrl } = getConfig();
  const bundlePath = path.join(rootPath, '.threads', 'context-bundle.md');

  let lastSessionMarkdown = '';
  if (summaryFilePath) {
    try {
      lastSessionMarkdown = await fs.readFile(summaryFilePath, 'utf8');
    } catch {
      lastSessionMarkdown = '';
    }
  }

  if (!lastSessionMarkdown) {
    try {
      const snapshot = await fetchLatestSnapshot(rootPath);
      if (snapshot) {
        lastSessionMarkdown = formatSnapshotMarkdown(snapshot);
      }
    } catch (err) {
      logError('Threads: Unable to fetch latest snapshot for context bundle', err);
    }
  }

  let snapshots: SnapshotListItem[] = [];
  try {
    const list = await fetchJson<{ snapshots: SnapshotListItem[] }>(
      `${backendUrl}/project/snapshots?root_path=${encodeURIComponent(rootPath)}&limit=10`
    );
    snapshots = list.snapshots;
  } catch (err) {
    logError('Threads: Unable to fetch snapshot list for context bundle', err);
  }

  const state = await readLastSessionState();
  const files = state?.files ?? [];
  const goal = (state?.currentGoal || '').trim();
  const nextSteps = state?.nextSteps ?? [];

  const shortForAgent: string[] = [];
  shortForAgent.push('# Threads - Context (Short)');
  shortForAgent.push('');
  if (goal) {
    shortForAgent.push(`Goal: ${goal}`);
  }
  if (files.length) {
    shortForAgent.push(`Files: ${files.slice(0, 8).join(', ')}`);
  }
  if (nextSteps.length) {
    shortForAgent.push('Next steps:');
    for (const step of nextSteps.slice(0, 6)) {
      shortForAgent.push(`- ${step}`);
    }
  }
  shortForAgent.push('');
  shortForAgent.push('Last session summary:');
  shortForAgent.push((lastSessionMarkdown.match(/## Summary[\s\S]*$/)?.[0] ?? '').trim() || '(none)');

  const fullMarkdown: string[] = [];
  fullMarkdown.push('# Threads - Context Bundle');
  fullMarkdown.push('');
  fullMarkdown.push(`Workspace: ${rootPath}`);
  fullMarkdown.push(`Generated: ${new Date().toISOString()}`);
  fullMarkdown.push('');
  fullMarkdown.push('## Recent Snapshots (history)');
  if (!snapshots.length) {
    fullMarkdown.push('- None found.');
  } else {
    for (const s of snapshots) {
      const when = new Date(s.created_at).toLocaleString();
      const hint = (s.current_goal || s.summary_text || '').toString().trim();
      fullMarkdown.push(`- ${when} - ${hint || s.id}`);
    }
  }
  fullMarkdown.push('');
  fullMarkdown.push('## Last Session (full)');
  fullMarkdown.push(lastSessionMarkdown || '_No last-session markdown available yet._');
  fullMarkdown.push('');
  fullMarkdown.push(
    '> Tip: paste this file into Copilot Chat / Claude / ChatGPT when returning to the project to restore context quickly.'
  );

  const agentPrompt: string[] = [];
  agentPrompt.push('You are a coding assistant helping me resume work.');
  agentPrompt.push('Use only the context below. If anything is missing, ask concise clarifying questions.');
  agentPrompt.push('Return: (1) a 1-sentence restatement of goal, (2) top 3 next steps, (3) risks/unknowns.');
  agentPrompt.push('');
  agentPrompt.push('---');
  agentPrompt.push(shortForAgent.join('\n'));
  agentPrompt.push('---');

  const mode = await vscode.window.showQuickPick(
    [
      { label: 'Markdown file (Full)', description: 'Writes .threads/context-bundle.md and opens it', mode: 'file' },
      { label: 'Copy for agent (Short)', description: 'Copies a compact context to clipboard', mode: 'short' },
      { label: 'Copy agent prompt (Opt-in)', description: 'Copies a ready-to-paste prompt + context', mode: 'prompt' }
    ],
    { title: 'Threads: Export context bundle' }
  );
  if (!mode) {
    return;
  }

  try {
    if (mode.mode === 'file') {
      await fs.mkdir(path.dirname(bundlePath), { recursive: true });
      await fs.writeFile(bundlePath, fullMarkdown.join('\n'), 'utf8');
      const doc = await vscode.workspace.openTextDocument(bundlePath);
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.showInformationMessage('Threads: Context bundle exported.');
      return;
    }
    if (mode.mode === 'short') {
      await vscode.env.clipboard.writeText(shortForAgent.join('\n'));
      vscode.window.showInformationMessage('Threads: Context copied to clipboard.');
      return;
    }
    await vscode.env.clipboard.writeText(agentPrompt.join('\n'));
    vscode.window.showInformationMessage('Threads: Agent prompt copied to clipboard.');
  } catch (err) {
    logError('Threads: Failed to write context bundle markdown', err);
    vscode.window.showErrorMessage('Threads: Failed to export context bundle.');
  }
}

async function refreshMomentumUI() {
  if (!statusBarItem) {
    return;
  }

  const { autoCheckpoint } = getConfig();
  const state = await readLastSessionState();
  const fileCount = state?.files?.length ?? 0;
  const goal = (state?.currentGoal || '').trim();
  const nextStep = (state?.nextSteps?.[0] || '').trim();

  if (!lastSnapshotAtMs && state?.savedAt) {
    const ts = Date.parse(state.savedAt);
    if (!Number.isNaN(ts)) {
      lastSnapshotAtMs = ts;
    }
  }
  const last = lastSnapshotAtMs ? new Date(lastSnapshotAtMs).toLocaleTimeString() : null;
  const scoreThreshold = autoCheckpoint.minMeaningfulScore ?? autoCheckpoint.minEvents ?? 15;
  const checkpointReady = autoCheckpoint.enabled && meaningfulScoreSinceSnapshot >= scoreThreshold;
  statusBarItem.text = checkpointReady ? 'Threads: In session*' : 'Threads: In session';
  const lines: string[] = [];
  lines.push(statusBarItem.text);
  if (last) {
    lines.push(`Last checkpoint: ${last}${lastCheckpointReason ? ` (${lastCheckpointReason})` : ''}`);
  }
  if (fileCount) {
    lines.push(`Last session files: ${fileCount}`);
  }
  lines.push(`Since checkpoint: ${meaningfulScoreSinceSnapshot} score | ${eventsSinceSnapshot} events`);
  if (checkpointReady) {
    lines.push('Checkpoint ready: yes');
  }
  if (goal) {
    lines.push(`Goal: ${goal}`);
  }
  if (nextStep) {
    lines.push(`Next: ${nextStep}`);
  }
  statusBarItem.tooltip = lines.join('\n');
}

async function resumeWhereILeftOff() {
  const rootPath = getWorkspaceRoot();
  if (!rootPath) {
    vscode.window.showWarningMessage('Threads: No workspace folder open.');
    return;
  }

  const state = await readLastSessionState();
  const fileCount = state?.files?.length ?? 0;

  const choice = await vscode.window.showQuickPick(
    [
      {
        label: fileCount ? `Reopen files (${fileCount})` : 'Reopen files',
        action: 'reopen'
      },
      { label: 'Open snapshot panel', action: 'panel' },
      { label: 'Open last summary markdown', action: 'summary' },
      { label: 'Export context bundle', action: 'bundle' }
    ],
    { title: 'Threads: Resume' }
  );

  if (!choice) {
    return;
  }

  if (choice.action === 'panel') {
    await showLatestSnapshot();
    return;
  }
  if (choice.action === 'summary') {
    await openOrCreateSummaryFile();
    return;
  }
  if (choice.action === 'bundle') {
    await exportContextBundle();
    return;
  }

  const openFiles = state?.openFiles?.length ? state.openFiles : state?.files ?? [];
  if (!openFiles.length) {
    vscode.window.showInformationMessage('Threads: No recent files recorded yet. Save a session first.');
    return;
  }

  const existing: string[] = [];
  for (const file of openFiles) {
    try {
      await fs.access(file);
      existing.push(file);
    } catch {
      // ignore missing file
    }
  }

  if (!existing.length) {
    vscode.window.showInformationMessage('Threads: Previously touched files are no longer present.');
    return;
  }

  const openAll = existing.length <= 8;
  const confirm = openAll
    ? 'Open'
    : await vscode.window.showInformationMessage(
        `Open the last ${Math.min(8, existing.length)} files?`,
        'Open',
        'Choose files'
      );
  if (confirm !== 'Open' && confirm !== 'Choose files') {
    return;
  }

  let toOpen = existing.slice(0, 8);
  if (confirm === 'Choose files') {
    const picked = await vscode.window.showQuickPick(
      existing.map((file) => ({ label: path.basename(file), description: file, file })),
      { canPickMany: true, title: 'Choose files to reopen' }
    );
    if (!picked || picked.length === 0) {
      return;
    }
    toOpen = picked.map((p) => p.file);
  }

  for (let index = 0; index < toOpen.length; index++) {
    const file = toOpen[index];
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: index !== 0 });
    const cursor = state?.cursors?.[file];
    if (cursor) {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.fsPath === file) {
        const pos = new vscode.Position(cursor.line, cursor.character);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos));
      }
    }
  }

  if (state?.activeFile) {
    const active = state.activeFile;
    if (existing.includes(active)) {
      const doc = await vscode.workspace.openTextDocument(active);
      await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    }
  }
}

async function showStatusMenu() {
  const state = await readLastSessionState();
  const filesTouched = state?.files?.length ?? 0;
  const last = lastSnapshotAtMs ? new Date(lastSnapshotAtMs).toLocaleTimeString() : null;
  const subtitle = `${filesTouched} files${last ? ` | last checkpoint ${last}` : ''}`;

  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Resume workspace', description: subtitle, action: 'resume' },
      { label: 'Show last session', description: 'Opens the snapshot panel', action: 'show' },
      { label: 'Save checkpoint', description: 'Saves a snapshot without ending the session', action: 'checkpoint' },
      { label: 'Save state now', description: 'Ends session + starts new', action: 'save' },
      { label: 'Browse snapshots', description: 'Pick from history', action: 'browse' },
      { label: 'Export context bundle', description: 'Full file / copy / agent prompt', action: 'export' },
      { label: 'Diagnostics', description: 'Shows runtime state', action: 'diag' },
      { label: 'Show output log', description: 'Threads output channel', action: 'out' }
    ],
    { title: 'Threads', placeHolder: 'Choose an action' }
  );
  if (!pick) {
    return;
  }
  if (pick.action === 'resume') {
    await resumeWhereILeftOff();
  } else if (pick.action === 'show') {
    await showLatestSnapshot();
  } else if (pick.action === 'checkpoint') {
    await createCheckpoint('manual', { force: true });
  } else if (pick.action === 'save') {
    if (extensionContext) {
      await saveStateNow(extensionContext);
    } else {
      vscode.window.showErrorMessage('Threads: Extension context not ready.');
    }
  } else if (pick.action === 'browse') {
    await browseSnapshots();
  } else if (pick.action === 'export') {
    await exportContextBundle();
  } else if (pick.action === 'diag') {
    await showDiagnostics();
  } else if (pick.action === 'out') {
    getOutputChannel().show(true);
  }
}

async function showDiagnostics() {
  const { backendUrl, autoCheckpoint } = getConfig();
  const lines: string[] = [];
  lines.push('# Threads Diagnostics');
  lines.push('');
  lines.push(`Backend URL: \`${backendUrl}\``);
  lines.push(`Session ID: \`${sessionId ?? '(none)'}\``);
  lines.push(`Pending events: \`${pendingEvents.length}\``);
  lines.push(`Events since checkpoint: \`${eventsSinceSnapshot}\``);
  lines.push(`Meaningful score since checkpoint: \`${meaningfulScoreSinceSnapshot}\``);
  lines.push(`Last activity: \`${new Date(lastActivityAtMs).toLocaleString()}\``);
  lines.push(`Last flush: \`${lastFlushAtMs ? new Date(lastFlushAtMs).toLocaleString() : '(none)'}\``);
  lines.push(`Last snapshot time: \`${lastSnapshotAtMs ? new Date(lastSnapshotAtMs).toLocaleString() : '(none)'}\``);
  lines.push(`Last snapshot id: \`${lastSnapshotId ?? '(none)'}\``);
  lines.push(`Last checkpoint reason: \`${lastCheckpointReason ?? '(none)'}\``);
  lines.push(`Last backend error: \`${lastBackendError ?? '(none)'}\``);
  lines.push('');
  lines.push('## Auto-checkpoint settings');
  lines.push('```json');
  lines.push(JSON.stringify(autoCheckpoint, null, 2));
  lines.push('```');

  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: lines.join('\n')
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function pulseStatusBar(message: string) {
  if (!statusBarItem) {
    return;
  }
  const originalText = statusBarItem.text;
  statusBarItem.text = message;
  setTimeout(() => {
    if (statusBarItem) {
      statusBarItem.text = originalText;
    }
  }, 2500);
}

async function maybeToastOncePerDay(message: string) {
  if (!toastStampPath) {
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  try {
    let stamps: Record<string, string> = {};
    try {
      stamps = JSON.parse(await fs.readFile(toastStampPath, 'utf8')) as Record<string, string>;
    } catch {
      stamps = {};
    }
    const lastShown = stamps['autoCheckpointToast'];
    if (lastShown === today) {
      return;
    }
    stamps['autoCheckpointToast'] = today;
    await fs.mkdir(path.dirname(toastStampPath), { recursive: true });
    await fs.writeFile(toastStampPath, JSON.stringify(stamps, null, 2), 'utf8');
    void vscode.window.showInformationMessage(message);
  } catch (err) {
    logError('Threads: Failed to persist toast stamp', err);
  }
}

function startCheckpointTimer() {
  const { autoCheckpoint } = getConfig();
  if (!autoCheckpoint.enabled) {
    return;
  }
  if (checkpointTimer) {
    clearInterval(checkpointTimer);
  }
  checkpointTimer = setInterval(() => {
    void checkpointTick();
  }, 60_000);
}

async function checkpointTick() {
  const { autoCheckpoint } = getConfig();
  if (!autoCheckpoint.enabled || !sessionId) {
    return;
  }
  const now = Date.now();
  const intervalMs = autoCheckpoint.intervalMinutes * 60_000;
  const idleMs = autoCheckpoint.idleMinutes * 60_000;

  if (autoCheckpoint.onBranchChange) {
    await checkGitHeadFallback();
  }

  if (intervalMs > 0 && lastSnapshotAtMs && now - lastSnapshotAtMs >= intervalMs) {
    await createCheckpoint('interval');
    return;
  }

  if (idleMs > 0 && now - lastActivityAtMs >= idleMs) {
    await createCheckpoint('idle');
  }
}

function parseBranchFromHead(headValue: string): string | null {
  const trimmed = headValue.trim();
  if (trimmed.startsWith('ref:')) {
    const ref = trimmed.replace(/^ref:\s*/, '').trim();
    const parts = ref.split('/');
    return parts[parts.length - 1] || ref;
  }
  return 'detached';
}

async function checkGitHeadFallback() {
  if (!gitHeadPath) {
    return;
  }
  try {
    const current = await fs.readFile(gitHeadPath, 'utf8');
    if (lastGitHeadValue === null) {
      lastGitHeadValue = current;
      return;
    }
    if (current === lastGitHeadValue) {
      return;
    }
    const prevBranch = parseBranchFromHead(lastGitHeadValue);
    const nextBranch = parseBranchFromHead(current);
    lastGitHeadValue = current;
    if (!prevBranch || !nextBranch || prevBranch === nextBranch) {
      return;
    }
    queueEvent('branch_change', { from: prevBranch, to: nextBranch, source: 'git_head' });
    const reason = `branch_change:${prevBranch}->${nextBranch}`;
    lastCheckpointReason = reason;
    if (meaningfulScoreSinceSnapshot > 0 || eventsSinceSnapshot > 0) {
      await createCheckpoint(reason, { force: true });
    }
  } catch {
    // ignore
  }
}

async function tryWireGitBranchDetection() {
  const { autoCheckpoint } = getConfig();
  if (!autoCheckpoint.onBranchChange) {
    return;
  }

  const gitExtension = vscode.extensions.getExtension('vscode.git');
  const anyExports = gitExtension?.exports as { getAPI?: (version: number) => any } | undefined;
  if (!anyExports?.getAPI) {
    return;
  }
  const api = anyExports.getAPI(1);
  const repo = api?.repositories?.[0];
  if (!repo?.state) {
    return;
  }

  const getBranch = () => (repo.state.HEAD?.name as string | undefined) ?? null;
  gitBranchName = getBranch();

  repo.state.onDidChange(() => {
    const next = getBranch();
    if (next && next !== gitBranchName) {
      const prev = gitBranchName;
      gitBranchName = next;
      queueEvent('branch_change', { from: prev ?? 'unknown', to: next });
      lastCheckpointReason = `branch_change:${prev ?? 'unknown'}->${next}`;
      if (meaningfulScoreSinceSnapshot > 0 || eventsSinceSnapshot > 0) {
        void createCheckpoint(lastCheckpointReason, { force: true });
      }
    }
  });
}

function registerEventListeners(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== 'file') {
        return;
      }
      if (shouldIgnoreFile(doc.uri.fsPath)) {
        return;
      }
      queueEvent('file_edit', { filePath: doc.uri.fsPath, languageId: doc.languageId });
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      const files = editors
        .filter((e) => e.document.uri.scheme === 'file')
        .map((e) => e.document.uri.fsPath)
        .filter((f) => !shouldIgnoreFile(f));
      openFilesOrdered = files;
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document) {
        if (editor.document.uri.scheme !== 'file') {
          return;
        }
        if (shouldIgnoreFile(editor.document.uri.fsPath)) {
          return;
        }
        const filePath = editor.document.uri.fsPath;
        activeFilePath = filePath;
        if (!openFilesOrdered.includes(filePath)) {
          openFilesOrdered.push(filePath);
        }
        queueEvent('file_focus', { filePath, languageId: editor.document.languageId });
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor.document.uri.scheme !== 'file') {
        return;
      }
      const filePath = e.textEditor.document.uri.fsPath;
      if (shouldIgnoreFile(filePath)) {
        return;
      }
      const pos = e.selections?.[0]?.active;
      if (!pos) {
        return;
      }
      selectionByFile.set(filePath, { line: pos.line, character: pos.character });
    }),
    vscode.tasks.onDidStartTaskProcess((e) => {
      queueEvent('task_start', { name: e.execution.task.name, taskId: e.execution.task.definition?.type });
    }),
    vscode.tasks.onDidEndTaskProcess((e) => {
      queueEvent('task_end', {
        name: e.execution.task.name,
        taskId: e.execution.task.definition?.type,
        exitCode: e.exitCode ?? null
      });
    }),
    vscode.debug.onDidStartDebugSession((debugSession) =>
      queueEvent('debug_start', { name: debugSession.name, type: debugSession.type })
    ),
    vscode.debug.onDidTerminateDebugSession((debugSession) =>
      queueEvent('debug_end', { name: debugSession.name, type: debugSession.type })
    )
  );
}

export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showWarningMessage('Threads: Open a workspace folder to enable session tracking.');
    return;
  }

  threadsViewProvider = new ThreadsViewProvider();
  vscode.window.registerTreeDataProvider('threads.view', threadsViewProvider);

  await startSession(context);
  ensureStatusBarItem(context);
  await refreshMomentumUI();
  void maybeShowResumePrompt();
  registerEventListeners(context);
  startCheckpointTimer();
  void tryWireGitBranchDetection();

  const { flushIntervalMs } = getConfig();
  startFlushTimer(flushIntervalMs);

  const showCommand = vscode.commands.registerCommand('threads.showLastState', showLatestSnapshot);
  const saveCommand = vscode.commands.registerCommand('threads.saveStateNow', async () => {
    await saveStateNow(context);
  });
  const openSummaryCommand = vscode.commands.registerCommand('threads.openSummaryFile', openOrCreateSummaryFile);
  const browseCommand = vscode.commands.registerCommand('threads.browseSnapshots', browseSnapshots);
  const healthCommand = vscode.commands.registerCommand('threads.checkBackend', checkBackendHealth);
  const showOutputCommand = vscode.commands.registerCommand('threads.showOutput', () => getOutputChannel().show(true));
  const exportBundleCommand = vscode.commands.registerCommand('threads.exportContextBundle', exportContextBundle);
  const resumeCommand = vscode.commands.registerCommand('threads.resumeWhereILeftOff', resumeWhereILeftOff);
  const menuCommand = vscode.commands.registerCommand('threads.statusMenu', showStatusMenu);
  const diagnosticsCommand = vscode.commands.registerCommand('threads.diagnostics', showDiagnostics);
  const checkpointNowCommand = vscode.commands.registerCommand('threads.checkpointNow', async () => {
    await createCheckpoint('manual', { force: true });
  });

  context.subscriptions.push(
    showCommand,
    saveCommand,
    openSummaryCommand,
    browseCommand,
    healthCommand,
    showOutputCommand,
    exportBundleCommand,
    resumeCommand,
    menuCommand,
    diagnosticsCommand,
    checkpointNowCommand
  );
  ensureStatusBarItem(context);
  logInfo(`Threads: Extension activated (projectId=${projectId ?? 'unknown'}).`);
}

export async function deactivate() {
  if (flushTimer) {
    clearInterval(flushTimer);
  }
  if (checkpointTimer) {
    clearInterval(checkpointTimer);
  }
  const { autoCheckpoint } = getConfig();
  if (autoCheckpoint.onShutdown && (pendingEvents.length > 0 || eventsSinceSnapshot > 0)) {
    logInfo('Threads: Shutdown snapshot (ending session)');
    await endSession(false, false);
    return;
  }
  await endSession(false, false);
}
