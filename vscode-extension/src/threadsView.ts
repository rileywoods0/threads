import * as vscode from 'vscode';

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

export class ThreadsViewProvider implements vscode.TreeDataProvider<ThreadsTreeItem> {
  private readonly emitter = new vscode.EventEmitter<ThreadsTreeItem | undefined>();
  public readonly onDidChangeTreeData = this.emitter.event;

  refresh() {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: ThreadsTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ThreadsTreeItem[] {
    return [
      new ThreadsTreeItem(
        'Resume / Last Snapshot',
        { command: 'threads.showLastState', title: 'Show Last State' },
        new vscode.ThemeIcon('sparkle')
      ),
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
