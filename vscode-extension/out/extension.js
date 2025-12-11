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
const vscode = __importStar(require("vscode"));
const panel_1 = require("./panel");
let sessionId = null;
let projectId = null;
let eventQueue = [];
let flushTimer = null;
function backendUrl() {
    const config = vscode.workspace.getConfiguration('threads');
    return config.get('backendUrl') || 'http://localhost:8000';
}
async function startSession(context) {
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
    }
    catch (err) {
        vscode.window.showErrorMessage(`Threads failed to start session: ${err}`);
    }
}
function queueEvent(event_type, data) {
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
    }
    catch (err) {
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
    }
    catch (err) {
        vscode.window.showErrorMessage(`Threads failed to end session: ${err}`);
    }
    finally {
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
        panel_1.ThreadsPanel.render(payload.snapshot);
    }
    catch (err) {
        vscode.window.showErrorMessage(`Unable to load Threads snapshot: ${err}`);
    }
}
function registerEventListeners(context) {
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => queueEvent('save', { filePath: doc.uri.fsPath })), vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document) {
            queueEvent('activeEditor', { filePath: editor.document.uri.fsPath });
        }
    }), vscode.debug.onDidStartDebugSession((debugSession) => queueEvent('debugStart', { name: debugSession.name })), vscode.debug.onDidTerminateDebugSession((debugSession) => queueEvent('debugStop', { name: debugSession.name })));
}
async function activate(context) {
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
async function deactivate() {
    if (flushTimer) {
        clearInterval(flushTimer);
    }
    await endSession();
}
//# sourceMappingURL=extension.js.map