export type Totals = {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
};

export type HandoffState =
  | { phase: 'idle' }
  | { phase: 'armed' }
  | { phase: 'running'; turnId: string };

export type MeterAction = 'compact' | 'clear' | 'handoff';

declare module 'claude-code' {
  interface PluginState {
    'context-meter': {
      totals: Totals;
      confirm: MeterAction | null;
      handoff: HandoffState;
      note: string | null;
    };
  }
}
