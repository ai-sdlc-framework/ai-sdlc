/**
 * Stub runner for Devin — placeholder for future implementation.
 */

import type { AgentRunner, AgentContext, AgentResult } from './types.js';

export class DevinStubRunner implements AgentRunner {
  readonly name = 'devin';

  async run(_ctx: AgentContext): Promise<AgentResult> {
    return {
      success: false,
      filesChanged: [],
      summary: 'Devin runner not yet implemented',
      error: 'STUB: Devin integration requires Devin API access',
    };
  }
}
