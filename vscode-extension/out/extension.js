"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const path = __importStar(require("path"));
const fs_1 = require("fs");
const vscode = __importStar(require("vscode"));
const panel_1 = require("./panel");
const threadsView_1 = require("./threadsView");
let sessionId = null;
let projectId = null;
let workspaceRoot = null;
let pendingEvents = [];
let flushTimer;
let statusBarItem;
let summaryFilePath = null;
let outputChannel;
let resumePromptShown = false;
function getConfig() {
    const config = vscode.workspace.getConfiguration('threads');
    return {
        backendUrl: config.get('backendUrl', 'http://localhost:8000'),
        flushIntervalMs: config.get('eventFlushIntervalMs', 5000),
        resumePrompt: config.get('resumePrompt', true)
    };
}
function getOutputChannel() {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Threads');
    }
    return outputChannel;
}
function logInfo(message) {
    getOutputChannel().appendLine(message);
    console.log(message);
}
function logError(message, err) {
    getOutputChannel().appendLine(`${message}${err ? `: ${String(err)}` : ''}`);
    console.error(message, err);
}
function ensureStatusBarItem(context) {
    if (!statusBarItem) {
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        statusBarItem.text = '$(clock) Threads';
        statusBarItem.tooltip = 'Threads is capturing session context.';
        statusBarItem.command = 'threads.showLastState';
        context.subscriptions.push(statusBarItem);
    }
    statusBarItem.show();
}
function queueEvent(event_type, data) {
    pendingEvents.push({
        event_type,
        timestamp: new Date().toISOString(),
        data
    });
}
function startFlushTimer(intervalMs) {
    if (flushTimer) {
        clearInterval(flushTimer);
    }
    flushTimer = setInterval(() => {
        void flushEvents();
    }, intervalMs);
}
function getWorkspaceRoot() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}
async function fetchJson(url, init) {
    const response = await fetch(url, init);
    if (!response.ok) {
        throw new Error(`status ${response.status}`);
    }
    return (await response.json());
}
async function startSession(context) {
    const rootPath = getWorkspaceRoot();
    if (!rootPath) {
        vscode.window.showWarningMessage('Threads: No workspace folder open.');
        return;
    }
    workspaceRoot = rootPath;
    summaryFilePath = path.join(rootPath, '.threads', 'last-session.md');
    const projectName = path.basename(rootPath);
    const { backendUrl } = getConfig();
    try {
        const payload = await fetchJson(`${backendUrl}/session/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ root_path: rootPath, project_name: projectName })
        });
        sessionId = payload.session_id;
        projectId = payload.project_id;
        context.workspaceState.update('threads.sessionId', sessionId);
        logInfo(`Threads: Started session ${sessionId} for ${rootPath}`);
        ensureStatusBarItem(context);
    }
    catch (err) {
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
    }
    catch (err) {
        logError('Threads: Failed to flush events', err);
        vscode.window.showErrorMessage('Threads: Failed to send events to backend.');
        pendingEvents.unshift(...eventsToSend);
    }
}
async function endSession(showNotification = false) {
    if (!sessionId) {
        return null;
    }
    const { backendUrl } = getConfig();
    await flushEvents();
    try {
        const snapshot = await fetchJson(`${backendUrl}/session/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId })
        });
        await persistLatestSnapshotMarkdown(snapshot);
        await persistSnapshotArchiveMarkdown(snapshot);
        panel_1.ThreadsPanel.render(snapshot);
        if (showNotification) {
            vscode.window.showInformationMessage('Threads saved your session snapshot.');
        }
        sessionId = null;
        return snapshot;
    }
    catch (err) {
        logError('Threads: Failed to end session', err);
        vscode.window.showErrorMessage('Threads: Failed to end session. Check backend logs for details.');
        return null;
    }
}
async function fetchLatestSnapshot(rootPath) {
    const { backendUrl } = getConfig();
    const response = await fetch(`${backendUrl}/project/latest_snapshot?root_path=${encodeURIComponent(rootPath)}`);
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`status ${response.status}`);
    }
    const payload = (await response.json());
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
        panel_1.ThreadsPanel.render(snapshot);
    }
    catch (err) {
        logError('Threads: Unable to load snapshot', err);
        vscode.window.showErrorMessage('Threads: Unable to load latest snapshot.');
    }
}
async function saveStateNow(context) {
    const snapshot = await endSession(true);
    if (!snapshot) {
        const choice = await vscode.window.showErrorMessage('Threads: Failed to save this session.', 'Retry', 'Start New Session Anyway');
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
function formatSnapshotMarkdown(snapshot) {
    const lines = [];
    lines.push('# Threads – Last Session');
    lines.push('');
    lines.push('## Current Goal');
    lines.push(snapshot.current_goal || 'Not set');
    lines.push('');
    const renderList = (title, items) => {
        lines.push(`## ${title}`);
        if (items && items.length) {
            for (const item of items) {
                lines.push(`- ${item}`);
            }
        }
        else {
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
function getSnapshotId(snapshot) {
    const anySnapshot = snapshot;
    return typeof anySnapshot.id === 'string' && anySnapshot.id.length ? anySnapshot.id : null;
}
async function writeSnapshotMarkdown(targetPath, snapshot) {
    await fs_1.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs_1.promises.writeFile(targetPath, formatSnapshotMarkdown(snapshot), 'utf8');
}
async function persistLatestSnapshotMarkdown(snapshot) {
    if (!summaryFilePath) {
        return;
    }
    try {
        await writeSnapshotMarkdown(summaryFilePath, snapshot);
    }
    catch (err) {
        logError('Threads: Failed to write last-session markdown', err);
    }
}
async function persistSnapshotArchiveMarkdown(snapshot) {
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
    }
    catch (err) {
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
        await fs_1.promises.access(summaryFilePath);
    }
    catch {
        try {
            const snapshot = await fetchLatestSnapshot(rootPath);
            if (!snapshot) {
                vscode.window.showInformationMessage('Threads: No snapshot available yet.');
                return;
            }
            await persistLatestSnapshotMarkdown(snapshot);
        }
        catch (err) {
            logError('Threads: Unable to create summary file from latest snapshot', err);
            vscode.window.showErrorMessage('Threads: Unable to create summary file. Is the backend running?');
            return;
        }
    }
    try {
        const doc = await vscode.workspace.openTextDocument(summaryFilePath);
        await vscode.window.showTextDocument(doc, { preview: false });
    }
    catch (err) {
        logError('Threads: Unable to open summary file', err);
        vscode.window.showErrorMessage('Threads: Unable to open summary file.');
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
        const list = await fetchJson(`${backendUrl}/project/snapshots?root_path=${encodeURIComponent(rootPath)}&limit=30`);
        if (!list.snapshots.length) {
            vscode.window.showInformationMessage('Threads: No snapshots available yet.');
            return;
        }
        const picked = await vscode.window.showQuickPick(list.snapshots.map((s) => {
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
        }), { title: 'Threads: Browse snapshots', matchOnDescription: true, matchOnDetail: true });
        if (!picked) {
            return;
        }
        const snapshot = await fetchJson(`${backendUrl}/snapshot/${encodeURIComponent(picked.snapshotId)}`);
        const archivePath = path.join(rootPath, '.threads', 'snapshots', `${picked.snapshotId}.md`);
        try {
            await writeSnapshotMarkdown(archivePath, snapshot);
        }
        catch (err) {
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
        panel_1.ThreadsPanel.render(snapshot);
    }
    catch (err) {
        logError('Threads: Unable to browse snapshots', err);
        vscode.window.showErrorMessage('Threads: Unable to browse snapshots. Is the backend running?');
    }
}
async function checkBackendHealth() {
    const { backendUrl } = getConfig();
    try {
        const payload = await fetchJson(`${backendUrl}/health`);
        vscode.window.showInformationMessage(`Threads backend: ${payload.status}`);
    }
    catch (err) {
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
            lastSessionMarkdown = await fs_1.promises.readFile(summaryFilePath, 'utf8');
        }
        catch {
            lastSessionMarkdown = '';
        }
    }
    if (!lastSessionMarkdown) {
        try {
            const snapshot = await fetchLatestSnapshot(rootPath);
            if (snapshot) {
                lastSessionMarkdown = formatSnapshotMarkdown(snapshot);
            }
        }
        catch (err) {
            logError('Threads: Unable to fetch latest snapshot for context bundle', err);
        }
    }
    let snapshots = [];
    try {
        const list = await fetchJson(`${backendUrl}/project/snapshots?root_path=${encodeURIComponent(rootPath)}&limit=10`);
        snapshots = list.snapshots;
    }
    catch (err) {
        logError('Threads: Unable to fetch snapshot list for context bundle', err);
    }
    const lines = [];
    lines.push('# Threads – Context Bundle');
    lines.push('');
    lines.push(`Workspace: ${rootPath}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('## Recent Snapshots (history)');
    if (!snapshots.length) {
        lines.push('- None found.');
    }
    else {
        for (const s of snapshots) {
            const when = new Date(s.created_at).toLocaleString();
            const hint = (s.current_goal || s.summary_text || '').toString().trim();
            lines.push(`- ${when} — ${hint || s.id}`);
        }
    }
    lines.push('');
    lines.push('## Last Session (full)');
    lines.push(lastSessionMarkdown || '_No last-session markdown available yet._');
    lines.push('');
    lines.push('> Tip: paste this file into Copilot Chat / Claude / ChatGPT when returning to the project to restore context quickly.');
    try {
        await fs_1.promises.mkdir(path.dirname(bundlePath), { recursive: true });
        await fs_1.promises.writeFile(bundlePath, lines.join('\n'), 'utf8');
        const doc = await vscode.workspace.openTextDocument(bundlePath);
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.window.showInformationMessage('Threads: Context bundle exported.');
    }
    catch (err) {
        logError('Threads: Failed to write context bundle markdown', err);
        vscode.window.showErrorMessage('Threads: Failed to export context bundle.');
    }
}
async function maybeShowResumePrompt() {
    const { resumePrompt } = getConfig();
    if (!resumePrompt || resumePromptShown) {
        return;
    }
    resumePromptShown = true;
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
        const choice = await vscode.window.showInformationMessage(message, 'Open Snapshot', 'Open Summary Markdown', 'Copy Summary');
        if (choice === 'Open Snapshot') {
            await showLatestSnapshot();
        }
        else if (choice === 'Open Summary Markdown') {
            await openOrCreateSummaryFile();
        }
        else if (choice === 'Copy Summary' && snapshot.summary_text) {
            await vscode.env.clipboard.writeText(snapshot.summary_text);
            vscode.window.showInformationMessage('Threads summary copied to clipboard.');
        }
    }
    catch (err) {
        logError('Threads: Resume prompt failed', err);
    }
}
function registerEventListeners(context) {
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => queueEvent('file_edit', { filePath: doc.uri.fsPath, languageId: doc.languageId })), vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document) {
            queueEvent('file_focus', { filePath: editor.document.uri.fsPath, languageId: editor.document.languageId });
        }
    }), vscode.debug.onDidStartDebugSession((debugSession) => queueEvent('debug_start', { name: debugSession.name, type: debugSession.type })), vscode.debug.onDidTerminateDebugSession((debugSession) => queueEvent('debug_end', { name: debugSession.name, type: debugSession.type })));
}
async function activate(context) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showWarningMessage('Threads: Open a workspace folder to enable session tracking.');
        return;
    }
    const viewProvider = new threadsView_1.ThreadsViewProvider();
    vscode.window.registerTreeDataProvider('threads.view', viewProvider);
    await startSession(context);
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
    context.subscriptions.push(showCommand, saveCommand, openSummaryCommand, browseCommand, healthCommand, showOutputCommand, exportBundleCommand);
    ensureStatusBarItem(context);
    logInfo(`Threads: Extension activated (projectId=${projectId ?? 'unknown'}).`);
}
async function deactivate() {
    if (flushTimer) {
        clearInterval(flushTimer);
    }
    await endSession();
}
//# sourceMappingURL=extension.js.map