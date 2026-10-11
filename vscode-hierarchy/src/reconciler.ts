/**
 * Pure roster-to-terminal reconciler. It owns no VS Code types: the extension adapter
 * hands it a narrow terminal API, so every rule here is unit-testable without the runtime.
 */

/** Handle of an opened terminal. */
export interface TerminalHandle {
  dispose(): void;
}

/** What to run in a terminal. */
export interface TerminalSpec {
  /** Agent (tmux window) name; also the terminal title. */
  name: string;
  /** Executable to launch. */
  command: string;
  /** Arguments, `[<cli-hierarchy.mjs>, 'attach', <name>]`. */
  args: string[];
  /** Focus the terminal when created. */
  focus: boolean;
}

/** The slice of the VS Code terminal API the reconciler needs. */
export interface TerminalApi {
  create(spec: TerminalSpec): TerminalHandle;
}

/** Reconciler configuration, read fresh on every call. */
export interface ReconcilerOptions {
  /** Absolute `cli-hierarchy.mjs` path, or undefined when none could be resolved. */
  resolveBin(): string | undefined;
  /** Node executable to run the bin with. */
  node?: string;
  /** Focus newly created terminals. */
  focusNew(): boolean;
}

/** Keeps one terminal per roster agent name. */
export class Reconciler {
  private readonly open = new Map<string, TerminalHandle>();
  /** Names whose terminal the user closed; not reopened until the next roster write. */
  private readonly closedByUser = new Set<string>();

  constructor(
    private readonly api: TerminalApi,
    private readonly options: ReconcilerOptions,
  ) {}

  /** Names that currently have a terminal. */
  openNames(): string[] {
    return [...this.open.keys()];
  }

  /**
   * Bring the terminals in line with `names`. `rosterWrite` is true when the roster file
   * changed (as opposed to a terminal-closed event or a settings change): it forgets which
   * terminals the user closed, so those agents are reopened.
   */
  reconcile(names: readonly string[], opts: { rosterWrite?: boolean } = {}): void {
    const wanted = new Set(names);
    if (opts.rosterWrite) this.closedByUser.clear();
    for (const name of this.closedByUser) if (!wanted.has(name)) this.closedByUser.delete(name);
    for (const [name, handle] of [...this.open]) {
      if (wanted.has(name)) continue;
      handle.dispose();
      this.open.delete(name);
    }
    for (const name of wanted) this.openOne(name);
  }

  /** Dispose every terminal (roster deleted, or the close-all command). */
  closeAll(): void {
    for (const handle of this.open.values()) handle.dispose();
    this.open.clear();
    this.closedByUser.clear();
  }

  /** Open every wanted agent, including ones the user closed (the open-all command). */
  openAll(names: readonly string[]): void {
    this.closedByUser.clear();
    this.reconcile(names);
  }

  /** The user closed the terminal behind `handle`; remember it so it is not reopened. */
  onTerminalClosed(handle: TerminalHandle): void {
    for (const [name, h] of this.open) {
      if (h !== handle) continue;
      this.open.delete(name);
      this.closedByUser.add(name);
      return;
    }
  }

  private openOne(name: string): void {
    if (this.open.has(name) || this.closedByUser.has(name)) return;
    const bin = this.options.resolveBin();
    if (!bin) return;
    const handle = this.api.create({
      name,
      command: this.options.node ?? 'node',
      args: [bin, 'attach', name],
      focus: this.options.focusNew(),
    });
    this.open.set(name, handle);
  }
}
