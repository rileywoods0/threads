import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { ThreadsPanel, ThreadsPanelMeta, ThreadsSnapshot } from './panel';
import { ThreadsViewProvider } from './threadsView';
import { buildHandoffText } from './llm/formatting';
import { LlmProvider, LlmSummaryOutput } from './llm/types';
import { OllamaProvider } from './llm/ollamaProvider';
import { OpenAIProvider } from './llm/openaiProvider';
import { formatPathForExport } from './utils/paths';
import { LocalStorageAdapter } from './storage/localStorage';
import { RemoteStorageAdapter } from './storage/remoteStorage';
import { EventPayload, SnapshotListItem, StorageAdapter } from './storage/types';

type CursorPosition = { line: number; character: number };
type SelectionState = { anchor: CursorPosition; active: CursorPosition };
type StoredSelection = SelectionState | CursorPosition;
type HandoffMode = 'compact' | 'debug' | 'deep';

let sessionId: string | null = null;
let projectId: string | null = null;
let workspaceRoot: string | null = null;
let storageAdapter: StorageAdapter | null = null;
let dataDir: string | null = null;
let runtimeMode: 'local' | 'remote' = 'local';
let pendingEvents: EventPayload[] = [];
let flushTimer: NodeJS.Timeout | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let summaryFilePath: string | null = null;
let outputChannel: vscode.OutputChannel | undefined;
let resumePromptShown = false;
let stateFilePath: string | null = null;
let touchedFiles = new Set<string>();
let threadsViewProvider: ThreadsViewProvider | undefined;
let selectionByFile = new Map<string, SelectionState>();
let openFilesOrdered: string[] = [];
let activeFilePath: string | null = null;
let lastActivityAtMs = Date.now();
let eventsSinceSnapshot = 0;
let meaningfulScoreSinceSnapshot = 0;
let checkpointSignalsSinceSnapshot = 0;
let eventCountsSinceSnapshot = new Map<string, number>();
let lastFlushAtMs: number | null = null;
let lastSnapshotAtMs: number | null = null;
let lastSnapshotId: string | null = null;
let lastBackendError: string | null = null;
let lastSummarySource: 'heuristic' | 'llm' = 'heuristic';
let lastLlmTestStatus: string | null = null;
let lastLlmProvider: string | null = null;
let lastLlmSummaryAtMs: number | null = null;
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
let lastLoadedSnapshot: ThreadsSnapshot | null = null;
let lastTaskRun: { name: string; taskId?: string | null } | null = null;
let lastDebugSession: { name: string; startedAt?: string; endedAt?: string } | null = null;
let openEditorsOrdered: Array<{ filePath: string; viewColumn?: number }> = [];
let sessionStartedAtMs: number | null = null;
let smartResume = {
  eligible: false,
  deadlineMs: 0,
  files: new Set<string>(),
  edits: 0,
  shown: false
};

function getConfig() {
  const config = vscode.workspace.getConfiguration('threads');
  const resumeModeFromSetting = config.get<string>('resumeMode');
  const resumePrompt = config.get<boolean>('resumePrompt', true);
  const resumeMode = resumeModeFromSetting ?? (resumePrompt ? 'prompt' : 'off');
  const longBreakHours = config.get<number>('resume.longBreakHours', 8);
  const minMeaningfulScore = config.get<number>('autoCheckpoint.minMeaningfulScore', 15);
  const deprecatedMinEvents = config.get<number>('autoCheckpoint.minEvents', 20);
  const runtimeModeSetting = config.get<'local' | 'remote'>('runtimeMode', 'local');
  const dataDirSetting = config.get<string>('dataDir', '${workspaceFolder}/.threads');
  const legacyBackendUrl = config.get<string>('backendUrl', 'http://localhost:8000');
  const remoteBackendUrl = config.get<string>('remote.backendUrl', legacyBackendUrl);
  return {
    runtimeMode: runtimeModeSetting,
    dataDir: dataDirSetting,
    remote: {
      backendUrl: remoteBackendUrl
    },
    flushIntervalMs: config.get<number>('eventFlushIntervalMs', 5000),
    resumeMode,
    longBreakHours,
    startup: {
      openSnapshotPanel: config.get<string>('startup.openSnapshotPanel', 'off')
    },
    autoCheckpoint: {
      enabled: config.get<boolean>('autoCheckpoint.enabled', true),
      intervalMinutes: config.get<number>('autoCheckpoint.intervalMinutes', 15),
      idleMinutes: config.get<number>('autoCheckpoint.idleMinutes', 8),
      minMeaningfulScore,
      minEvents: deprecatedMinEvents,
      onShutdown: config.get<boolean>('autoCheckpoint.onShutdown', true),
      onBranchChange: config.get<boolean>('autoCheckpoint.onBranchChange', true)
    },
    export: {
      maxFiles: config.get<number>('export.maxFiles', 10),
      redactHomeDir: config.get<boolean>('export.redactHomeDir', true),
      includeFilePaths: config.get<boolean>('export.includeFilePaths', true),
      includeTaskHistory: config.get<boolean>('export.includeTaskHistory', true),
      includeDebugSummary: config.get<boolean>('export.includeDebugSummary', true)
    },
    llm: {
      provider: config.get<'none' | 'ollama' | 'openai'>('llm.provider', 'none'),
      includeCodeSnippets: config.get<boolean>('llm.includeCodeSnippets', false),
      ollamaUrl: config.get<string>('llm.ollamaUrl', 'http://localhost:11434'),
      ollamaModel: config.get<string>('llm.ollamaModel', 'llama3.1'),
      openaiModel: config.get<string>('llm.openaiModel', 'gpt-5.2-mini'),
      openaiBaseUrl: config.get<string>('llm.openaiBaseUrl', '')
    },
    feedback: {
      githubRepo: config.get<string>('feedback.githubRepo', '')
    }
  };
}

function resolveDataDir(rootPath: string, configured: string): string {
  const substituted = configured.replace('${workspaceFolder}', rootPath);
  const expanded = substituted.startsWith('~')
    ? path.join(os.homedir(), substituted.slice(1))
    : substituted;
  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  return path.normalize(path.join(rootPath, expanded));
}

function applyDataDir(rootPath: string) {
  const { dataDir: configured } = getConfig();
  dataDir = resolveDataDir(rootPath, configured);
  summaryFilePath = path.join(dataDir, 'last-session.md');
  stateFilePath = path.join(dataDir, 'last-session-state.json');
  toastStampPath = path.join(dataDir, 'toast-stamps.json');
}

function ensureStorageAdapter(rootPath: string): StorageAdapter {
  const { runtimeMode: mode, remote } = getConfig();
  runtimeMode = mode;
  if (!dataDir) {
    applyDataDir(rootPath);
  }
  if (mode === 'remote') {
    storageAdapter = new RemoteStorageAdapter(remote.backendUrl);
  } else {
    storageAdapter = new LocalStorageAdapter(dataDir ?? path.join(rootPath, '.threads'));
  }
  return storageAdapter;
}

async function getLlmProvider(): Promise<LlmProvider | null> {
  const { llm } = getConfig();
  if (llm.provider === 'none') {
    lastLlmProvider = null;
    return null;
  }
  if (llm.provider === 'ollama') {
    lastLlmProvider = 'ollama';
    return new OllamaProvider(llm.ollamaUrl, llm.ollamaModel);
  }
  if (llm.provider === 'openai') {
    const apiKey = await extensionContext?.secrets.get('threads.openaiApiKey');
    if (!apiKey) {
      lastLlmProvider = 'openai';
      return null;
    }
    lastLlmProvider = 'openai';
    return new OpenAIProvider(apiKey, llm.openaiModel, llm.openaiBaseUrl || undefined);
  }
  return null;
}

function buildSummaryTextFromFields(snapshot: ThreadsSnapshot): string {
  const lines: string[] = [];
  if (snapshot.current_goal) {
    lines.push(`Current goal: ${snapshot.current_goal}`);
  }
  if (snapshot.completed_work?.length) {
    lines.push(`Completed: ${snapshot.completed_work.join(' ')}`);
  }
  if (snapshot.open_issues?.length) {
    lines.push(`Open issues: ${snapshot.open_issues.join(' ')}`);
  }
  if (snapshot.next_steps?.length) {
    lines.push(`Next step: ${snapshot.next_steps[0]}`);
  }
  if (snapshot.decisions?.length) {
    lines.push(`Decision: ${snapshot.decisions[0]}`);
  }
  if ((snapshot as any).confidence_tag) {
    lines.push(`Confidence: ${(snapshot as any).confidence_tag}`);
  }
  return lines.join('\n');
}

function buildLlmSummaryInput(snapshot: ThreadsSnapshot, state: LastSessionState | null) {
  const files = (state?.files ?? []).map((file) => path.basename(file)).slice(0, 10);
  const anchor = getAnchorFileFromState(state);
  const anchorLabel = anchor ? path.basename(anchor) : undefined;
  const eventCounts: Record<string, number> = {};
  for (const [key, value] of eventCountsSinceSnapshot.entries()) {
    eventCounts[key] = value;
  }
  const durationMinutes = sessionStartedAtMs ? Math.round((Date.now() - sessionStartedAtMs) / 60000) : undefined;
  return {
    goal: snapshot.current_goal ?? state?.currentGoal,
    anchor: anchorLabel,
    files,
    recentActions: snapshot.completed_work ?? [],
    openIssues: snapshot.open_issues ?? [],
    nextSteps: snapshot.next_steps ?? [],
    decisions: snapshot.decisions ?? [],
    lastTask: state?.lastTask?.name,
    lastError: lastBackendError ?? undefined,
    lastCheckpointAt: lastSnapshotAtMs ? new Date(lastSnapshotAtMs).toISOString() : undefined,
    eventCounts,
    durationMinutes
  };
}

async function maybeEnhanceSnapshotWithLlm(snapshot: ThreadsSnapshot): Promise<ThreadsSnapshot> {
  const provider = await getLlmProvider();
  if (!provider || !provider.isConfigured()) {
    lastSummarySource = 'heuristic';
    return snapshot;
  }
  try {
    const state = await readLastSessionState();
    const summary = (await provider.summarize(buildLlmSummaryInput(snapshot, state))) as LlmSummaryOutput;
    const enhanced: ThreadsSnapshot = {
      ...snapshot,
      current_goal: summary.current_goal ?? snapshot.current_goal,
      completed_work: summary.completed_work ?? snapshot.completed_work,
      open_issues: summary.open_issues ?? snapshot.open_issues,
      next_steps: summary.next_steps ?? snapshot.next_steps,
      decisions: summary.decisions ?? snapshot.decisions,
      summary_text: buildSummaryTextFromFields({ ...snapshot, ...summary } as ThreadsSnapshot),
      confidence_tag: summary.confidence_tag ?? (snapshot as any).confidence_tag
    };
    lastSummarySource = 'llm';
    lastLlmSummaryAtMs = Date.now();
    if (storageAdapter?.updateSnapshot && enhanced.id) {
      await storageAdapter.updateSnapshot(enhanced.id, enhanced as Record<string, unknown>);
    }
    return enhanced;
  } catch (err) {
    lastSummarySource = 'heuristic';
    logError('Threads: LLM summary failed', err);
    return snapshot;
  }
}

async function buildAgentHandoffText(input: Parameters<typeof buildHandoffText>[0]): Promise<string> {
  const provider = await getLlmProvider();
  if (!provider || !provider.isConfigured()) {
    return buildHandoffText(input);
  }
  try {
    return await provider.buildAgentHandoff(input);
  } catch (err) {
    logError('Threads: LLM handoff generation failed', err);
    return buildHandoffText(input);
  }
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
      statusBarItem.tooltip = 'Open the last Threads snapshot';
      statusBarItem.command = 'threads.showLastState';
      context.subscriptions.push(statusBarItem);
    }
  statusBarItem.show();
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\//g, path.sep);
}

function shouldIgnoreFile(filePath: string): boolean {
  const normalized = normalizePath(filePath).toLowerCase();
  if (dataDir) {
    const normalizedDataDir = normalizePath(dataDir).toLowerCase();
    if (normalized.startsWith(normalizedDataDir)) {
      return true;
    }
  }
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
    case 'file.save':
      return { score: 5, category: 'EDIT' };
    case 'file_focus':
    case 'editor.focus':
      return { score: 1, category: 'FOCUS' };
    case 'debug_start':
    case 'debug.start':
      return { score: 5, category: 'EXECUTION' };
    case 'debug_end':
    case 'debug.end':
      return { score: 1, category: 'EXECUTION' };
    case 'task_start':
    case 'task.start':
      return { score: 4, category: 'EXECUTION' };
    case 'task_end':
    case 'task.end':
      return { score: 1, category: 'EXECUTION' };
    case 'branch_change':
    case 'git.branch.change':
      return { score: 6, category: 'STATE_CHANGE' };
    case 'friction_switching':
    case 'friction.context_switching':
      return { score: 2, category: 'FRICTION' };
    default:
      return { score: 1, category: 'NAVIGATION' };
  }
}

function pruneOldTimestamps(timestamps: number[], windowMs: number): number[] {
  const cutoff = Date.now() - windowMs;
  return timestamps.filter((t) => t >= cutoff);
}

function normalizeEventType(event_type: string): string {
  if (event_type.includes('.')) {
    return event_type;
  }
  switch (event_type) {
    case 'file_focus':
      return 'editor.focus';
    case 'file_edit':
      return 'file.save';
    case 'debug_start':
      return 'debug.start';
    case 'debug_end':
      return 'debug.end';
    case 'task_start':
      return 'task.start';
    case 'task_end':
      return 'task.end';
    case 'branch_change':
      return 'git.branch.change';
    case 'friction_switching':
      return 'friction.context_switching';
    default:
      return event_type;
  }
}

function queueEvent(event_type: string, data: Record<string, unknown>) {
  const normalizedType = normalizeEventType(event_type);
  const filePath = data.filePath;
  if (
    (normalizedType === 'file.save' || normalizedType === 'editor.focus') &&
    typeof filePath === 'string' &&
    shouldIgnoreFile(filePath)
  ) {
    return;
  }
  if (typeof filePath === 'string' && !shouldIgnoreFile(filePath)) {
    if (normalizedType === 'file.save' || normalizedType === 'editor.focus') {
      touchedFiles.add(filePath);
    }
  }

  lastActivityAtMs = Date.now();
  eventsSinceSnapshot += 1;
  const scored = scoreForEvent(normalizedType, data);
  meaningfulScoreSinceSnapshot += scored.score;
  if (['EDIT', 'EXECUTION', 'STATE_CHANGE', 'INTENT'].includes(scored.category)) {
    checkpointSignalsSinceSnapshot += 1;
  }
  eventCountsSinceSnapshot.set(normalizedType, (eventCountsSinceSnapshot.get(normalizedType) ?? 0) + 1);
  if (normalizedType === 'file.save') {
    editEventsSinceSnapshot += 1;
    if (smartResume.eligible) {
      smartResume.edits += 1;
    }
  }

  if (normalizedType === 'editor.focus') {
    focusTimestamps.push(Date.now());
    focusTimestamps = pruneOldTimestamps(focusTimestamps, 2 * 60_000);
    const tooMuchSwitching = focusTimestamps.length >= 14 && editEventsSinceSnapshot === 0;
    const quietWindow = Date.now() - lastFrictionEmittedAtMs > 10 * 60_000;
    if (tooMuchSwitching && quietWindow) {
      lastFrictionEmittedAtMs = Date.now();
      pendingEvents.push({
        event_type: normalizeEventType('friction_switching'),
        timestamp: new Date().toISOString(),
        data: { focusEventsIn2Min: focusTimestamps.length, source: 'vscode', legacy_event_type: 'friction_switching' }
      });
      meaningfulScoreSinceSnapshot += scoreForEvent(normalizeEventType('friction_switching'), {}).score;
    }
  }

  const meta: Record<string, unknown> = {
    ...data,
    source: 'vscode'
  };
  if (event_type !== normalizedType) {
    meta.legacy_event_type = event_type;
  }

  pendingEvents.push({
    event_type: normalizedType,
    timestamp: new Date().toISOString(),
    data: meta
  });

  if (smartResume.eligible && !smartResume.shown && normalizedType === 'editor.focus') {
    const now = Date.now();
    const fp = typeof filePath === 'string' ? filePath : null;
    if (fp && now <= smartResume.deadlineMs && !shouldIgnoreFile(fp)) {
      smartResume.files.add(fp);
      void maybeTriggerSmartResumePrompt();
    }
  }
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
  applyDataDir(rootPath);
  gitHeadPath = path.join(rootPath, '.git', 'HEAD');
  lastGitHeadValue = null;
  touchedFiles = new Set<string>();
  selectionByFile = new Map<string, SelectionState>();
  openFilesOrdered = [];
  activeFilePath = null;
  lastActivityAtMs = Date.now();
  eventsSinceSnapshot = 0;
  meaningfulScoreSinceSnapshot = 0;
  checkpointSignalsSinceSnapshot = 0;
  eventCountsSinceSnapshot = new Map<string, number>();
  editEventsSinceSnapshot = 0;
  focusTimestamps = [];
  lastSnapshotAtMs = Date.now();
  sessionStartedAtMs = Date.now();
  lastSnapshotId = null;
  lastDebugSession = null;
  lastSummarySource = 'heuristic';
  lastLlmSummaryAtMs = null;
  const projectName = path.basename(rootPath);
  const adapter = ensureStorageAdapter(rootPath);

  try {
    const payload = await adapter.startSession(rootPath, projectName);

    sessionId = payload.sessionId;
    projectId = payload.projectId ?? null;
    context.workspaceState.update('threads.sessionId', sessionId);
    logInfo(`Threads: Started session ${sessionId} for ${rootPath}`);
    ensureStatusBarItem(context);
  } catch (err) {
    logError('Threads: Failed to start session', err);
    vscode.window.showErrorMessage('Threads failed to start session. Check storage configuration.');
  }
}

async function flushEvents() {
  if (!sessionId || pendingEvents.length === 0) {
    return;
  }

  const eventsToSend = [...pendingEvents];
  pendingEvents = [];

  try {
    const adapter = storageAdapter ?? (workspaceRoot ? ensureStorageAdapter(workspaceRoot) : null);
    if (!adapter) {
      throw new Error('Storage adapter not available');
    }
    await adapter.flushEvents(sessionId, eventsToSend);
    logInfo(`Threads: Flushed ${eventsToSend.length} events.`);
    lastFlushAtMs = Date.now();
  } catch (err) {
    logError('Threads: Failed to flush events', err);
    vscode.window.showErrorMessage('Threads: Failed to flush events. Check storage configuration.');
    pendingEvents.unshift(...eventsToSend);
  }
}

async function endSession(showNotification = false, showPanel = true): Promise<ThreadsSnapshot | null> {
  if (!sessionId) {
    return null;
  }

  await flushEvents();

  try {
    const adapter = storageAdapter ?? (workspaceRoot ? ensureStorageAdapter(workspaceRoot) : null);
    if (!adapter) {
      throw new Error('Storage adapter not available');
    }
    let snapshot = (await adapter.endSession(sessionId)) as ThreadsSnapshot;
    snapshot = await maybeEnhanceSnapshotWithLlm(snapshot);

    lastLoadedSnapshot = snapshot;
    await persistLatestSnapshotMarkdown(snapshot);
    await persistSnapshotArchiveMarkdown(snapshot);
    await persistLastSessionState(snapshot);
    threadsViewProvider?.refresh();
    if (extensionContext) {
      await extensionContext.workspaceState.update('threads.didFirstCheckpoint', true);
    }
    await refreshMomentumUI();
    if (showPanel) {
      const state = await readLastSessionState();
      ThreadsPanel.render(snapshot, buildPanelMeta(snapshot, state));
    }

    if (showNotification) {
      vscode.window.showInformationMessage('Threads saved your session snapshot.');
    }

    sessionId = null;
    eventsSinceSnapshot = 0;
    meaningfulScoreSinceSnapshot = 0;
    checkpointSignalsSinceSnapshot = 0;
    eventCountsSinceSnapshot = new Map<string, number>();
    editEventsSinceSnapshot = 0;
    focusTimestamps = [];
    lastSnapshotAtMs = Date.now();
    lastSnapshotId = getSnapshotId(snapshot);
    return snapshot;
  } catch (err) {
    logError('Threads: Failed to end session', err);
    vscode.window.showErrorMessage('Threads: Failed to end session. Check storage logs for details.');
    return null;
  }
}

async function createCheckpoint(reason: string, options?: { force?: boolean }) {
  const { autoCheckpoint } = getConfig();
  if (!sessionId) {
    return;
  }

  const force = options?.force ?? false;
  if (!autoCheckpoint.enabled && !force) {
    return;
  }
  const scoreThreshold = autoCheckpoint.minMeaningfulScore ?? autoCheckpoint.minEvents ?? 15;
  if (!force && checkpointSignalsSinceSnapshot === 0) {
    return;
  }
  if (!force && meaningfulScoreSinceSnapshot < scoreThreshold) {
    return;
  }

  logInfo(
    `Threads: Checkpoint triggered (${reason}) score=${meaningfulScoreSinceSnapshot} signals=${checkpointSignalsSinceSnapshot} events=${eventsSinceSnapshot}`
  );
  await flushEvents();

  try {
    const adapter = storageAdapter ?? (workspaceRoot ? ensureStorageAdapter(workspaceRoot) : null);
    if (!adapter) {
      throw new Error('Storage adapter not available');
    }
    let snapshot = (await adapter.createCheckpoint(sessionId, reason)) as ThreadsSnapshot;
    snapshot = await maybeEnhanceSnapshotWithLlm(snapshot);

    lastLoadedSnapshot = snapshot;
    await persistLatestSnapshotMarkdown(snapshot);
    await persistSnapshotArchiveMarkdown(snapshot);
    await persistLastSessionState(snapshot);
    threadsViewProvider?.refresh();
    if (extensionContext) {
      await extensionContext.workspaceState.update('threads.didFirstCheckpoint', true);
    }
    eventsSinceSnapshot = 0;
    meaningfulScoreSinceSnapshot = 0;
    checkpointSignalsSinceSnapshot = 0;
    eventCountsSinceSnapshot = new Map<string, number>();
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
  const adapter = storageAdapter ?? ensureStorageAdapter(rootPath);
  const snapshot = await adapter.fetchLatestSnapshot(rootPath);
  return snapshot as ThreadsSnapshot | null;
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
    lastLoadedSnapshot = snapshot;
    await persistLatestSnapshotMarkdown(snapshot);
    await persistSnapshotArchiveMarkdown(snapshot);
    await persistLastSessionState(snapshot);
    threadsViewProvider?.refresh();
    await refreshMomentumUI();
    const state = await readLastSessionState();
    ThreadsPanel.render(snapshot, buildPanelMeta(snapshot, state));
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
  openEditors?: Array<{ filePath: string; viewColumn?: number }>;
  activeFile?: string;
  cursors?: Record<string, StoredSelection>;
  lastTask?: { name: string; taskId?: string | null };
  lastDebug?: { name: string; startedAt?: string; endedAt?: string };
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

  if ((snapshot as any).confidence_tag) {
    lines.push('## Confidence');
    lines.push(String((snapshot as any).confidence_tag));
    lines.push('');
  }

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

async function listVisibleEditorsOrdered(): Promise<Array<{ filePath: string; viewColumn?: number }>> {
  const editors: Array<{ filePath: string; viewColumn?: number }> = [];
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.scheme !== 'file') {
      continue;
    }
    const filePath = editor.document.uri.fsPath;
    if (shouldIgnoreFile(filePath)) {
      continue;
    }
    const viewColumn = typeof editor.viewColumn === 'number' ? editor.viewColumn : undefined;
    editors.push({ filePath, viewColumn });
  }
  return editors;
}

async function persistLastSessionState(snapshot: ThreadsSnapshot) {
  if (!workspaceRoot || !stateFilePath) {
    return;
  }

  const filesFromEditors = await listVisibleEditorFiles();
  const combined = [...new Set([...touchedFiles, ...filesFromEditors])].filter((file) => !shouldIgnoreFile(file));
  const snapshotId = getSnapshotId(snapshot) ?? undefined;

  const openFiles = openFilesOrdered.filter((f) => !shouldIgnoreFile(f));
  const openEditors = await listVisibleEditorsOrdered();
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor?.document.uri.scheme === 'file') {
    const activePath = activeEditor.document.uri.fsPath;
    if (!shouldIgnoreFile(activePath)) {
      selectionByFile.set(activePath, {
        anchor: { line: activeEditor.selection.anchor.line, character: activeEditor.selection.anchor.character },
        active: { line: activeEditor.selection.active.line, character: activeEditor.selection.active.character }
      });
    }
  }
  const cursors: Record<string, SelectionState> = {};
  for (const [file, selection] of selectionByFile.entries()) {
    if (!shouldIgnoreFile(file)) {
      cursors[file] = selection;
    }
  }

    const state: LastSessionState = {
      savedAt: new Date().toISOString(),
      snapshotId,
      currentGoal: snapshot.current_goal ?? undefined,
      nextSteps: snapshot.next_steps ?? undefined,
      files: combined.slice(0, 50),
      openFiles: openFiles.slice(0, 25),
      openEditors: openEditors.slice(0, 25),
      activeFile: activeFilePath ?? undefined,
      cursors,
      lastTask: lastTaskRun ?? undefined,
      lastDebug: lastDebugSession ?? undefined
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

function getAnchorFileFromState(state: LastSessionState | null): string | null {
  if (!state) {
    return null;
  }
  const active = (state.activeFile || '').trim();
  if (active) {
    return active;
  }
  const openEditors = state.openEditors?.length ? state.openEditors.map((e) => e.filePath) : [];
  if (openEditors.length) {
    return openEditors[0];
  }
  const openFiles = state.openFiles?.length ? state.openFiles : [];
  if (openFiles.length) {
    return openFiles[0];
  }
  const files = state.files?.length ? state.files : [];
  return files.length ? files[0] : null;
}

function formatAnchorLabel(filePath: string, rootPath: string): string {
  const relative = path.relative(rootPath, filePath);
  if (!relative || relative.startsWith('..')) {
    return path.basename(filePath);
  }
  return relative.replace(/\\/g, '/');
}

function buildPanelMeta(snapshot: ThreadsSnapshot, state: LastSessionState | null): ThreadsPanelMeta {
  const anchor = getAnchorFileFromState(state);
  const nextStepRaw = (snapshot.next_steps?.[0] ?? state?.nextSteps?.[0] ?? '').toString().trim();
  const selection = anchor ? normalizeSelectionState(state?.cursors?.[anchor]) : null;
  const line = selection ? selection.active.line + 1 : null;
  const col = selection ? selection.active.character + 1 : null;
  const anchorLabel = anchor && workspaceRoot ? formatAnchorLabel(anchor, workspaceRoot) : undefined;
  const anchorWithPos =
    anchorLabel && line && col ? `${anchorLabel}:${line}:${col}` : anchorLabel && line ? `${anchorLabel}:${line}` : anchorLabel;
  return {
    anchorFileLabel: anchorWithPos,
    nextStep: nextStepRaw || undefined
  };
}

function formatAnchorForHandoff(
  state: LastSessionState | null,
  options: { includeFilePaths: boolean; redactHomeDir: boolean }
): string | null {
  const anchor = getAnchorFileFromState(state);
  if (!anchor) {
    return null;
  }
  const selection = normalizeSelectionState(state?.cursors?.[anchor]);
  const line = selection ? selection.active.line + 1 : null;
  const col = selection ? selection.active.character + 1 : null;
  const formatted = formatPathForExport(anchor, options);
  if (line && col) {
    return `${formatted}:${line}:${col}`;
  }
  if (line) {
    return `${formatted}:${line}`;
  }
  return formatted;
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
  if (!dataDir) {
    return;
  }
  const snapshotId = getSnapshotId(snapshot);
  if (!snapshotId) {
    return;
  }
  const archivePath = path.join(dataDir, 'snapshots', `${snapshotId}.md`);
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
      vscode.window.showErrorMessage('Threads: Unable to create summary file. Check storage configuration.');
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
        smartResume.eligible = true;
        smartResume.deadlineMs = Date.now() + 45_000;
        smartResume.files = new Set<string>();
        smartResume.edits = 0;
        smartResume.shown = false;
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

async function maybeTriggerSmartResumePrompt() {
  const { resumeMode } = getConfig();
  if (resumeMode === 'off') {
    smartResume.eligible = false;
    return;
  }
  if (!smartResume.eligible || smartResume.shown) {
    return;
  }
  if (smartResume.edits > 0) {
    smartResume.eligible = false;
    return;
  }
  if (Date.now() > smartResume.deadlineMs) {
    smartResume.eligible = false;
    return;
  }
  if (smartResume.files.size < 2) {
    return;
  }

  smartResume.shown = true;
  smartResume.eligible = false;
  const choice = await vscode.window.showInformationMessage('Resume where you left off?', 'Resume', 'Later');
  if (choice === 'Resume') {
    await resumeWhereILeftOff();
  }
}

async function maybeOpenSnapshotPanelOnStartup() {
  const { startup, longBreakHours } = getConfig();
  if (startup.openSnapshotPanel === 'off') {
    return;
  }

  const state = await readLastSessionState();
  const savedAt = state?.savedAt;
  const isLongBreak = (() => {
    if (!savedAt) return false;
    const ts = Date.parse(savedAt);
    if (Number.isNaN(ts)) return false;
    return (Date.now() - ts) / 3_600_000 >= longBreakHours;
  })();

  if (startup.openSnapshotPanel === 'always' || (startup.openSnapshotPanel === 'longBreak' && isLongBreak)) {
    // This can be disruptive, so it is configurable and defaults to off.
    await showLatestSnapshot();
  }
}

async function browseSnapshots() {
  const rootPath = getWorkspaceRoot();
  if (!rootPath) {
    vscode.window.showWarningMessage('Threads: No workspace folder open.');
    return;
  }

  try {
    const adapter = storageAdapter ?? ensureStorageAdapter(rootPath);
    const list = await adapter.listSnapshots(rootPath, 30);
    if (!list.length) {
      vscode.window.showInformationMessage('Threads: No snapshots available yet.');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      list.map((s) => {
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

    const snapshot = (await adapter.getSnapshot(picked.snapshotId)) as ThreadsSnapshot;
    const archiveRoot = dataDir ?? path.join(rootPath, '.threads');
    const archivePath = path.join(archiveRoot, 'snapshots', `${picked.snapshotId}.md`);
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

    lastLoadedSnapshot = snapshot;
    const state = await readLastSessionState();
    ThreadsPanel.render(snapshot, buildPanelMeta(snapshot, state));
  } catch (err) {
    logError('Threads: Unable to browse snapshots', err);
    vscode.window.showErrorMessage('Threads: Unable to browse snapshots. Check storage configuration.');
  }
}

async function checkBackendHealth() {
  const { runtimeMode: mode, remote } = getConfig();
  if (mode === 'local') {
    vscode.window.showInformationMessage('Threads is running in local mode. No backend required.');
    return;
  }
  const backendUrl = remote.backendUrl;
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

  const { export: exportCfg } = getConfig();
  const bundleRoot = dataDir ?? path.join(rootPath, '.threads');
  const bundlePath = path.join(bundleRoot, 'context-bundle.md');

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
    const adapter = storageAdapter ?? ensureStorageAdapter(rootPath);
    snapshots = await adapter.listSnapshots(rootPath, 10);
  } catch (err) {
    logError('Threads: Unable to fetch snapshot list for context bundle', err);
  }

  const state = await readLastSessionState();
  const files = (state?.files ?? [])
    .slice(0, exportCfg.maxFiles)
    .map((f) => formatPathForExport(f, { includeFilePaths: exportCfg.includeFilePaths, redactHomeDir: exportCfg.redactHomeDir }));
  const goal = (state?.currentGoal || '').trim();
  const nextSteps = state?.nextSteps ?? [];

  const shortForAgent: string[] = [];
  shortForAgent.push('# Threads - Context (Short)');
  shortForAgent.push('');
  if (goal) {
    shortForAgent.push(`Goal: ${goal}`);
  }
  if (files.length) {
    shortForAgent.push(`Files: ${files.slice(0, Math.min(8, files.length)).join(', ')}`);
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
  const checkpointReady =
    autoCheckpoint.enabled && checkpointSignalsSinceSnapshot > 0 && meaningfulScoreSinceSnapshot >= scoreThreshold;
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

async function revealFileInExplorer(filePath: string) {
  try {
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(filePath));
  } catch {
    try {
      await vscode.commands.executeCommand('workbench.files.action.showActiveFileInExplorer');
    } catch {
      // ignore
    }
  }
}

function normalizeSelectionState(selection: StoredSelection | undefined): SelectionState | null {
  if (!selection) {
    return null;
  }
  if ('anchor' in selection && 'active' in selection) {
    return selection;
  }
  return { anchor: selection, active: selection };
}

function applyCursorIfAvailable(editor: vscode.TextEditor | undefined, cursor: StoredSelection | undefined) {
  const normalized = normalizeSelectionState(cursor);
  if (!normalized) {
    return;
  }
  if (!editor || editor.document.uri.scheme !== 'file') {
    return;
  }
  const anchor = new vscode.Position(normalized.anchor.line, normalized.anchor.character);
  const active = new vscode.Position(normalized.active.line, normalized.active.character);
  editor.selection = new vscode.Selection(anchor, active);
  const reveal = new vscode.Range(active, active);
  editor.revealRange(reveal);
}

async function openFileBestEffort(
  filePath: string,
  options: { viewColumn?: number; preserveFocus?: boolean; cursor?: StoredSelection }
) {
  const doc = await vscode.workspace.openTextDocument(filePath);
  const viewColumn =
    typeof options.viewColumn === 'number' && options.viewColumn >= 1 ? (options.viewColumn as vscode.ViewColumn) : undefined;
  const editor = await vscode.window.showTextDocument(doc, {
    preview: false,
    preserveFocus: options.preserveFocus ?? false,
    viewColumn
  });
  applyCursorIfAvailable(editor, options.cursor);
}

async function resumeWhereILeftOff() {
  const rootPath = getWorkspaceRoot();
  if (!rootPath) {
    vscode.window.showWarningMessage('Threads: No workspace folder open.');
    return;
  }

  const state = await readLastSessionState();
  const openEditors =
    state?.openEditors?.length
      ? state.openEditors
      : (state?.openFiles?.length ? state.openFiles : state?.files ?? []).map((filePath) => ({
          filePath,
          viewColumn: undefined
        }));
  const openFiles = openEditors.map((e) => e.filePath);
  if (!openFiles.length) {
    vscode.window.showInformationMessage('Threads: No recent files recorded yet. Save a session first.');
    return;
  }

  logInfo(`Threads: Resume workspace (${openFiles.length} files recorded)`);

  const viewColumnByFile = new Map<string, number | undefined>();
  for (const editor of openEditors) {
    viewColumnByFile.set(editor.filePath, editor.viewColumn);
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

  const cursorForFile = (file: string) => state?.cursors?.[file];
  const active = state?.activeFile && existing.includes(state.activeFile) ? state.activeFile : null;
  const uniqueToOpen = Array.from(new Set(toOpen));
  const background = uniqueToOpen.filter((file) => file !== active);

  for (const file of background) {
    await openFileBestEffort(file, {
      viewColumn: viewColumnByFile.get(file),
      preserveFocus: true,
      cursor: cursorForFile(file)
    });
  }

  if (active) {
    await openFileBestEffort(active, {
      viewColumn: viewColumnByFile.get(active),
      preserveFocus: false,
      cursor: cursorForFile(active)
    });
    return;
  }

  const primary = uniqueToOpen[0];
  if (primary) {
    await openFileBestEffort(primary, {
      viewColumn: viewColumnByFile.get(primary),
      preserveFocus: false,
      cursor: cursorForFile(primary)
    });
  }
}

async function openAnchorFile() {
  const rootPath = getWorkspaceRoot();
  if (!rootPath) {
    vscode.window.showWarningMessage('Threads: No workspace folder open.');
    return;
  }

  const state = await readLastSessionState();
  const anchor = getAnchorFileFromState(state);
  if (!anchor) {
    vscode.window.showInformationMessage('Threads: No anchor file recorded yet. Save a session first.');
    return;
  }

  try {
    await fs.access(anchor);
  } catch {
    vscode.window.showInformationMessage('Threads: Anchor file is no longer present.');
    return;
  }

  const viewColumn = state?.openEditors?.find((e) => e.filePath === anchor)?.viewColumn;
  await revealFileInExplorer(anchor);
  await openFileBestEffort(anchor, { viewColumn, preserveFocus: false, cursor: state?.cursors?.[anchor] });
}

async function runLastTask() {
  const state = await readLastSessionState();
  const lastTask = state?.lastTask;
  if (!lastTask?.name) {
    vscode.window.showInformationMessage('Threads: No last task recorded yet.');
    return;
  }

  const tasks = await vscode.tasks.fetchTasks();
  const matches = tasks.filter((t) => {
    if (t.name !== lastTask.name) {
      return false;
    }
    if (!lastTask.taskId) {
      return true;
    }
    // best-effort match by task type if available
    const type = (t.definition as { type?: unknown } | undefined)?.type;
    return typeof type === 'string' ? type === lastTask.taskId : true;
  });

  if (!matches.length) {
    vscode.window.showInformationMessage('Threads: Last task not found in this workspace.');
    return;
  }

  if (matches.length === 1) {
    await vscode.tasks.executeTask(matches[0]);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    matches.map((t) => ({
      label: t.name,
      description: t.source,
      detail: (t.execution ? 'Runnable' : 'No execution') as string,
      task: t
    })),
    { title: 'Run last task', placeHolder: 'Select a task to run' }
  );
  if (!picked) {
    return;
  }
  await vscode.tasks.executeTask(picked.task);
}

async function buildAnchorSnippet(state: LastSessionState | null): Promise<string[] | null> {
  const { llm } = getConfig();
  if (!llm.includeCodeSnippets) {
    return null;
  }
  const anchor = getAnchorFileFromState(state);
  if (!anchor) {
    return null;
  }
  const selection = normalizeSelectionState(state?.cursors?.[anchor]);
  if (!selection) {
    return null;
  }
  try {
    const content = await fs.readFile(anchor, 'utf8');
    const lines = content.split(/\r?\n/);
    const center = Math.max(0, Math.min(lines.length - 1, selection.active.line));
    const start = Math.max(0, center - 2);
    const end = Math.min(lines.length, center + 3);
    const snippetLines = lines.slice(start, end).map((line, idx) => `${start + idx + 1}: ${line}`);
    return [`${path.basename(anchor)}:${center + 1}`, ...snippetLines];
  } catch {
    return null;
  }
}

async function writeHandoffExport(contents: string): Promise<string | null> {
  if (!dataDir) {
    return null;
  }
  try {
    const exportsDir = path.join(dataDir, 'exports');
    await fs.mkdir(exportsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(exportsDir, `context-handoff-${stamp}.md`);
    await fs.writeFile(target, contents, 'utf8');
    return target;
  } catch (err) {
    logError('Threads: Failed to write handoff export', err);
    return null;
  }
}

async function copyForLLM() {
  const rootPath = getWorkspaceRoot();
  if (!rootPath) {
    vscode.window.showWarningMessage('Threads: No workspace folder open.');
    return;
  }

  const modeItems: Array<vscode.QuickPickItem & { mode: HandoffMode }> = [
    { label: 'Compact', description: 'Default (<300 lines)', mode: 'compact' },
    { label: 'Debug-focused', description: 'Includes runtime state + last errors', mode: 'debug' },
    { label: 'Deep context', description: 'Adds recent snapshot history', mode: 'deep' }
  ];
  const mode = await vscode.window.showQuickPick(modeItems, {
    title: 'Copy for LLM',
    placeHolder: 'Choose a format (Compact is default)'
  });
  if (!mode) {
    return;
  }

  const { export: exportCfg } = getConfig();
  const state = await readLastSessionState();
  const snapshot = lastLoadedSnapshot ?? (await fetchLatestSnapshot(rootPath));
  if (!snapshot) {
    vscode.window.showInformationMessage('Threads: No snapshot available yet.');
    return;
  }

  const anchorFormatted = formatAnchorForHandoff(state, {
    includeFilePaths: exportCfg.includeFilePaths,
    redactHomeDir: true
  });
  const fileLimit = mode.mode === 'compact' ? Math.min(exportCfg.maxFiles, 6) : exportCfg.maxFiles;
  const files = Array.from(new Set(state?.files ?? [])).slice(0, fileLimit);
  const formattedFiles = files.map((f) =>
    formatPathForExport(f, { includeFilePaths: exportCfg.includeFilePaths, redactHomeDir: true })
  );
  const recentActions = (snapshot.completed_work ?? []).slice(0, 6);
  const nextStep = (snapshot.next_steps?.[0] ?? state?.nextSteps?.[0] ?? '').toString().trim();
  const debugNotes: string[] = [];
  if (exportCfg.includeTaskHistory && state?.lastTask?.name) {
    debugNotes.push(`Last task: ${state.lastTask.name}`);
  }
  if (lastDebugSession?.name) {
    debugNotes.push(`Last debug session: ${lastDebugSession.name}`);
  }
  if (runtimeMode === 'remote') {
    debugNotes.push('Runtime mode: remote (backend sync enabled)');
  } else {
    debugNotes.push('Runtime mode: local-only');
  }

  if (mode.mode === 'deep') {
    try {
      const adapter = storageAdapter ?? ensureStorageAdapter(rootPath);
      const history = await adapter.listSnapshots(rootPath, 5);
      if (history.length) {
        const historyLines = history.map((s) => {
          const when = new Date(s.created_at).toLocaleString();
          const hint = (s.current_goal || s.summary_text || '').toString().trim();
          return `${when} - ${hint || s.id}`;
        });
        debugNotes.push(`Recent snapshots: ${historyLines.join(' | ')}`);
      }
    } catch (err) {
      logError('Threads: Failed to fetch snapshot history for deep export', err);
    }
  }

  const snippets = (await buildAnchorSnippet(state)) ?? undefined;
  const handoff = await buildAgentHandoffText({
    mode: mode.mode,
    goal: (snapshot.current_goal || '').trim() || state?.currentGoal || '(unknown)',
    anchor: anchorFormatted ?? undefined,
    recentActions,
    whatChanged: formattedFiles.length ? [`Touched files: ${formattedFiles.slice(0, 5).join(', ')}`] : recentActions,
    openQuestions: snapshot.open_issues ?? [],
    nextStep: nextStep || '(not set)',
    constraints: snapshot.decisions ?? [],
    confidenceTag: (snapshot as any).confidence_tag ?? undefined,
    files: formattedFiles,
    debugNotes,
    lastError: lastBackendError ?? undefined,
    snippets
  });

  const compactLineLimit = 300;
  const handoffLines = handoff.split('\n');
  const finalText =
    mode.mode === 'compact' && handoffLines.length > compactLineLimit
      ? [...handoffLines.slice(0, compactLineLimit - 1), '...(trimmed to stay under 300 lines)'].join('\n')
      : handoff;

  logInfo(`Threads: Copy for LLM (${mode.mode})`);
  await vscode.env.clipboard.writeText(finalText);
  const exportPath = await writeHandoffExport(finalText);
  vscode.window.showInformationMessage(
    exportPath ? `Threads: Copied handoff (saved to ${exportPath}).` : 'Threads: Copied resume context for LLM.'
  );
}

async function configureLlm() {
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'None', description: 'Disable LLM usage', value: 'none' },
      { label: 'Ollama (local)', description: 'Privacy-first local model', value: 'ollama' },
      { label: 'OpenAI (BYO key)', description: 'Use your own OpenAI-compatible key', value: 'openai' }
    ],
    { title: 'Threads: Configure LLM', placeHolder: 'Choose a provider' }
  );
  if (!pick) {
    return;
  }

  const config = vscode.workspace.getConfiguration('threads');
  if (pick.value === 'none') {
    await config.update('llm.provider', 'none', vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('Threads: LLM disabled.');
    return;
  }

  if (pick.value === 'ollama') {
    const current = getConfig().llm;
    const url = await vscode.window.showInputBox({
      title: 'Ollama URL',
      value: current.ollamaUrl,
      prompt: 'Default is http://localhost:11434'
    });
    if (!url) {
      return;
    }
    const model = await vscode.window.showInputBox({
      title: 'Ollama model',
      value: current.ollamaModel,
      prompt: 'Example: llama3.1'
    });
    if (!model) {
      return;
    }
    await config.update('llm.provider', 'ollama', vscode.ConfigurationTarget.Global);
    await config.update('llm.ollamaUrl', url, vscode.ConfigurationTarget.Global);
    await config.update('llm.ollamaModel', model, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('Threads: Ollama configured.');
    return;
  }

  if (pick.value === 'openai') {
    const current = getConfig().llm;
    const apiKey = await vscode.window.showInputBox({
      title: 'OpenAI API key',
      prompt: 'Stored securely in VS Code SecretStorage',
      password: true,
      ignoreFocusOut: true
    });
    if (!apiKey) {
      return;
    }
    const model = await vscode.window.showInputBox({
      title: 'OpenAI model',
      value: current.openaiModel,
      prompt: 'Example: gpt-5.2-mini (change if unavailable)'
    });
    if (!model) {
      return;
    }
    const baseUrl = await vscode.window.showInputBox({
      title: 'OpenAI base URL (optional)',
      value: current.openaiBaseUrl,
      prompt: 'Leave blank for https://api.openai.com'
    });
    await extensionContext?.secrets.store('threads.openaiApiKey', apiKey);
    await config.update('llm.provider', 'openai', vscode.ConfigurationTarget.Global);
    await config.update('llm.openaiModel', model, vscode.ConfigurationTarget.Global);
    await config.update('llm.openaiBaseUrl', baseUrl ?? '', vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('Threads: OpenAI configured.');
  }
}

async function testLlmConnection() {
  const provider = await getLlmProvider();
  if (!provider || !provider.isConfigured()) {
    lastLlmTestStatus = 'Not configured';
    vscode.window.showWarningMessage('Threads: LLM provider not configured.');
    return;
  }
  const result = await provider.testConnection();
  lastLlmTestStatus = result.message;
  if (result.ok) {
    vscode.window.showInformationMessage(`Threads: ${result.message}`);
  } else {
    vscode.window.showErrorMessage(`Threads: ${result.message}`);
  }
}

async function openDataFolder() {
  if (!dataDir) {
    vscode.window.showWarningMessage('Threads: Data folder not available yet.');
    return;
  }
  await vscode.env.openExternal(vscode.Uri.file(dataDir));
}

async function deleteLocalData() {
  if (!dataDir) {
    vscode.window.showWarningMessage('Threads: Data folder not available yet.');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Delete local Threads data at ${dataDir}?`,
    { modal: true },
    'Delete'
  );
  if (choice !== 'Delete') {
    return;
  }
  try {
    await fs.rm(dataDir, { recursive: true, force: true });
    await extensionContext?.workspaceState.update('threads.didFirstCheckpoint', false);
    vscode.window.showInformationMessage('Threads: Local data deleted.');
  } catch (err) {
    logError('Threads: Failed to delete local data', err);
    vscode.window.showErrorMessage('Threads: Failed to delete local data.');
  }
}

async function sendFeedback(context: vscode.ExtensionContext) {
  const { feedback, runtimeMode: mode, remote } = getConfig();
  const backendUrl = mode === 'remote' ? remote.backendUrl : '(local mode)';
  const state = await readLastSessionState();
  const version = context.extension?.packageJSON?.version ?? 'unknown';
  const snapshotId = state?.snapshotId ?? lastSnapshotId ?? '(unknown)';
  const lastCheckpoint = lastSnapshotAtMs ? new Date(lastSnapshotAtMs).toISOString() : '(none)';

  const template = [
    '# Feedback',
    '',
    '## What happened',
    '- (describe the issue/idea)',
    '',
    '## Expected',
    '- (what you expected)',
    '',
    '## Context (auto)',
    `- Extension version: ${version}`,
    `- Runtime mode: ${mode}`,
    `- Data path: ${dataDir ?? '(unknown)'}`,
    `- Backend URL: ${backendUrl}`,
    `- Snapshot ID: ${snapshotId}`,
    `- Last checkpoint: ${lastCheckpoint}`,
    `- Last checkpoint reason: ${lastCheckpointReason ?? '(none)'}`,
    `- Last error: ${lastBackendError ?? '(none)'}`
  ].join('\n');

  const repo = (feedback.githubRepo || '').trim();
  if (repo) {
    const title = encodeURIComponent('Threads feedback');
    const body = encodeURIComponent(template);
    const url = `https://github.com/${repo}/issues/new?title=${title}&body=${body}`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return;
  }

  await vscode.env.clipboard.writeText(template);
  vscode.window.showInformationMessage('Threads: Feedback template copied to clipboard (configure threads.feedback.githubRepo to open GitHub issues).');
}

async function showStatusMenu() {
  const state = await readLastSessionState();
  const filesTouched = state?.files?.length ?? 0;
  const last = lastSnapshotAtMs ? new Date(lastSnapshotAtMs).toLocaleTimeString() : null;
  const subtitle = `${filesTouched} files${last ? ` | last checkpoint ${last}` : ''}`;

  const items: Array<vscode.QuickPickItem & { action?: string }> = [
    { label: 'Resume', kind: vscode.QuickPickItemKind.Separator },
    { label: 'Resume workspace', description: subtitle, action: 'resume' },
    { label: 'Open anchor file', description: 'Jump to your last active file', action: 'anchor' },
    { label: 'Review', kind: vscode.QuickPickItemKind.Separator },
    { label: 'Show last session', description: 'Opens the snapshot panel', action: 'show' },
    { label: 'Copy for LLM', description: 'Paste-ready resume context', action: 'llm' },
    { label: 'Run last task', description: 'Best-effort re-run last task', action: 'task' },
    { label: 'Snapshots', kind: vscode.QuickPickItemKind.Separator },
    { label: 'Save checkpoint', description: 'Saves a snapshot without ending the session', action: 'checkpoint' },
    { label: 'Save state now', description: 'Ends session + starts new', action: 'save' },
    { label: 'Browse snapshots', description: 'Pick from history', action: 'browse' },
    { label: 'Export', kind: vscode.QuickPickItemKind.Separator },
    { label: 'Export context bundle', description: 'Full file / copy / agent prompt', action: 'export' },
    { label: 'LLM', kind: vscode.QuickPickItemKind.Separator },
    { label: 'Configure LLM', description: 'Set provider + model', action: 'llm-config' },
    { label: 'Test LLM connection', description: 'Run a quick connectivity check', action: 'llm-test' },
    { label: 'Maintenance', kind: vscode.QuickPickItemKind.Separator },
    { label: 'Diagnostics', description: 'Shows runtime state', action: 'diag' },
    { label: 'Open data folder', description: 'Show local Threads data', action: 'open-data' },
    { label: 'Delete local data', description: 'Remove .threads data', action: 'delete-data' },
    { label: 'Send feedback', description: 'Opens/copies a feedback template', action: 'feedback' },
    { label: 'Show output log', description: 'Threads output channel', action: 'out' }
  ];

  const pick = await vscode.window.showQuickPick(items, { title: 'Threads', placeHolder: 'Choose an action' });
  if (!pick) {
    return;
  }
  if (pick.action === 'resume') {
    await resumeWhereILeftOff();
  } else if (pick.action === 'anchor') {
    await openAnchorFile();
  } else if (pick.action === 'show') {
    await showLatestSnapshot();
  } else if (pick.action === 'llm') {
    await copyForLLM();
  } else if (pick.action === 'task') {
    await runLastTask();
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
  } else if (pick.action === 'llm-config') {
    await configureLlm();
  } else if (pick.action === 'llm-test') {
    await testLlmConnection();
  } else if (pick.action === 'open-data') {
    await openDataFolder();
  } else if (pick.action === 'delete-data') {
    await deleteLocalData();
  } else if (pick.action === 'feedback') {
    if (extensionContext) {
      await sendFeedback(extensionContext);
    }
  } else if (pick.action === 'out') {
    getOutputChannel().show(true);
  }
}

async function showDiagnostics() {
  const { runtimeMode: mode, remote, llm, autoCheckpoint } = getConfig();
  const provider = await getLlmProvider();
  const llmConfigured = provider?.isConfigured() ?? false;
  const lines: string[] = [];
  lines.push('# Threads Diagnostics');
  lines.push('');
  const lastCheckpoint = lastSnapshotAtMs ? new Date(lastSnapshotAtMs).toLocaleString() : '(none)';
  const lastCheckpointLine = `${lastCheckpoint}${lastCheckpointReason ? ` (${lastCheckpointReason})` : ''}`;
  lines.push(`Runtime mode: \`${mode}\``);
  lines.push(`Data path: \`${dataDir ?? '(unknown)'}\``);
  lines.push(`Backend URL: \`${mode === 'remote' ? remote.backendUrl : '(local mode)'}\``);
  lines.push(`Session ID: \`${sessionId ?? '(none)'}\``);
  lines.push(`Last checkpoint: \`${lastCheckpointLine}\``);
  lines.push(`Pending events: \`${pendingEvents.length}\``);
  lines.push(`Last error: \`${lastBackendError ?? '(none)'}\``);
  lines.push(`LLM provider: \`${llm.provider}\``);
  lines.push(`LLM configured: \`${llmConfigured ? 'yes' : 'no'}\``);
  lines.push(`Last summary source: \`${lastSummarySource}\``);
  lines.push(`Last LLM test: \`${lastLlmTestStatus ?? '(none)'}\``);
  lines.push('');
  lines.push('## Activity');
  lines.push(`Events since checkpoint: \`${eventsSinceSnapshot}\``);
  lines.push(`Meaningful score since checkpoint: \`${meaningfulScoreSinceSnapshot}\``);
  lines.push(`Checkpoint signals since checkpoint: \`${checkpointSignalsSinceSnapshot}\``);
  lines.push(`Last activity: \`${new Date(lastActivityAtMs).toLocaleString()}\``);
  lines.push(`Last flush: \`${lastFlushAtMs ? new Date(lastFlushAtMs).toLocaleString() : '(none)'}\``);
  lines.push(`Last snapshot id: \`${lastSnapshotId ?? '(none)'}\``);
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
  logInfo('Threads: Diagnostics opened');
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
  if (!gitExtension) {
    logInfo('Threads: Git extension not available; branch change detection disabled.');
    return;
  }
  try {
    if (!gitExtension.isActive) {
      await gitExtension.activate();
    }
  } catch (err) {
    logInfo(`Threads: Git extension activation failed; branch change detection disabled. ${String(err)}`);
    return;
  }

  const anyExports = gitExtension.exports as { getAPI?: (version: number) => any } | undefined;
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
      const editorInfo = editors
        .filter((e) => e.document.uri.scheme === 'file')
        .map((e) => ({
          filePath: e.document.uri.fsPath,
          viewColumn: typeof e.viewColumn === 'number' ? e.viewColumn : undefined
        }))
        .filter((e) => !shouldIgnoreFile(e.filePath));
      openEditorsOrdered = editorInfo;
      openFilesOrdered = editorInfo.map((e) => e.filePath);
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
      const selection = e.selections?.[0];
      if (!selection) {
        return;
      }
      selectionByFile.set(filePath, {
        anchor: { line: selection.anchor.line, character: selection.anchor.character },
        active: { line: selection.active.line, character: selection.active.character }
      });
    }),
    vscode.tasks.onDidStartTaskProcess((e) => {
      lastTaskRun = { name: e.execution.task.name, taskId: e.execution.task.definition?.type ?? null };
      queueEvent('task_start', { name: e.execution.task.name, taskId: e.execution.task.definition?.type });
    }),
    vscode.tasks.onDidEndTaskProcess((e) => {
      lastTaskRun = { name: e.execution.task.name, taskId: e.execution.task.definition?.type ?? null };
      queueEvent('task_end', {
        name: e.execution.task.name,
        taskId: e.execution.task.definition?.type,
        exitCode: e.exitCode ?? null
      });
    }),
    vscode.debug.onDidStartDebugSession((debugSession) => {
      lastDebugSession = { name: debugSession.name, startedAt: new Date().toISOString() };
      queueEvent('debug_start', { name: debugSession.name, type: debugSession.type });
    }),
    vscode.debug.onDidTerminateDebugSession((debugSession) => {
      if (lastDebugSession?.name === debugSession.name) {
        lastDebugSession.endedAt = new Date().toISOString();
      } else {
        lastDebugSession = { name: debugSession.name, endedAt: new Date().toISOString() };
      }
      queueEvent('debug_end', { name: debugSession.name, type: debugSession.type });
    })
  );
}

export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showWarningMessage('Threads: Open a workspace folder to enable session tracking.');
    return;
  }

  threadsViewProvider = new ThreadsViewProvider(context.workspaceState);
  vscode.window.registerTreeDataProvider('threads.view', threadsViewProvider);

  await startSession(context);
  const existingState = await readLastSessionState();
  if (existingState?.savedAt) {
    await context.workspaceState.update('threads.didFirstCheckpoint', true);
    threadsViewProvider?.refresh();
  }
  ensureStatusBarItem(context);
  await refreshMomentumUI();
  void maybeShowResumePrompt();
  void maybeOpenSnapshotPanelOnStartup();
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
  const copyForLLMCommand = vscode.commands.registerCommand('threads.copyForLLM', copyForLLM);
  const openAnchorFileCommand = vscode.commands.registerCommand('threads.openAnchorFile', openAnchorFile);
  const runLastTaskCommand = vscode.commands.registerCommand('threads.runLastTask', runLastTask);
  const configureLlmCommand = vscode.commands.registerCommand('threads.configureLlm', configureLlm);
  const testLlmCommand = vscode.commands.registerCommand('threads.testLlmConnection', testLlmConnection);
  const openDataFolderCommand = vscode.commands.registerCommand('threads.openDataFolder', openDataFolder);
  const deleteLocalDataCommand = vscode.commands.registerCommand('threads.deleteLocalData', deleteLocalData);
  const sendFeedbackCommand = vscode.commands.registerCommand('threads.sendFeedback', async () => {
    await sendFeedback(context);
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
    checkpointNowCommand,
    copyForLLMCommand,
    openAnchorFileCommand,
    runLastTaskCommand,
    configureLlmCommand,
    testLlmCommand,
    openDataFolderCommand,
    deleteLocalDataCommand,
    sendFeedbackCommand
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
