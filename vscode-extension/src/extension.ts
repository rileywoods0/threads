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

function getConfig() {
  const config = vscode.workspace.getConfiguration('threads');
  const resumeModeFromSetting = config.get<string>('resumeMode');
  const resumePrompt = config.get<boolean>('resumePrompt', true);
  const resumeMode = resumeModeFromSetting ?? (resumePrompt ? 'prompt' : 'off');
  return {
    backendUrl: config.get<string>('backendUrl', 'http://localhost:8000'),
    flushIntervalMs: config.get<number>('eventFlushIntervalMs', 5000),
    resumeMode
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
  getOutputChannel().appendLine(`${message}${err ? `: ${String(err)}` : ''}`);
  console.error(message, err);
}

function ensureStatusBarItem(context: vscode.ExtensionContext) {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = '$(clock) Threads';
    statusBarItem.tooltip = 'Threads is capturing session context.';
    statusBarItem.command = 'threads.resumeWhereILeftOff';
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

function queueEvent(event_type: string, data: Record<string, unknown>) {
  const filePath = data.filePath;
  if (typeof filePath === 'string' && !shouldIgnoreFile(filePath)) {
    if (event_type === 'file_edit' || event_type === 'file_focus') {
      touchedFiles.add(filePath);
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
  touchedFiles = new Set<string>();
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
  } catch (err) {
    logError('Threads: Failed to flush events', err);
    vscode.window.showErrorMessage('Threads: Failed to send events to backend.');
    pendingEvents.unshift(...eventsToSend);
  }
}

async function endSession(showNotification = false): Promise<ThreadsSnapshot | null> {
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
    ThreadsPanel.render(snapshot);

    if (showNotification) {
      vscode.window.showInformationMessage('Threads saved your session snapshot.');
    }

    sessionId = null;
    return snapshot;
  } catch (err) {
    logError('Threads: Failed to end session', err);
    vscode.window.showErrorMessage('Threads: Failed to end session. Check backend logs for details.');
    return null;
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
  const snapshot = await endSession(true);
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
};

function formatSnapshotMarkdown(snapshot: ThreadsSnapshot): string {
  const lines: string[] = [];
  lines.push('# Threads – Last Session');
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

  const state: LastSessionState = {
    savedAt: new Date().toISOString(),
    snapshotId,
    currentGoal: snapshot.current_goal ?? undefined,
    nextSteps: snapshot.next_steps ?? undefined,
    files: combined.slice(0, 50)
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
  const { resumeMode } = getConfig();
  if (resumeMode === 'off' || resumePromptShown) {
    return;
  }
  resumePromptShown = true;

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
  shortForAgent.push('# Threads – Context (Short)');
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
  fullMarkdown.push('# Threads – Context Bundle');
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
      fullMarkdown.push(`- ${when} — ${hint || s.id}`);
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

  const state = await readLastSessionState();
  const fileCount = state?.files?.length ?? 0;
  const goal = (state?.currentGoal || '').trim();
  const nextStep = (state?.nextSteps?.[0] || '').trim();

  statusBarItem.text = fileCount ? '$(clock) Threads • Resume' : '$(clock) Threads';
  const tip = nextStep ? `Next: ${nextStep}` : '';
  statusBarItem.tooltip = goal
    ? `Resume: ${goal}${fileCount ? ` (${fileCount} files)` : ''}${tip ? `\n${tip}` : ''}`
    : fileCount
      ? `Resume available (${fileCount} files)${tip ? `\n${tip}` : ''}`
      : 'Threads is capturing session context.';
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

  const files = state?.files ?? [];
  if (!files.length) {
    vscode.window.showInformationMessage('Threads: No recent files recorded yet. Save a session first.');
    return;
  }

  const existing: string[] = [];
  for (const file of files) {
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

  const openAll = existing.length <= 6;
  const confirm = openAll
    ? 'Open'
    : await vscode.window.showInformationMessage(
        `Open the last ${Math.min(6, existing.length)} files?`,
        'Open',
        'Choose files'
      );
  if (confirm !== 'Open' && confirm !== 'Choose files') {
    return;
  }

  let toOpen = existing.slice(0, 6);
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
  }
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
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document) {
        if (editor.document.uri.scheme !== 'file') {
          return;
        }
        if (shouldIgnoreFile(editor.document.uri.fsPath)) {
          return;
        }
        queueEvent('file_focus', { filePath: editor.document.uri.fsPath, languageId: editor.document.languageId });
      }
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

  context.subscriptions.push(
    showCommand,
    saveCommand,
    openSummaryCommand,
    browseCommand,
    healthCommand,
    showOutputCommand,
    exportBundleCommand,
    resumeCommand
  );
  ensureStatusBarItem(context);
  logInfo(`Threads: Extension activated (projectId=${projectId ?? 'unknown'}).`);
}

export async function deactivate() {
  if (flushTimer) {
    clearInterval(flushTimer);
  }
  await endSession();
}
