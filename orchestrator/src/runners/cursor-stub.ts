/**
 * Stub runner for Cursor — placeholder for future implementation.
 */

import type { AgentRunner, AgentContext, AgentResult } from './types.js';

export class CursorStubRunner implements AgentRunner {
  readonly name = 'cursor';

  async run(_ctx: AgentContext): Promise<AgentResult> {
    return {
      success: false,
      filesChanged: [],
      summary: 'Cursor runner not yet implemented',
      error: 'STUB: Cursor integration requires Cursor Agent API access',
    };
  }
}
