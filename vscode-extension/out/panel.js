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
exports.ThreadsPanel = void 0;
const vscode = __importStar(require("vscode"));
class ThreadsPanel {
    constructor(panel) {
        this.panel = panel;
    }
    static render(snapshot) {
        const column = vscode.ViewColumn.Active;
        if (ThreadsPanel.currentPanel) {
            ThreadsPanel.currentPanel.update(snapshot);
            ThreadsPanel.currentPanel.panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel('threadsSnapshot', 'Threads Memory Snapshot', column, { enableScripts: true });
        ThreadsPanel.currentPanel = new ThreadsPanel(panel);
        ThreadsPanel.currentPanel.update(snapshot);
        panel.onDidDispose(() => {
            ThreadsPanel.currentPanel = undefined;
        });
    }
    update(snapshot) {
        const content = snapshot
            ? `
        <h2>Current Goal</h2><p>${snapshot.current_goal || 'Not set'}</p>
        <h2>Completed Work</h2><ul>${(snapshot.completed_work || []).map((item) => `<li>${item}</li>`).join('')}</ul>
        <h2>Open Issues</h2><ul>${(snapshot.open_issues || []).map((item) => `<li>${item}</li>`).join('')}</ul>
        <h2>Next Steps</h2><ul>${(snapshot.next_steps || []).map((item) => `<li>${item}</li>`).join('')}</ul>
        <h2>Decisions</h2><ul>${(snapshot.decisions || []).map((item) => `<li>${item}</li>`).join('')}</ul>
        <h2>Summary</h2><p>${snapshot.summary_text || ''}</p>
      `
            : '<p>No snapshot available yet.</p>';
        this.panel.webview.html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <style>
          body { font-family: sans-serif; padding: 1rem; }
          h2 { margin-top: 1rem; }
          ul { padding-left: 1.5rem; }
        </style>
      </head>
      <body>${content}</body>
      </html>
    `;
    }
}
exports.ThreadsPanel = ThreadsPanel;
//# sourceMappingURL=panel.js.map