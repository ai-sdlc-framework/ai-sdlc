/**
 * Mark a backlog task Done: flip the status, tick the acceptance criteria and
 * write the `## Final Summary` section, then move the file to
 * `backlog/completed/`. This is what the plugin's `task_edit` +
 * `task_complete` MCP tools did when the slash body called them (Step 10);
 * the body helpers are ported from
 * `ai-sdlc-plugin/mcp-server/src/lib/backlog-frontmatter.ts` (kept identical so
 * the resulting file bytes match).
 *
 * @module next-step/task-done
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { moveTaskToCompleted } from '../steps/10-finalize.js';
import { patchFrontmatterStatus } from '../steps/04-flip-status.js';

/** Toggle the 1-based acceptance-criteria checkboxes in `indices` to `[x]`. */
export function checkAcceptanceCriteria(bodyLines: string[], indices: readonly number[]): string[] {
  if (indices.length === 0) return bodyLines;
  const wanted = new Set(indices);
  const out: string[] = [];
  let inAcSection = false;
  let positionalIdx = 0;
  for (const line of bodyLines) {
    if (/^##\s+Acceptance Criteria/i.test(line)) {
      inAcSection = true;
      positionalIdx = 0;
      out.push(line);
      continue;
    }
    if (inAcSection && /^##\s+/.test(line)) {
      inAcSection = false;
      out.push(line);
      continue;
    }
    if (!inAcSection) {
      out.push(line);
      continue;
    }
    const acMatch = line.match(/^(\s*-\s+\[)([ xX])(\]\s+)(?:#(\d+)\s+)?(.*)$/);
    if (!acMatch) {
      out.push(line);
      continue;
    }
    positionalIdx += 1;
    const explicitIdx = acMatch[4] ? Number(acMatch[4]) : undefined;
    const acIdx = explicitIdx ?? positionalIdx;
    if (wanted.has(acIdx)) {
      const numberMarker = explicitIdx !== undefined ? `#${explicitIdx} ` : '';
      out.push(`${acMatch[1]}x${acMatch[3]}${numberMarker}${acMatch[5]}`);
    } else {
      out.push(line);
    }
  }
  return out;
}

function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(0, end);
}

/** Append (or replace) the `## Final Summary` section. */
export function setFinalSummary(bodyLines: string[], summary: string): string[] {
  const headingIdx = bodyLines.findIndex((line) => /^##\s+Final Summary\s*$/i.test(line));
  const summaryLines = summary.split(/\r?\n/);
  if (headingIdx === -1) {
    const out = [...trimTrailingBlankLines(bodyLines)];
    if (out.length > 0) out.push('');
    out.push('## Final Summary', '', ...summaryLines, '');
    return out;
  }
  let endIdx = bodyLines.length;
  for (let i = headingIdx + 1; i < bodyLines.length; i++) {
    if (/^##\s+/.test(bodyLines[i])) {
      endIdx = i;
      break;
    }
  }
  return [
    ...bodyLines.slice(0, headingIdx + 1),
    '',
    ...summaryLines,
    '',
    ...bodyLines.slice(endIdx),
  ];
}

/**
 * Pure transform of a task file's text: status Done + AC ticks + final summary.
 * Frontmatter keys other than `status` are preserved verbatim.
 */
export function renderDoneTask(
  raw: string,
  opts: { acceptanceCriteriaCheck: readonly number[]; finalSummary: string },
): string {
  const patched = patchFrontmatterStatus(raw, 'Done');
  const m = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/.exec(patched);
  if (!m) return patched;
  let body = m[2].split('\n');
  body = checkAcceptanceCriteria(body, opts.acceptanceCriteriaCheck);
  body = setFinalSummary(body, opts.finalSummary);
  return m[1] + body.join('\n');
}

/**
 * Apply {@link renderDoneTask} to `taskFilePath` and move it to
 * `backlog/completed/`. Returns the new path.
 */
export function markTaskDone(
  taskFilePath: string,
  opts: { acceptanceCriteriaCheck: readonly number[]; finalSummary: string },
): string {
  writeFileSync(taskFilePath, renderDoneTask(readFileSync(taskFilePath, 'utf8'), opts), 'utf8');
  return moveTaskToCompleted(taskFilePath);
}
