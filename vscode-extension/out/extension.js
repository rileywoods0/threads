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
const vscode = __importStar(require("vscode"));
const panel_1 = require("./panel");
let sessionId = null;
let projectId = null;
let pendingEvents = [];
let flushTimer;
let statusBarItem;
function getConfig() {
    const config = vscode.workspace.getConfiguration('threads');
    return {
        backendUrl: config.get('backendUrl', 'http://localhost:8000'),
        flushIntervalMs: config.get('eventFlushIntervalMs', 5000)
    };
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
async function startSession(context) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showWarningMessage('Threads: No workspace folder open.');
        return;
    }
    const rootPath = workspaceFolder.uri.fsPath;
    const projectName = path.basename(rootPath);
    const { backendUrl } = getConfig();
    try {
        const response = await fetch(`${backendUrl}/session/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ root_path: rootPath, project_name: projectName })
        });
        if (!response.ok) {
            throw new Error(`status ${response.status}`);
        }
        const payload = (await response.json());
        sessionId = payload.session_id;
        projectId = payload.project_id;
        context.workspaceState.update('threads.sessionId', sessionId);
        console.log(`Threads: Started session ${sessionId} for ${rootPath}`);
        ensureStatusBarItem(context);
    }
    catch (err) {
        console.error('Threads: Failed to start session', err);
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
        await fetch(`${backendUrl}/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId, events: eventsToSend })
        });
        console.log(`Threads: Flushed ${eventsToSend.length} events.`);
    }
    catch (err) {
        console.error('Threads: Failed to flush events', err);
        vscode.window.showErrorMessage('Threads: Failed to send events to backend.');
        pendingEvents.unshift(...eventsToSend);
    }
}
async function endSession(showNotification = false) {
    if (!sessionId) {
        return;
    }
    const { backendUrl } = getConfig();
    await flushEvents();
    try {
        await fetch(`${backendUrl}/session/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId })
        });
        if (showNotification) {
            vscode.window.showInformationMessage('Threads saved your session snapshot.');
        }
    }
    catch (err) {
        console.error('Threads: Failed to end session', err);
        vscode.window.showErrorMessage('Threads: Failed to end session.');
    }
    finally {
        sessionId = null;
    }
}
async function showLatestSnapshot() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showWarningMessage('Threads: No workspace folder open.');
        return;
    }
    const rootPath = workspaceFolder.uri.fsPath;
    const { backendUrl } = getConfig();
    try {
        const response = await fetch(`${backendUrl}/project/latest_snapshot?root_path=${encodeURIComponent(rootPath)}`);
        if (response.status === 404) {
            vscode.window.showInformationMessage('Threads: No snapshot available yet.');
            return;
        }
        if (!response.ok) {
            throw new Error(`status ${response.status}`);
        }
        const payload = (await response.json());
        panel_1.ThreadsPanel.render(payload.snapshot);
    }
    catch (err) {
        console.error('Threads: Unable to load snapshot', err);
        vscode.window.showErrorMessage('Threads: Unable to load latest snapshot.');
    }
}
async function saveStateNow(context) {
    await endSession(true);
    await startSession(context);
    vscode.window.showInformationMessage('Threads: Session saved and a new one has started.');
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
    await startSession(context);
    registerEventListeners(context);
    const { flushIntervalMs } = getConfig();
    startFlushTimer(flushIntervalMs);
    const showCommand = vscode.commands.registerCommand('threads.showLastState', showLatestSnapshot);
    const saveCommand = vscode.commands.registerCommand('threads.saveStateNow', async () => {
        await saveStateNow(context);
    });
    context.subscriptions.push(showCommand, saveCommand);
    ensureStatusBarItem(context);
}
async function deactivate() {
    if (flushTimer) {
        clearInterval(flushTimer);
    }
    await endSession();
}
//# sourceMappingURL=extension.js.map