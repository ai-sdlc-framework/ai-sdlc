/**
 * VS Code adapter: watches each roster file and feeds the pure `Reconciler`. All rules
 * live in reconciler.ts and roster.ts; this file only maps them onto the `vscode` API.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as vscode from 'vscode';

import { Reconciler, type TerminalHandle } from './reconciler.js';
import { findRosterFiles, parseRosterNames, repoRootOf, resolveHierarchyBin } from './roster.js';
import type { RosterFs } from './roster.js';

const realFs: RosterFs = {
  exists: (p) => fs.existsSync(p),
  subdirs: (dir) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  },
};

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('aiSdlc.hierarchy');
}

export function activate(context: vscode.ExtensionContext): void {
  context.environmentVariableCollection.replace('AI_SDLC_VSCODE_HIERARCHY', '1');

  const handles = new Map<TerminalHandle, vscode.Terminal>();
  const reconcilers = new Map<string, Reconciler>();

  const terminalApi = (cwd: string) => ({
    create: (spec: { name: string; command: string; args: string[]; focus: boolean }) => {
      const terminal = vscode.window.createTerminal({
        name: spec.name,
        shellPath: spec.command,
        shellArgs: spec.args,
        cwd,
        isTransient: true,
      });
      terminal.show(!spec.focus);
      const handle: TerminalHandle = { dispose: () => terminal.dispose() };
      handles.set(handle, terminal);
      return handle;
    },
  });

  const reconcilerFor = (rosterFile: string): Reconciler => {
    let r = reconcilers.get(rosterFile);
    if (!r) {
      const root = repoRootOf(rosterFile);
      r = new Reconciler(terminalApi(root), {
        resolveBin: () =>
          resolveHierarchyBin({
            repoRoot: root,
            homeDir: os.homedir(),
            setting: config().get<string>('pipelineCliBin', ''),
            fs: realFs,
          }),
        focusNew: () => config().get<boolean>('focusNew', false),
      });
      reconcilers.set(rosterFile, r);
    }
    return r;
  };

  const sync = (rosterFile: string, rosterWrite: boolean): void => {
    if (!config().get<boolean>('autoOpen', true)) return;
    const r = reconcilerFor(rosterFile);
    if (!fs.existsSync(rosterFile)) {
      r.closeAll();
      return;
    }
    let text: string;
    try {
      text = fs.readFileSync(rosterFile, 'utf-8');
    } catch {
      return;
    }
    const names = parseRosterNames(text);
    if (names) r.reconcile(names, { rosterWrite });
  };

  const folders = (): string[] =>
    (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const rosters = (): string[] => findRosterFiles(folders(), realFs);

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '{.ai-sdlc,*/.ai-sdlc}/dispatch/hierarchy.json'),
    );
    const onChange = (uri: vscode.Uri): void => sync(uri.fsPath, true);
    watcher.onDidCreate(onChange);
    watcher.onDidChange(onChange);
    watcher.onDidDelete(onChange);
    context.subscriptions.push(watcher);
  }

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      for (const [handle, t] of handles) {
        if (t !== terminal) continue;
        handles.delete(handle);
        for (const [file, r] of reconcilers) {
          r.onTerminalClosed(handle);
          sync(file, false);
        }
        return;
      }
    }),
    vscode.commands.registerCommand('aiSdlc.hierarchy.openAll', () => {
      for (const file of rosters()) {
        let text: string;
        try {
          text = fs.readFileSync(file, 'utf-8');
        } catch {
          continue;
        }
        const names = parseRosterNames(text);
        if (names) reconcilerFor(file).openAll(names);
      }
    }),
    vscode.commands.registerCommand('aiSdlc.hierarchy.closeAll', () => {
      for (const r of reconcilers.values()) r.closeAll();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aiSdlc.hierarchy')) for (const f of rosters()) sync(f, false);
    }),
  );

  for (const file of rosters()) sync(file, true);
}

export function deactivate(): void {}
