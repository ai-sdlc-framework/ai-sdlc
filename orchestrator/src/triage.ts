/**
 * Security triage pipeline — lightweight entry point that fetches an issue,
 * runs the SecurityTriageRunner, posts findings as a comment, and applies
 * a `rejected` or `triage-passed` label.
 *
 * **Asymmetric by design**: the triage agent can auto-reject issues above the
 * risk threshold, but NEVER auto-approves (no `ai-ready` label).  A human
 * must review the triage analysis and manually apply `ai-ready`.
 */

import { join } from 'node:path';
import type { EvaluateJudgmentContext, IssueTracker } from '@ai-sdlc/reference';
import { loadConfigAsync, type AiSdlcConfig } from './config.js';
import { resolveIssueTrackerFromConfig } from './adapters.js';
import { getGitHubConfig } from './shared.js';
import { DEFAULT_CONFIG_DIR_NAME } from './defaults.js';
import {
  SecurityTriageRunner,
  type SecurityTriageConfig,
  type TriageVerdict,
} from './runners/security-triage.js';
import { createLogger, type Logger } from './logger.js';
import {
  mergeInjectionScreen,
  screenIssueText,
  type InjectionScreenFlag,
} from './judgment/injection-screen.js';

// ── Types ────────────────────────────────────────────────────────────

export interface TriageOptions {
  /** Override the issue tracker (skips config-driven resolution). */
  tracker?: IssueTracker;
  /** SecurityTriageRunner configuration overrides. */
  triageConfig?: SecurityTriageConfig;
  /** Custom logger. */
  logger?: Logger;
  /** Working directory for config loading. Defaults to cwd. */
  workDir?: string;
  /** If true, skip posting a comment to the issue. */
  dryRun?: boolean;
  /**
   * Judgment-layer context. When supplied, an injection screen runs on the issue text
   * before the security triage. Omit it and triage behaves exactly as before.
   */
  judgment?: EvaluateJudgmentContext;
}

export interface TriageResult {
  issueId: string;
  verdict: TriageVerdict;
  /** Whether the issue was auto-rejected (riskScore >= threshold). */
  rejected: boolean;
  /** The label applied to the issue, if any. */
  labelApplied?: string;
  /** Error message if the triage pipeline failed. */
  error?: string;
  /** Set only when the injection screen flagged the text; its findings are in the verdict. */
  suspicious?: true;
}

// ── Labels ──────────────────────────────────────────────────────────

const LABEL_REJECTED = 'security-rejected';
const LABEL_TRIAGE_PASSED = 'triage-passed';

// ── Comment formatting ──────────────────────────────────────────────

function formatTriageComment(verdict: TriageVerdict, rejected: boolean): string {
  const icon = rejected ? '🚨' : verdict.riskScore >= 3 ? '⚠️' : '✅';
  const status = rejected ? 'REJECTED' : 'PASSED';

  const lines = [
    `## ${icon} Security Triage: ${status}`,
    '',
    `**Risk Score:** ${verdict.riskScore}/10`,
    `**Safe:** ${verdict.safe}`,
    '',
  ];

  if (verdict.findings.length > 0) {
    lines.push('### Findings', '');
    for (const finding of verdict.findings) {
      lines.push(`- ${finding}`);
    }
    lines.push('');
  }

  lines.push('### Rationale', '', verdict.rationale, '');

  if (rejected) {
    lines.push(
      '---',
      '> This issue has been automatically rejected due to a high risk score.',
      '> A maintainer may override this by removing the `security-rejected` label',
      '> and manually applying `ai-ready` after review.',
    );
  } else {
    lines.push(
      '---',
      '> This issue passed automated security triage.',
      '> A maintainer must still manually apply the `ai-ready` label to enable AI processing.',
    );
  }

  lines.push(
    '',
    '*Analyzed by [AI-SDLC Security Triage](https://github.com/ai-sdlc-framework/ai-sdlc)*',
  );

  return lines.join('\n');
}

// ── Pipeline ────────────────────────────────────────────────────────

export async function executeTriage(
  issueId: string,
  options: TriageOptions = {},
): Promise<TriageResult> {
  const workDir = options.workDir ?? process.cwd();
  const log = options.logger ?? createLogger();

  log.info(`[triage] Starting security triage for issue ${issueId}`);

  // ── Resolve issue tracker ───────────────────────────────────────
  let tracker: IssueTracker;
  if (options.tracker) {
    tracker = options.tracker;
  } else {
    const configDir = join(workDir, DEFAULT_CONFIG_DIR_NAME);
    const config: AiSdlcConfig = await loadConfigAsync(configDir);
    const ghConfig = getGitHubConfig();
    tracker = resolveIssueTrackerFromConfig(config, {
      org: ghConfig.org,
      repo: ghConfig.repo,
      token: { secretRef: 'GITHUB_TOKEN' },
    });
  }

  // ── Fetch issue ─────────────────────────────────────────────────
  const issue = await tracker.getIssue(issueId);
  log.info(`[triage] Fetched issue: "${issue.title}"`);

  // ── Injection screen (before the existing triage, which always runs) ──
  let flag: InjectionScreenFlag | undefined;
  if (options.judgment) {
    flag = await screenIssueText(
      { title: issue.title, body: issue.description ?? '' },
      options.judgment,
    );
  }

  // ── Run triage ──────────────────────────────────────────────────
  const runner = new SecurityTriageRunner(options.triageConfig);

  const agentResult = await runner.run({
    issueId,
    issueTitle: issue.title,
    issueBody: issue.description ?? '',
    workDir,
    branch: 'main',
    constraints: {
      maxFilesPerChange: 0,
      requireTests: false,
      blockedPaths: ['**/*'],
    },
  });

  if (!agentResult.success) {
    log.error(`[triage] Triage failed: ${agentResult.error}`);
    return mergeInjectionScreen(
      {
        issueId,
        verdict: {
          safe: false,
          riskScore: 7,
          findings: ['Triage pipeline error — treating as suspicious'],
          sanitizedDescription: '',
          rationale: agentResult.error ?? 'Unknown error',
        },
        rejected: true,
        error: agentResult.error,
      },
      flag,
    );
  }

  // ── Parse verdict ───────────────────────────────────────────────
  const parsed: TriageVerdict = JSON.parse(agentResult.summary);
  const rejected = parsed.riskScore >= runner.rejectThreshold;
  // Carry the screen forward: findings are appended, nothing else in the verdict changes.
  const { verdict, suspicious } = mergeInjectionScreen({ verdict: parsed }, flag);
  const carried = suspicious ? ({ suspicious } as const) : {};

  log.info(
    `[triage] Verdict: riskScore=${verdict.riskScore}, safe=${verdict.safe}, rejected=${rejected}`,
  );

  // ── Post comment & apply label ──────────────────────────────────
  if (!options.dryRun) {
    const comment = formatTriageComment(verdict, rejected);

    try {
      await tracker.addComment(issueId, comment);
      log.info(`[triage] Posted triage comment on issue ${issueId}`);
    } catch (err) {
      log.error(`[triage] Failed to post comment: ${err}`);
    }

    const label = rejected ? LABEL_REJECTED : LABEL_TRIAGE_PASSED;
    try {
      const existingLabels = issue.labels ?? [];
      await tracker.updateIssue(issueId, {
        labels: [
          ...existingLabels.filter((l) => l !== LABEL_REJECTED && l !== LABEL_TRIAGE_PASSED),
          label,
        ],
      });
      log.info(`[triage] Applied label "${label}" to issue ${issueId}`);
      return { issueId, verdict, rejected, labelApplied: label, ...carried };
    } catch (err) {
      log.error(`[triage] Failed to apply label: ${err}`);
      return { issueId, verdict, rejected, error: `Label application failed: ${err}`, ...carried };
    }
  }

  return { issueId, verdict, rejected, ...carried };
}
