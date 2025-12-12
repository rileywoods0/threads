import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';

class ThreadsTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    command?: vscode.Command,
    iconPath?: vscode.ThemeIcon,
    description?: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.command = command;
    this.iconPath = iconPath;
    this.description = description;
  }
}

type LastSessionState = {
  savedAt?: string;
  currentGoal?: string;
  files?: string[];
  nextSteps?: string[];
  snapshotId?: string;
};

export class ThreadsViewProvider implements vscode.TreeDataProvider<ThreadsTreeItem> {
  private readonly emitter = new vscode.EventEmitter<ThreadsTreeItem | undefined>();
  public readonly onDidChangeTreeData = this.emitter.event;

  refresh() {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: ThreadsTreeItem): vscode.TreeItem {
    return element;
  }

  private async readState(): Promise<LastSessionState | null> {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) {
      return null;
    }
    const statePath = path.join(rootPath, '.threads', 'last-session-state.json');
    try {
      const raw = await fs.readFile(statePath, 'utf8');
      const parsed = JSON.parse(raw) as LastSessionState;
      return parsed ?? null;
    } catch {
      return null;
    }
  }

  private formatAge(savedAt?: string): string | null {
    if (!savedAt) {
      return null;
    }
    const ts = Date.parse(savedAt);
    if (Number.isNaN(ts)) {
      return null;
    }
    const minutes = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (minutes < 60) {
      return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 48) {
      return `${hours}h ago`;
    }
    const days = Math.round(hours / 24);
    return `${days}d ago`;
  }

  private async getRecentSnapshotMarkdownItems(): Promise<ThreadsTreeItem[]> {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) {
      return [];
    }
    const snapshotsDir = path.join(rootPath, '.threads', 'snapshots');
    try {
      const entries = await fs.readdir(snapshotsDir);
      const mdFiles = entries.filter((f) => f.toLowerCase().endsWith('.md')).slice(0, 50);
      const withStats = await Promise.all(
        mdFiles.map(async (f) => {
          const full = path.join(snapshotsDir, f);
          const stat = await fs.stat(full);
          return { file: full, name: f, mtimeMs: stat.mtimeMs };
        })
      );
      withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const top = withStats.slice(0, 5);

      const items: ThreadsTreeItem[] = [];
      for (const snap of top) {
        const label = new Date(snap.mtimeMs).toLocaleString();
        items.push(
          new ThreadsTreeItem(
            label,
            {
              command: 'vscode.open',
              title: 'Open Snapshot Markdown',
              arguments: [vscode.Uri.file(snap.file)]
            },
            new vscode.ThemeIcon('file-text'),
            snap.name.replace('.md', '')
          )
        );
      }
      return items;
    } catch {
      return [];
    }
  }

  async getChildren(): Promise<ThreadsTreeItem[]> {
    const state = await this.readState();
    const fileCount = state?.files?.length ?? 0;
    const nextStepCount = state?.nextSteps?.length ?? 0;
    const age = this.formatAge(state?.savedAt);
    const goal = (state?.currentGoal || '').trim();
    const next = (state?.nextSteps?.[0] || '').trim();

    const resumeDescriptionParts = [];
    if (fileCount) {
      resumeDescriptionParts.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`);
    }
    if (nextStepCount) {
      resumeDescriptionParts.push(`${nextStepCount} step${nextStepCount === 1 ? '' : 's'}`);
    }
    if (age) {
      resumeDescriptionParts.push(age);
    }

    const resumeDescription = resumeDescriptionParts.join(' • ') || undefined;
    const resumeLabel = goal ? `Resume: ${goal}` : 'Resume Where I Left Off';

    const recentSnapshots = await this.getRecentSnapshotMarkdownItems();

    return [
      new ThreadsTreeItem(
        resumeLabel,
        { command: 'threads.resumeWhereILeftOff', title: 'Resume Where I Left Off' },
        new vscode.ThemeIcon('sparkle'),
        resumeDescription
      ),
      ...(goal
        ? [
            new ThreadsTreeItem('Goal', undefined, new vscode.ThemeIcon('target'), goal),
            ...(next ? [new ThreadsTreeItem('Next', undefined, new vscode.ThemeIcon('arrow-right'), next)] : [])
          ]
        : []),
      new ThreadsTreeItem(
        'Open Last Summary Markdown',
        { command: 'threads.openSummaryFile', title: 'Open Summary Markdown' },
        new vscode.ThemeIcon('markdown')
      ),
      new ThreadsTreeItem(
        'Browse Snapshots',
        { command: 'threads.browseSnapshots', title: 'Browse Snapshots' },
        new vscode.ThemeIcon('history')
      ),
      ...(recentSnapshots.length
        ? [new ThreadsTreeItem('Recent Snapshots (Markdown)', undefined, new vscode.ThemeIcon('history'))]
        : []),
      ...recentSnapshots,
      new ThreadsTreeItem(
        'Export Context Bundle (Markdown)',
        { command: 'threads.exportContextBundle', title: 'Export Context Bundle' },
        new vscode.ThemeIcon('package')
      ),
      new ThreadsTreeItem(
        'Save State Now',
        { command: 'threads.saveStateNow', title: 'Save State Now' },
        new vscode.ThemeIcon('save')
      ),
      new ThreadsTreeItem(
        'Check Backend Health',
        { command: 'threads.checkBackend', title: 'Check Backend Health' },
        new vscode.ThemeIcon('pulse')
      ),
      new ThreadsTreeItem(
        'Show Output Log',
        { command: 'threads.showOutput', title: 'Show Output Log' },
        new vscode.ThemeIcon('output')
      )
    ];
  }
}
