import * as vscode from 'vscode';
import { ThreadsPanel } from './panel';

type EventPayload = {
  event_type: string;
  timestamp: string;
  data: Record<string, unknown>;
};

let sessionId: string | null = null;
let projectId: string | null = null;
let eventQueue: EventPayload[] = [];
let flushTimer: NodeJS.Timer | null = null;

function backendUrl(): string {
  const config = vscode.workspace.getConfiguration('threads');
  return config.get<string>('backendUrl') || 'http://localhost:8000';
}

async function startSession(context: vscode.ExtensionContext) {
  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const projectName = vscode.workspace.workspaceFolders?.[0]?.name || 'Untitled Project';
  if (!rootPath) {
    vscode.window.showWarningMessage('Threads could not determine the workspace root.');
    return;
  }

  try {
    const response = await fetch(`${backendUrl()}/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root_path: rootPath, project_name: projectName })
    });
    const payload = await response.json();
    sessionId = payload.session_id;
    projectId = payload.project_id;
    context.workspaceState.update('threads.sessionId', sessionId);
  } catch (err) {
    vscode.window.showErrorMessage(`Threads failed to start session: ${err}`);
  }
}

function queueEvent(event_type: string, data: Record<string, unknown>) {
  eventQueue.push({
    event_type,
    timestamp: new Date().toISOString(),
    data
  });
}

async function flushEvents() {
  if (!sessionId || eventQueue.length === 0) {
    return;
  }
  const pending = [...eventQueue];
  eventQueue = [];

  try {
    await fetch(`${backendUrl()}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, events: pending })
    });
  } catch (err) {
    vscode.window.showErrorMessage(`Threads failed to send events: ${err}`);
    eventQueue.unshift(...pending);
  }
}

async function endSession(showNotification = false) {
  if (!sessionId) {
    return;
  }

  await flushEvents();

  try {
    await fetch(`${backendUrl()}/session/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId })
    });
    if (showNotification) {
      vscode.window.showInformationMessage('Threads saved your session snapshot.');
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Threads failed to end session: ${err}`);
  } finally {
    sessionId = null;
  }
}

async function showLatestSnapshot() {
  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!rootPath) {
    vscode.window.showWarningMessage('Threads could not determine the workspace root.');
    return;
  }

  try {
    const response = await fetch(`${backendUrl()}/project/latest_snapshot?root_path=${encodeURIComponent(rootPath)}`);
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
    const payload = await response.json();
    ThreadsPanel.render(payload.snapshot);
  } catch (err) {
    vscode.window.showErrorMessage(`Unable to load Threads snapshot: ${err}`);
  }
}

function registerEventListeners(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) =>
      queueEvent('save', { filePath: doc.uri.fsPath })
    ),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document) {
        queueEvent('activeEditor', { filePath: editor.document.uri.fsPath });
      }
    }),
    vscode.debug.onDidStartDebugSession((debugSession) =>
      queueEvent('debugStart', { name: debugSession.name })
    ),
    vscode.debug.onDidTerminateDebugSession((debugSession) =>
      queueEvent('debugStop', { name: debugSession.name })
    )
  );
}

export async function activate(context: vscode.ExtensionContext) {
  await startSession(context);
  registerEventListeners(context);

  flushTimer = setInterval(() => {
    flushEvents();
  }, 5000);

  const showCommand = vscode.commands.registerCommand('threads.showLastState', showLatestSnapshot);
  const saveCommand = vscode.commands.registerCommand('threads.saveStateNow', async () => {
    await endSession(true);
  });

  context.subscriptions.push(showCommand, saveCommand);
}

export async function deactivate() {
  if (flushTimer) {
    clearInterval(flushTimer);
  }
  await endSession();
}
