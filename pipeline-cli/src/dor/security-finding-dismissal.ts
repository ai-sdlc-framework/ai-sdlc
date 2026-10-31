/**
 * AISDLC-940: a `security-finding` task moved to `backlog/completed/` must
 * carry either a PR reference (the fix) or a `dismissal:` frontmatter block
 * (`reason`, `by`, `date`). Closing a finding without either records no why.
 */
import { load as yamlLoad } from 'js-yaml';

export interface SecurityFindingCheck {
  applicable: boolean;
  ok: boolean;
  message: string;
}

function splitFrontmatter(text: string): { fm: Record<string, unknown>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  try {
    const parsed = yamlLoad(m[1]);
    const fm = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    return { fm, body: m[2] };
  } catch {
    return { fm: {}, body: m[2] };
  }
}

const PR_REF_RE = /\/pull\/\d+|\bPR\s*#?\d+|(^|[\s(])#\d{2,}\b/i;

function hasPrReference(fm: Record<string, unknown>, body: string): boolean {
  for (const key of ['prUrl', 'pr', 'pullRequest']) {
    const v = fm[key];
    if (typeof v === 'string' && v.trim() !== '') return true;
    if (typeof v === 'number') return true;
  }
  const summary = typeof fm.finalSummary === 'string' ? fm.finalSummary : '';
  return PR_REF_RE.test(`${summary}\n${body}`);
}

function missingDismissalFields(fm: Record<string, unknown>): string[] | null {
  const d = fm.dismissal;
  if (d === undefined || d === null) return null;
  if (typeof d !== 'object') return ['reason', 'by', 'date'];
  const rec = d as Record<string, unknown>;
  return ['reason', 'by', 'date'].filter((k) => {
    const v = rec[k];
    return v === undefined || v === null || String(v).trim() === '';
  });
}

/**
 * @param text full task file contents
 * @param completed true when the file lives under `backlog/completed/`
 */
export function checkSecurityFindingCompletion(
  text: string,
  completed: boolean,
): SecurityFindingCheck {
  const { fm, body } = splitFrontmatter(text);
  const labels = Array.isArray(fm.labels) ? fm.labels.map(String) : [];
  if (!completed || !labels.includes('security-finding')) {
    return { applicable: false, ok: true, message: '' };
  }
  if (hasPrReference(fm, body)) return { applicable: true, ok: true, message: '' };
  const missing = missingDismissalFields(fm);
  if (missing && missing.length === 0) return { applicable: true, ok: true, message: '' };
  const detail = missing
    ? `its dismissal: block is missing ${missing.join(', ')}`
    : 'it has no dismissal: block';
  return {
    applicable: true,
    ok: false,
    message:
      `[dor-gate] security-finding task completed with neither a PR reference nor a complete ` +
      `dismissal: block (reason, by, date); ${detail}.`,
  };
}
