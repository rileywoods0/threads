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
function escapeHtml(value) {
    if (!value) {
        return '';
    }
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function renderList(items) {
    if (!items || items.length === 0) {
        return '<p class="muted">Nothing captured yet.</p>';
    }
    return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}
class ThreadsPanel {
    constructor(panel, snapshot) {
        this.panel = panel;
        this.snapshot = snapshot;
        this.registerMessageHandler();
    }
    static render(snapshot) {
        const column = vscode.ViewColumn.Active;
        if (ThreadsPanel.currentPanel) {
            ThreadsPanel.currentPanel.update(snapshot);
            ThreadsPanel.currentPanel.panel.reveal(column);
            return;
        }
        const panel = vscode.window.createWebviewPanel('threadsSnapshot', 'Threads – Last Session', column, { enableScripts: true });
        ThreadsPanel.currentPanel = new ThreadsPanel(panel, snapshot);
        ThreadsPanel.currentPanel.update(snapshot);
        panel.onDidDispose(() => {
            ThreadsPanel.currentPanel = undefined;
        });
    }
    registerMessageHandler() {
        this.panel.webview.onDidReceiveMessage(async (message) => {
            if (message?.type === 'copySummary' && this.snapshot?.summary_text) {
                await vscode.env.clipboard.writeText(this.snapshot.summary_text);
                vscode.window.showInformationMessage('Threads summary copied to clipboard.');
            }
        });
    }
    update(snapshot) {
        this.snapshot = snapshot;
        const content = snapshot
            ? `
        <section>
          <div class="header">Current Goal</div>
          <p>${escapeHtml(snapshot.current_goal || 'Not set')}</p>
        </section>
        <section>
          <div class="header">Completed Work</div>
          ${renderList(snapshot.completed_work)}
        </section>
        <section>
          <div class="header">Open Issues</div>
          ${renderList(snapshot.open_issues)}
        </section>
        <section>
          <div class="header">Next Steps</div>
          ${renderList(snapshot.next_steps)}
        </section>
        <section>
          <div class="header">Decisions</div>
          ${renderList(snapshot.decisions)}
        </section>
        <section>
          <div class="header">Summary</div>
          <p>${escapeHtml(snapshot.summary_text || '')}</p>
          <button id="copySummary">Copy summary to clipboard</button>
        </section>
      `
            : '<p class="muted">No snapshot available yet.</p>';
        this.panel.webview.html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <style>
          :root { color-scheme: light dark; }
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 1rem; }
          .header { font-weight: 600; margin-top: 1rem; letter-spacing: 0.02em; }
          ul { padding-left: 1.25rem; margin: 0.25rem 0; }
          p { margin: 0.25rem 0; }
          .muted { color: rgba(128, 128, 128, 0.9); }
          button {
            margin-top: 0.5rem;
            padding: 0.35rem 0.65rem;
            border: 1px solid rgba(128,128,128,0.4);
            border-radius: 4px;
          }
        </style>
      </head>
      <body>
        <h1>Threads – Last Session</h1>
        ${content}
        <script>
          const vscodeApi = acquireVsCodeApi();
          const copyButton = document.getElementById('copySummary');
          if (copyButton) {
            copyButton.addEventListener('click', () => {
              vscodeApi.postMessage({ type: 'copySummary' });
            });
          }
        </script>
      </body>
      </html>
    `;
    }
}
exports.ThreadsPanel = ThreadsPanel;
//# sourceMappingURL=panel.js.map