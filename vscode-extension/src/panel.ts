import * as vscode from 'vscode';

export type ThreadsSnapshot = {
  current_goal?: string | null;
  completed_work?: string[];
  open_issues?: string[];
  next_steps?: string[];
  decisions?: string[];
  summary_text?: string | null;
};

function escapeHtml(value: string | undefined | null): string {
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

function renderList(items?: string[]): string {
  if (!items || items.length === 0) {
    return '<p class="muted">Nothing captured yet.</p>';
  }
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

export class ThreadsPanel {
  public static currentPanel: ThreadsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private snapshot: ThreadsSnapshot | null;

  private constructor(panel: vscode.WebviewPanel, snapshot: ThreadsSnapshot | null) {
    this.panel = panel;
    this.snapshot = snapshot;
    this.registerMessageHandler();
  }

  public static render(snapshot: ThreadsSnapshot | null) {
    const column = vscode.ViewColumn.Active;

    if (ThreadsPanel.currentPanel) {
      ThreadsPanel.currentPanel.update(snapshot);
      ThreadsPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'threadsSnapshot',
      'Threads – Last Session',
      column,
      { enableScripts: true }
    );

    ThreadsPanel.currentPanel = new ThreadsPanel(panel, snapshot);
    ThreadsPanel.currentPanel.update(snapshot);

    panel.onDidDispose(() => {
      ThreadsPanel.currentPanel = undefined;
    });
  }

  private registerMessageHandler() {
    this.panel.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'copySummary' && this.snapshot?.summary_text) {
        await vscode.env.clipboard.writeText(this.snapshot.summary_text);
        vscode.window.showInformationMessage('Threads summary copied to clipboard.');
      }
    });
  }

  private update(snapshot: ThreadsSnapshot | null) {
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
