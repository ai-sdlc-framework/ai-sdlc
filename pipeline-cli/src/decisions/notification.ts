/**
 * RFC-0035 Phase 8 — multi-surface notification for Decision resolution.
 *
 * When an operator resolves a Decision from the TUI (AC#3), this module fires
 * all configured notification surfaces (AC#4):
 *
 *   - TUI     — inline: the pane re-renders showing the resolution.  The
 *               "TUI surface" for notification is the DecisionsPendingPane
 *               itself; `sendDecisionNotifications` is a no-op for TUI.
 *   - Slack   — HTTP POST to a configured Incoming-Webhook URL.
 *   - Email   — appends a record to
 *               `$ARTIFACTS_DIR/_operator/notifications.jsonl` so an
 *               external mailer can pick it up; honors
 *               `notification.email.recipients` from decisions-config.yaml.
 *
 * Best-effort per RFC-0035 §15.1 Design Pattern 7 (non-blocking):
 * notification failures are logged to stderr; the resolution is NOT
 * rolled back.
 *
 * AC#5 — Composes with `TuiCaptureFiled` aggregator (no duplicate aggregator):
 *   After resolution the caller MUST also call `writeTuiCaptureFiled()` from
 *   `tui/analytics/tui-events-writer.ts` so the corpus aggregator counts the
 *   resolve as a capture filed in the session. This module does NOT do that
 *   call itself (separation of concerns: the pane wires it).
 *
 * @module decisions/notification
 */

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

import type { Decision } from './decision-record.js';
import type { NotificationConfig } from './decisions-config.js';
import { appendJsonlRecord } from '../tui/analytics/jsonl-append.js';
import { resolveArtifactsDir } from '../tui/sources/types.js';

// ── Notification record schema ────────────────────────────────────────────────

export interface DecisionNotificationRecord {
  /** ISO-8601 wall-clock. */
  ts: string;
  /** RFC-0035 decision ID (DEC-NNNN). */
  decisionId: string;
  /** One-line decision summary. */
  summary: string;
  /** The option-id the operator chose. */
  chosenOptionId: string;
  /** Actor who resolved the Decision. */
  resolvedBy?: string;
  /** Notification surface: 'slack' | 'email'. */
  surface: 'slack' | 'email';
  /** Target: webhook URL or recipient email. */
  target: string;
  /** Delivery outcome. */
  status: 'queued' | 'sent' | 'failed';
  /** Error message when `status === 'failed'`. */
  error?: string;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface SendDecisionNotificationsOpts {
  /** Override the artifacts directory (tests). */
  artifactsDir?: string;
  /** Override clock for `ts` field (tests). */
  now?: () => Date;
  /**
   * Inject HTTP sender (tests — avoids real network calls).
   * Called with the url string and body JSON string; should return
   * `{ ok: boolean; error?: string }`.
   */
  httpSender?: (url: string, body: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Inject JSONL writer (tests). Defaults `appendJsonlRecord`.
   */
  jsonlWriter?: typeof appendJsonlRecord;
}

// ── Slack sender ─────────────────────────────────────────────────────────────

/**
 * POST the Slack payload to the Incoming-Webhook URL.
 * Uses Node's built-in `https` or `http` module — no extra deps.
 * Returns `{ ok: true }` on HTTP 2xx, `{ ok: false, error: string }` otherwise.
 */
export function postSlackWebhook(
  url: string,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ ok: false, error: `invalid webhook URL: ${url}` });
      return;
    }

    const mod = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : undefined,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = mod(options, (res) => {
      if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: `HTTP ${res.statusCode ?? 'unknown'}` });
      }
      // Drain the response body so the socket closes cleanly.
      res.resume();
    });

    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.setTimeout(5_000, () => {
      req.destroy();
      resolve({ ok: false, error: 'request timed out (5s)' });
    });
    req.write(body);
    req.end();
  });
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Notify all configured surfaces that a Decision was resolved.
 *
 * Fires Slack and email surfaces independently (both best-effort).
 * Returns an array of `DecisionNotificationRecord` entries describing each
 * attempted notification — useful for tests and for the operator digest.
 */
export async function sendDecisionNotifications(
  decision: Decision,
  chosenOptionId: string,
  resolvedBy: string | undefined,
  config: NotificationConfig,
  opts: SendDecisionNotificationsOpts = {},
): Promise<DecisionNotificationRecord[]> {
  const now = (opts.now ?? ((): Date => new Date()))();
  const ts = now.toISOString();
  const records: DecisionNotificationRecord[] = [];

  const httpSender = opts.httpSender ?? postSlackWebhook;
  const writer = opts.jsonlWriter ?? appendJsonlRecord;

  // ── Slack ──────────────────────────────────────────────────────────────────
  if (config.slack?.enabled && config.slack.webhookUrl) {
    const payload = {
      text: `*Decision resolved:* ${decision.metadata.id}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `*Decision resolved:* \`${decision.metadata.id}\`\n` +
              `*Summary:* ${decision.spec.summary}\n` +
              `*Chosen option:* \`${chosenOptionId}\`${resolvedBy ? `\n*Resolved by:* ${resolvedBy}` : ''}`,
          },
        },
      ],
    };
    const body = JSON.stringify(payload);
    const record: DecisionNotificationRecord = {
      ts,
      decisionId: decision.metadata.id,
      summary: decision.spec.summary,
      chosenOptionId,
      resolvedBy,
      surface: 'slack',
      target: config.slack.webhookUrl,
      status: 'queued',
    };
    try {
      const result = await httpSender(config.slack.webhookUrl, body);
      record.status = result.ok ? 'sent' : 'failed';
      if (!result.ok) record.error = result.error;
      if (!result.ok) {
        process.stderr.write(
          `[decisions:notification] Slack notification failed: ${result.error ?? 'unknown'}\n`,
        );
      }
    } catch (err) {
      record.status = 'failed';
      record.error = (err as Error)?.message ?? String(err);
      process.stderr.write(`[decisions:notification] Slack notification threw: ${record.error}\n`);
    }
    records.push(record);
  }

  // ── Email (append to notifications.jsonl queue) ────────────────────────────
  if (config.email?.enabled && (config.email.recipients?.length ?? 0) > 0) {
    const artifactsDir = resolveArtifactsDir({ artifactsDir: opts.artifactsDir });
    const path = join(artifactsDir, '_operator', 'notifications.jsonl');

    for (const recipient of config.email.recipients ?? []) {
      const record: DecisionNotificationRecord = {
        ts,
        decisionId: decision.metadata.id,
        summary: decision.spec.summary,
        chosenOptionId,
        resolvedBy,
        surface: 'email',
        target: recipient,
        status: 'queued',
      };
      const written = writer(path, record as unknown as Record<string, unknown>);
      record.status = written ? 'queued' : 'failed';
      if (!written) record.error = 'write failed (see stderr)';
      records.push(record);
    }
  }

  return records;
}
