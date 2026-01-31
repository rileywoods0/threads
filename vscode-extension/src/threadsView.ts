import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { promises as fs } from 'fs';

type LastSessionState = {
  savedAt?: string;
  currentGoal?: string;
  nextSteps?: string[];
  files?: string[];
  openFiles?: string[];
  openEditors?: Array<{ filePath: string; viewColumn?: number }>;
  activeFile?: string;
  cursors?: Record<
    string,
    | { line: number; character: number }
    | { anchor: { line: number; character: number }; active: { line: number; character: number } }
  >;
};

type NodeType =
  | 'firstRun'
  | 'firstRunInfo'
  | 'resume'
  | 'lastSession'
  | 'recentSnapshots'
  | 'moreActions'
  | 'info'
  | 'snapshotMd'
  | 'viewAll';

class ThreadsNode extends vscode.TreeItem {
  constructor(
    public readonly nodeType: NodeType,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
    public readonly payload?: unknown
  ) {
    super(label, collapsibleState);
  }
}

export class ThreadsViewProvider implements vscode.TreeDataProvider<ThreadsNode> {
  private readonly emitter = new vscode.EventEmitter<ThreadsNode | undefined>();
  public readonly onDidChangeTreeData = this.emitter.event;
  private readonly workspaceState: vscode.Memento;

  constructor(workspaceState: vscode.Memento) {
    this.workspaceState = workspaceState;
  }

  refresh() {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: ThreadsNode): vscode.TreeItem {
    return element;
  }

  private getRootPath(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  }

  private getDataDir(): string | null {
    const rootPath = this.getRootPath();
    if (!rootPath) return null;
    const config = vscode.workspace.getConfiguration('threads');
    const configured = config.get<string>('dataDir', '${workspaceFolder}/.threads');
    const substituted = configured.replace('${workspaceFolder}', rootPath);
    const expanded = substituted.startsWith('~') ? path.join(os.homedir(), substituted.slice(1)) : substituted;
    if (path.isAbsolute(expanded)) {
      return path.normalize(expanded);
    }
    return path.normalize(path.join(rootPath, expanded));
  }

  private formatAge(savedAt?: string): string | null {
    if (!savedAt) return null;
    const ts = Date.parse(savedAt);
    if (Number.isNaN(ts)) return null;
    const minutes = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
  }

  private async readState(): Promise<LastSessionState | null> {
    const dataDir = this.getDataDir();
    if (!dataDir) return null;
    const statePath = path.join(dataDir, 'last-session-state.json');
    try {
      const raw = await fs.readFile(statePath, 'utf8');
      return JSON.parse(raw) as LastSessionState;
    } catch {
      return null;
    }
  }

  private async getRecentSnapshotMarkdownNodes(limit: number): Promise<ThreadsNode[]> {
    const dataDir = this.getDataDir();
    if (!dataDir) return [];
    const snapshotsDir = path.join(dataDir, 'snapshots');

    try {
      const entries = await fs.readdir(snapshotsDir);
      const mdFiles = entries.filter((f) => f.toLowerCase().endsWith('.md'));
      const withStats = await Promise.all(
        mdFiles.map(async (f) => {
          const full = path.join(snapshotsDir, f);
          const stat = await fs.stat(full);
          return { file: full, name: f, mtimeMs: stat.mtimeMs };
        })
      );
      withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);

      return withStats.slice(0, limit).map((snap) => {
        const node = new ThreadsNode('snapshotMd', new Date(snap.mtimeMs).toLocaleString());
        node.iconPath = new vscode.ThemeIcon('history');
        node.description = snap.name.replace(/\.md$/i, '');
        node.command = {
          command: 'vscode.open',
          title: 'Open Snapshot Markdown',
          arguments: [vscode.Uri.file(snap.file)]
        };
        return node;
      });
    } catch {
      return [];
    }
  }

  async getChildren(element?: ThreadsNode): Promise<ThreadsNode[]> {
    if (!element) {
      const state = await this.readState();
      const age = this.formatAge(state?.savedAt);
      const goal = (state?.currentGoal || '').trim();
      const next = (state?.nextSteps?.[0] || '').trim();

      const didCheckpoint = Boolean(this.workspaceState.get('threads.didFirstCheckpoint', false));
      const firstRun = new ThreadsNode('firstRun', 'Getting started', vscode.TreeItemCollapsibleState.Collapsed);
      firstRun.iconPath = new vscode.ThemeIcon('info');
      firstRun.description = didCheckpoint ? undefined : 'Quick tips';

      const resume = new ThreadsNode('resume', 'Resume workspace');
      resume.iconPath = new vscode.ThemeIcon('play');
      resume.command = { command: 'threads.resumeWhereILeftOff', title: 'Resume workspace' };

      const lastSession = new ThreadsNode('lastSession', 'Last session', vscode.TreeItemCollapsibleState.Expanded);
      lastSession.iconPath = new vscode.ThemeIcon('clock');
      lastSession.description = age ?? undefined;

      const recent = new ThreadsNode('recentSnapshots', 'Recent snapshots', vscode.TreeItemCollapsibleState.Collapsed);
      recent.iconPath = new vscode.ThemeIcon('history');

      const more = new ThreadsNode('moreActions', 'More actions...');
      more.iconPath = new vscode.ThemeIcon('ellipsis');
      more.command = { command: 'threads.statusMenu', title: 'More actions' };

      // Keep the home view minimal. Goal/Next are shown under Last session.
      // Recent snapshots is collapsed by default for progressive disclosure.
      return (didCheckpoint ? [resume, lastSession, recent, more] : [firstRun, resume, lastSession, recent, more]).filter(Boolean);
    }

    if (element.nodeType === 'firstRun') {
      const resumeTip = new ThreadsNode('firstRunInfo', 'Resume workspace');
      resumeTip.description = 'Reopen files + cursor (best effort)';
      resumeTip.iconPath = new vscode.ThemeIcon('play');
      resumeTip.command = { command: 'threads.resumeWhereILeftOff', title: 'Resume workspace' };

      const copyTip = new ThreadsNode('firstRunInfo', 'Copy for LLM');
      copyTip.description = 'Paste-ready resume context';
      copyTip.iconPath = new vscode.ThemeIcon('copy');
      copyTip.command = { command: 'threads.copyForLLM', title: 'Copy for LLM' };

      const llmTip = new ThreadsNode('firstRunInfo', 'Configure LLM');
      llmTip.description = 'Optional: Ollama or BYO key';
      llmTip.iconPath = new vscode.ThemeIcon('sparkle');
      llmTip.command = { command: 'threads.configureLlm', title: 'Configure LLM' };

      const checkpointsTip = new ThreadsNode('firstRunInfo', 'Auto-checkpoints');
      checkpointsTip.description = 'Quiet snapshots while you work';
      checkpointsTip.iconPath = new vscode.ThemeIcon('history');
      checkpointsTip.command = { command: 'threads.diagnostics', title: 'Diagnostics' };

      return [resumeTip, copyTip, llmTip, checkpointsTip];
    }

    if (element.nodeType === 'lastSession') {
      const state = await this.readState();
      const goal = (state?.currentGoal || '').trim() || 'Not set yet';
      const next = (state?.nextSteps?.[0] || '').trim();
      const files = state?.files?.length ?? 0;
      const anchor =
        state?.activeFile ||
        state?.openEditors?.[0]?.filePath ||
        state?.openFiles?.[0] ||
        state?.files?.[0] ||
        '';
      const cursor = anchor ? state?.cursors?.[anchor] : undefined;
      const activeCursor =
        cursor && 'active' in cursor ? cursor.active : cursor && 'line' in cursor ? cursor : undefined;
      const line = typeof activeCursor?.line === 'number' ? activeCursor.line + 1 : null;
      const anchorLabel = anchor ? path.basename(anchor) : '';
      const anchorDesc = anchorLabel ? (line ? `${anchorLabel}:${line}` : anchorLabel) : 'Not set yet';

      const goalNode = new ThreadsNode('info', 'Goal');
      goalNode.description = goal;
      goalNode.iconPath = new vscode.ThemeIcon('target');

      const nextNode = new ThreadsNode('info', 'Next');
      nextNode.description = next || 'None recorded';
      nextNode.iconPath = new vscode.ThemeIcon('arrow-right');

      const filesNode = new ThreadsNode('info', 'Files touched');
      filesNode.description = files ? String(files) : '0';
      filesNode.iconPath = new vscode.ThemeIcon('files');

      const anchorNode = new ThreadsNode('info', 'Anchor');
      anchorNode.description = anchorDesc;
      anchorNode.iconPath = new vscode.ThemeIcon('pin');
      anchorNode.command = { command: 'threads.openAnchorFile', title: 'Open anchor file' };

      const openPanel = new ThreadsNode('info', 'Open snapshot panel');
      openPanel.iconPath = new vscode.ThemeIcon('preview');
      openPanel.command = { command: 'threads.showLastState', title: 'Show last state' };

      return [goalNode, nextNode, filesNode, anchorNode, openPanel];
    }

    if (element.nodeType === 'recentSnapshots') {
      const nodes = await this.getRecentSnapshotMarkdownNodes(5);
      const viewAll = new ThreadsNode('viewAll', 'View all...');
      viewAll.iconPath = new vscode.ThemeIcon('search');
      viewAll.command = { command: 'threads.browseSnapshots', title: 'Browse snapshots' };
      return [...nodes, viewAll];
    }

    return [];
  }
}
