/**
 * Stub runner for GitHub Copilot — placeholder for future implementation.
 */

import type { AgentRunner, AgentContext, AgentResult } from './types.js';

export class CopilotStubRunner implements AgentRunner {
  readonly name = 'copilot';

  async run(_ctx: AgentContext): Promise<AgentResult> {
    return {
      success: false,
      filesChanged: [],
      summary: 'GitHub Copilot runner not yet implemented',
      error: 'STUB: GitHub Copilot integration requires Copilot Workspace API access',
    };
  }
}
