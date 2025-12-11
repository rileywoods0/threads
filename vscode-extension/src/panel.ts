import * as vscode from 'vscode';

export class ThreadsPanel {
  public static currentPanel: ThreadsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
  }

  public static render(snapshot: any) {
    const column = vscode.ViewColumn.Active;

    if (ThreadsPanel.currentPanel) {
      ThreadsPanel.currentPanel.update(snapshot);
      ThreadsPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'threadsSnapshot',
      'Threads Memory Snapshot',
      column,
      { enableScripts: true }
    );

    ThreadsPanel.currentPanel = new ThreadsPanel(panel);
    ThreadsPanel.currentPanel.update(snapshot);

    panel.onDidDispose(() => {
      ThreadsPanel.currentPanel = undefined;
    });
  }

  private update(snapshot: any) {
    const content = snapshot
      ? `
        <h2>Current Goal</h2><p>${snapshot.current_goal || 'Not set'}</p>
        <h2>Completed Work</h2><ul>${(snapshot.completed_work || []).map((item: string) => `<li>${item}</li>`).join('')}</ul>
        <h2>Open Issues</h2><ul>${(snapshot.open_issues || []).map((item: string) => `<li>${item}</li>`).join('')}</ul>
        <h2>Next Steps</h2><ul>${(snapshot.next_steps || []).map((item: string) => `<li>${item}</li>`).join('')}</ul>
        <h2>Decisions</h2><ul>${(snapshot.decisions || []).map((item: string) => `<li>${item}</li>`).join('')}</ul>
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
