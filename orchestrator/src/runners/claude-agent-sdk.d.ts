/**
 * Minimal type declarations for @anthropic-ai/claude-agent-sdk.
 * The SDK is an optional peer dependency — used only by ClaudeCodeSdkRunner.
 */
declare module '@anthropic-ai/claude-agent-sdk' {
  export function query(params: {
    prompt: string;
    options?: Record<string, unknown>;
  }): AsyncIterable<Record<string, unknown>>;
}
