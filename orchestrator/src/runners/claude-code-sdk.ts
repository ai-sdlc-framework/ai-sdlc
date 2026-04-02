/**
 * Claude Code SDK runner — invokes Claude Code via the Agent SDK's query() API
 * instead of spawning a CLI subprocess.
 *
 * Advantages over ClaudeCodeRunner:
 * - maxBudgetUsd / maxTurns — hard limits enforced by the engine
 * - allowedTools / disallowedTools — fine-grained tool filtering with glob patterns
 * - appendSystemPrompt — inject governance without replacing Claude Code defaults
 * - Structured NDJSON messages — no stdout parsing
 */

import type { AgentRunner, AgentContext, AgentResult, TokenUsage } from './types.js';
import { buildPrompt } from './claude-code.js';
import { detectChangedFiles, gitExec, runAutoFix } from './git-utils.js';
import {
  DEFAULT_MODEL,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_LINT_COMMAND,
  DEFAULT_FORMAT_COMMAND,
  DEFAULT_COMMIT_MESSAGE_TEMPLATE,
  DEFAULT_COMMIT_CO_AUTHOR,
} from '../defaults.js';

/** Default budget cap per agent run. */
const DEFAULT_MAX_BUDGET_USD = 5.0;

/** Default turn limit per agent run. */
const DEFAULT_MAX_TURNS = 100;

/**
 * Map agent-role tool names to SDK-compatible tool filter patterns.
 */
/** @internal Exported for testing. */
export function mapToolsToSdkFormat(allowedTools?: string[]): string[] | undefined {
  if (!allowedTools) return undefined;
  // SDK accepts tool names directly or glob patterns like Bash(git:*)
  return allowedTools;
}

/**
 * Build tool deny-list from blocked actions.
 * Converts blockedActions glob patterns to SDK disallowedTools format.
 */
/** @internal Exported for testing. */
export function mapBlockedActionsToSdkDenyList(blockedActions?: string[]): string[] {
  if (!blockedActions || blockedActions.length === 0) return [];
  // Map each blocked action pattern to a Bash() deny rule
  return blockedActions.map((pattern) => `Bash(${pattern})`);
}

/**
 * Build governance system prompt appendix from constraints.
 */
/** @internal Exported for testing. */
export function buildGovernancePrompt(ctx: AgentContext): string {
  const lines: string[] = ['## AI-SDLC Governance Constraints\n'];

  if (ctx.constraints.blockedPaths.length > 0) {
    lines.push(`Blocked paths (do NOT modify): ${ctx.constraints.blockedPaths.join(', ')}`);
  }
  if (ctx.constraints.blockedActions && ctx.constraints.blockedActions.length > 0) {
    lines.push(
      `Blocked actions (NEVER execute): ${ctx.constraints.blockedActions.map((a) => `\`${a}\``).join(', ')}`,
    );
  }
  lines.push(`Max files per change: ${ctx.constraints.maxFilesPerChange}`);
  if (ctx.constraints.requireTests) {
    lines.push('Tests required: every new module must have tests.');
  }
  lines.push('');
  lines.push('**NEVER merge PRs. Only humans merge.**');

  return lines.join('\n');
}

export class ClaudeCodeSdkRunner implements AgentRunner {
  async run(ctx: AgentContext): Promise<AgentResult> {
    // Dynamic import — SDK is an optional peer dependency
    let query: (params: {
      prompt: string;
      options?: Record<string, unknown>;
    }) => AsyncIterable<Record<string, unknown>>;

    /* v8 ignore start — dynamic import fails in unit tests (SDK not installed) */
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      query = sdk.query;
    } catch {
      return {
        success: false,
        filesChanged: [],
        summary: '',
        error:
          '@anthropic-ai/claude-agent-sdk is not installed. Install it to use the SDK runner: pnpm add @anthropic-ai/claude-agent-sdk',
      };
    }
    /* v8 ignore stop */

    const prompt = buildPrompt(ctx);
    const model = ctx.model ?? DEFAULT_MODEL;
    const maxTurns = ctx.constraints.maxTurns ?? DEFAULT_MAX_TURNS;
    const maxBudgetUsd = ctx.constraints.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
    const allowedTools = mapToolsToSdkFormat(ctx.allowedTools ?? DEFAULT_ALLOWED_TOOLS.split(','));
    const disallowedTools = mapBlockedActionsToSdkDenyList(ctx.constraints.blockedActions);

    const governancePrompt = buildGovernancePrompt(ctx);

    let summary = '';
    let tokenUsage: TokenUsage | undefined;

    /* v8 ignore start — SDK streaming loop requires real SDK connection */
    try {
      const result = query({
        prompt,
        options: {
          model,
          maxTurns,
          maxBudgetUsd,
          appendSystemPrompt: governancePrompt,
          allowedTools,
          disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
          permissionMode: 'acceptEdits',
          cwd: ctx.workDir,
        },
      });

      for await (const msg of result) {
        const msgType = msg.type as string;

        // Emit progress events
        if (msgType === 'assistant' && ctx.onProgress) {
          const blocks = (msg.message as Record<string, unknown>)?.content as
            | Array<Record<string, unknown>>
            | undefined;
          if (blocks) {
            for (const block of blocks) {
              if (block.type === 'tool_use') {
                ctx.onProgress({
                  type: 'tool_start',
                  tool: block.name as string,
                  message: `${block.name}`,
                });
              } else if (block.type === 'text') {
                summary = ((block.text as string) ?? '').slice(0, 2000);
              }
            }
          }
        }

        // Parse result event for token usage and cost
        if (msgType === 'result') {
          const usage = msg.usage as Record<string, number> | undefined;
          const resultModel = (msg.model as string) ?? model;

          if (usage) {
            tokenUsage = {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheReadTokens: usage.cache_read_input_tokens,
              model: resultModel,
            };
          }

          if (ctx.onProgress) {
            ctx.onProgress({
              type: 'cost',
              costUsd: msg.cost_usd as number | undefined,
            });
          }

          // Check exit reason
          const subtype = msg.subtype as string | undefined;
          if (subtype === 'error_max_turns') {
            return {
              success: false,
              filesChanged: [],
              summary: `Agent hit turn limit (${maxTurns})`,
              error: `Max turns (${maxTurns}) exceeded`,
              tokenUsage,
            };
          }
          if (subtype === 'error_max_budget_usd') {
            return {
              success: false,
              filesChanged: [],
              summary: `Agent hit budget limit ($${maxBudgetUsd})`,
              error: `Max budget ($${maxBudgetUsd}) exceeded`,
              tokenUsage,
            };
          }
        }
      }
    } catch (err) {
      return {
        success: false,
        filesChanged: [],
        summary: '',
        error: `SDK runner error: ${(err as Error).message}`,
        tokenUsage,
      };
    }
    /* v8 ignore stop */

    /* v8 ignore start — post-SDK commit/lint logic only runs when SDK succeeds */
    // Detect changed files (same logic as ClaudeCodeRunner)
    const { filesChanged, agentAlreadyCommitted } = await detectChangedFiles(ctx.workDir);

    if (filesChanged.length === 0) {
      return {
        success: false,
        filesChanged: [],
        summary: 'Agent made no changes',
        error: 'No files were modified',
        tokenUsage,
      };
    }

    if (agentAlreadyCommitted) {
      return {
        success: true,
        filesChanged,
        summary,
        tokenUsage,
      };
    }

    // Stage, lint/format, commit
    await gitExec(ctx.workDir, ['add', '-A']);

    const lintCmd = ctx.lintCommand ?? DEFAULT_LINT_COMMAND;
    const fmtCmd = ctx.formatCommand ?? DEFAULT_FORMAT_COMMAND;
    await runAutoFix(ctx.workDir, lintCmd, fmtCmd);
    await gitExec(ctx.workDir, ['add', '-A']);

    const tmpl = ctx.commitMessageTemplate ?? DEFAULT_COMMIT_MESSAGE_TEMPLATE;
    const coAuthor = ctx.commitCoAuthor ?? DEFAULT_COMMIT_CO_AUTHOR;
    const commitMsg = tmpl
      .replace(/\{issueNumber\}/g, ctx.issueId)
      .replace(/\{issueTitle\}/g, ctx.issueTitle);

    try {
      await gitExec(ctx.workDir, ['commit', '-m', `${commitMsg}\n\nCo-Authored-By: ${coAuthor}`]);
    } catch {
      // Pre-commit hook failure — auto-fix and retry once
      await runAutoFix(ctx.workDir, lintCmd, fmtCmd);
      await gitExec(ctx.workDir, ['add', '-A']);
      try {
        await gitExec(ctx.workDir, ['commit', '-m', `${commitMsg}\n\nCo-Authored-By: ${coAuthor}`]);
      } catch (retryErr) {
        return {
          success: false,
          filesChanged,
          summary,
          error: `Commit failed after auto-fix retry: ${(retryErr as Error).message}`,
          tokenUsage,
        };
      }
    }

    return {
      success: true,
      filesChanged,
      summary,
      tokenUsage,
    };
    /* v8 ignore stop */
  }
}
