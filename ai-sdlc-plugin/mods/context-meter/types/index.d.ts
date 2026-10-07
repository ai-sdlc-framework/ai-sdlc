export type Totals = {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
};

export type MeterAction = 'compact' | 'clear' | 'handoff';

declare module 'claude-code' {
  interface PluginState {
    'context-meter': {
      totals: Totals;
      confirm: MeterAction | null;
      clearAfterHandoff: boolean;
    };
  }
}
