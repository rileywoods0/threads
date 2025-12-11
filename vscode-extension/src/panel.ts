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
        <header class="hero">
          <div>
            <p class="eyebrow">Threads Session Snapshot</p>
            <h1>Last Session at a Glance</h1>
            <p class="muted">Instant context so you can pick up right where you left off.</p>
          </div>
          ${
            snapshot.summary_text
              ? '<button id="copySummary" class="ghost">Copy summary</button>'
              : ''
          }
        </header>

        <div class="grid">
          <section class="card accent">
            <div class="header">Current Goal</div>
            <p>${escapeHtml(snapshot.current_goal || 'Not set')}</p>
          </section>
          <section class="card">
            <div class="header">Completed Work</div>
            ${renderList(snapshot.completed_work)}
          </section>
          <section class="card">
            <div class="header">Open Issues</div>
            ${renderList(snapshot.open_issues)}
          </section>
          <section class="card">
            <div class="header">Next Steps</div>
            ${renderList(snapshot.next_steps)}
          </section>
          <section class="card">
            <div class="header">Decisions</div>
            ${renderList(snapshot.decisions)}
          </section>
          <section class="card wide">
            <div class="header">Summary</div>
            <p class="summary">${escapeHtml(snapshot.summary_text || '')}</p>
          </section>
        </div>
      `
      : `
        <div class="empty">
          <h1>No snapshot yet</h1>
          <p class="muted">Save a session to see your project state here.</p>
        </div>
      `;

    this.panel.webview.html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <style>
          :root {
            color-scheme: light dark;
            --bg: radial-gradient(circle at 20% 20%, rgba(38, 120, 166, 0.18), transparent 30%), radial-gradient(circle at 80% 0%, rgba(236, 185, 53, 0.25), transparent 28%), #0e1324;
            --card: rgba(255, 255, 255, 0.04);
            --border: rgba(255, 255, 255, 0.08);
            --accent: #5fd1b9;
            --text: #e7ecf2;
            --muted: rgba(231, 236, 242, 0.75);
          }
          body {
            font-family: 'Sora', 'Inter', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
            background: var(--bg);
            color: var(--text);
            padding: 1.5rem;
            margin: 0;
          }
          h1 { margin: 0 0 0.35rem; letter-spacing: 0.01em; }
          .hero {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 1rem;
            padding: 1rem 1.25rem;
            border: 1px solid var(--border);
            border-radius: 12px;
            background: linear-gradient(135deg, rgba(95, 209, 185, 0.14), rgba(14, 19, 36, 0.9));
          }
          .eyebrow {
            text-transform: uppercase;
            font-size: 0.75rem;
            letter-spacing: 0.12em;
            color: var(--accent);
            margin: 0 0 0.1rem 0;
          }
          .grid {
            margin-top: 1rem;
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 0.75rem;
          }
          .card {
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 0.9rem 1rem;
            background: var(--card);
            backdrop-filter: blur(8px);
          }
          .card.accent {
            border-color: rgba(95, 209, 185, 0.5);
            box-shadow: 0 10px 30px rgba(95, 209, 185, 0.15);
          }
          .card.wide { grid-column: span 2; }
          .header { font-weight: 700; margin-bottom: 0.35rem; letter-spacing: 0.04em; }
          ul { padding-left: 1.1rem; margin: 0.35rem 0 0; }
          li { margin: 0.2rem 0; }
          p { margin: 0.25rem 0; }
          .muted { color: var(--muted); }
          .summary { line-height: 1.5; white-space: pre-wrap; }
          .ghost {
            background: transparent;
            border: 1px solid rgba(95, 209, 185, 0.6);
            color: var(--text);
            padding: 0.45rem 0.8rem;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.15s ease;
          }
          .ghost:hover { background: rgba(95, 209, 185, 0.12); }
          .empty {
            text-align: center;
            padding: 2rem;
            border: 1px dashed var(--border);
            border-radius: 12px;
            background: rgba(255, 255, 255, 0.02);
          }
          @media (max-width: 720px) {
            .hero { flex-direction: column; align-items: flex-start; }
            .card.wide { grid-column: span 1; }
          }
        </style>
      </head>
      <body>
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
