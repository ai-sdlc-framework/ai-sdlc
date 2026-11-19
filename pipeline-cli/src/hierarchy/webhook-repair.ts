/**
 * Self-repair of the `gh webhook forward` feed (AISDLC-1299). When the feed is down or
 * degraded because the forwarder is dead or silent, the dispatch tick restarts the launchd
 * job and rewrites the agent file when it is out of date, before any decision is opened.
 * Only a launchd-supervised `gh-forward` feed on macOS is touched; tunnels and `none` never are.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { HierarchyDeps } from './types.js';
import {
  agentPath,
  forwarderArgs,
  forwarderLabel,
  forwarderPlistPath,
  installForwarder,
  agentDomain,
  renderPlist,
  resolveRealGh,
  resolveRepo,
} from './webhook-forwarder.js';
import { readState, WEBHOOK_SECRET_ENV, type WebhookHealth } from './webhook.js';

/** One recorded repair attempt (kept in the health state file; never carries a secret). */
export interface RepairAttempt {
  at: string;
  action: 'kickstart' | 'reinstall' | 'blocked';
  ok: boolean;
  detail?: string;
}

/** What the tick needs from a repair implementation. */
export interface WebhookRepair {
  /** Whether this feed and reading call for a repair. */
  eligible: (h: WebhookHealth) => boolean;
  /** Perform one repair step. */
  run: () => RepairAttempt;
  /** The redacted tail of the forwarder log. */
  logTail: () => string;
}

/** Minutes of silence-independent limits: at most 3 repairs in 60 min, 5 min apart. */
export const REPAIR_MAX_ATTEMPTS = 3;
export const REPAIR_WINDOW_MIN = 60;
export const REPAIR_MIN_GAP_MIN = 5;

/** Remove the secret from text: `--secret <v>`, `--secret=<v>`, `AI_SDLC_WEBHOOK_SECRET=<v>` and any literal. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text
    .replace(/(--secret(?:=|\s+))\S+/g, '$1[redacted]')
    .replace(/(AI_SDLC_WEBHOOK_SECRET\s*=\s*)\S+/g, '$1[redacted]');
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  return out;
}

const unxml = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The `--secret` value an installed plist carries, if any. */
function plistSecret(plist: string): string | undefined {
  const m = /<string>--secret<\/string>\s*<string>([^<]*)<\/string>/.exec(plist);
  return m ? unxml(m[1]!) : undefined;
}

function readLogTail(deps: HierarchyDeps, secret: string | undefined, lines = 10): string {
  try {
    const raw = readFileSync(path.join(deps.boardDir, 'webhook-forward.log'), 'utf-8');
    return redactSecrets(raw.trimEnd().split('\n').slice(-lines).join('\n'), [
      secret,
      deps.env[WEBHOOK_SECRET_ENV],
    ]);
  } catch {
    return '';
  }
}

/** `up-to-date`, `outdated` (needs a rewrite) or `unknown` (the expected shape cannot be built). */
function agentFileShape(
  deps: HierarchyDeps,
  label: string,
  port: number,
  secret: string,
): 'up-to-date' | 'outdated' {
  let installed: string;
  try {
    installed = readFileSync(forwarderPlistPath(deps, label), 'utf-8');
  } catch {
    return 'outdated';
  }
  try {
    const args = forwarderArgs(resolveRepo(deps), port, secret);
    args[0] = resolveRealGh(deps);
    const expected = renderPlist(
      args,
      path.join(deps.boardDir, 'webhook-forward.log'),
      agentPath(deps),
      label,
    );
    return expected === installed ? 'up-to-date' : 'outdated';
  } catch {
    // The expected shape cannot be built (no repository, no real gh): a kickstart is the best we can do.
    return 'up-to-date';
  }
}

/** The repair for the recorded feed of `deps.boardDir`, or one that is never eligible. */
export function makeWebhookRepair(
  deps: HierarchyDeps,
  platform: NodeJS.Platform = process.platform,
): WebhookRepair {
  const feedAgent = (): string | undefined => {
    const f = readState(deps.boardDir)?.feed;
    return f?.kind === 'gh-forward' ? f.agent : undefined;
  };
  return {
    eligible: (h) => {
      if (platform !== 'darwin' || !feedAgent()) return false;
      if (
        h.class === 'healthy' ||
        h.class === 'unverified' ||
        !h.signals.receiver ||
        h.signals.port === false
      )
        return false;
      if (h.signals.feed !== 'gh-forward') return false;
      const silent = h.reasons.some((r) => r.startsWith('no event for'));
      return h.signals.forwarder === 'dead' || silent;
    },
    run: () => {
      const at = deps.now().toISOString();
      const label = feedAgent() ?? forwarderLabel(deps);
      const port = readState(deps.boardDir)?.port;
      if (!port) {
        return {
          at,
          action: 'blocked',
          ok: false,
          detail: 'no receiver port is recorded, so the forwarder cannot be pointed anywhere',
        };
      }
      const secret = deps.env[WEBHOOK_SECRET_ENV];
      const redact = (t: string): string => redactSecrets(t, [secret]);
      try {
        const installed = (() => {
          try {
            return readFileSync(forwarderPlistPath(deps, label), 'utf-8');
          } catch {
            return undefined;
          }
        })();
        const effective = secret ?? (installed ? plistSecret(installed) : undefined);
        const shape =
          effective && label === forwarderLabel(deps)
            ? agentFileShape(deps, label, port, effective)
            : 'outdated';
        if (shape === 'outdated') {
          if (!secret) {
            return {
              at,
              action: 'blocked',
              ok: false,
              detail: `the agent file is out of date and ${WEBHOOK_SECRET_ENV} is not set, so it cannot be rewritten`,
            };
          }
          installForwarder(deps, secret, port, platform);
          return { at, action: 'reinstall', ok: true, detail: `rewrote and reloaded ${label}` };
        }
        const r = deps.run('launchctl', ['kickstart', '-k', agentDomain(label)], {
          cwd: deps.cwd,
        });
        const ok = r?.status === 0;
        return {
          at,
          action: 'kickstart',
          ok,
          detail: redact(
            ok
              ? `kickstart -k ${label}`
              : `kickstart -k ${label} failed: ${(r?.stderr ?? '').trim().split('\n')[0] ?? ''}`,
          ),
        };
      } catch (e) {
        return {
          at,
          action: 'reinstall',
          ok: false,
          detail: redact((e as Error).message.split('\n')[0] ?? 'repair failed'),
        };
      }
    },
    logTail: () => readLogTail(deps, deps.env[WEBHOOK_SECRET_ENV]),
  };
}
