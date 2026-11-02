/**
 * `memory-dream recover --from-transcripts` (AISDLC-1131): rebuild memory notes
 * from the `Write`, `Edit` and `Read` tool records in session transcripts, into
 * a reviewable folder that `memory-dream apply` swaps in (and `undo` reverts).
 *
 * Recovered text is data from past sessions; nothing here executes it.
 *
 * @module memory-dream/recover
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { now } from '../clock.js';
import { INDEX_FILE, parseIndex, readMemoryFolder } from './notes.js';
import { type RunMeta, metaPathFor, outputDirFor } from './run.js';

export interface RecoverResult {
  outputDir: string;
  recovered: string[];
  /** Index entries (recovered or live index) with no recoverable body. */
  missingBodies: string[];
}

interface ToolUse {
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}

function jsonlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...jsonlFiles(p));
    else if (e.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const NUMBERED = /^\s*\d+(?:\t|→)/;

/** Strips `cat -n` style line numbers a Read result carries. */
function stripLineNumbers(text: string): string {
  const lines = text.split('\n');
  if (!lines.some((l) => l !== '') || !lines.filter((l) => l !== '').every((l) => NUMBERED.test(l)))
    return text;
  return lines.map((l) => l.replace(NUMBERED, '')).join('\n');
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c === 'object' ? String((c as { text?: unknown }).text ?? '') : ''))
    .join('\n');
}

function isMemoryFile(p: unknown): p is string {
  return typeof p === 'string' && p.endsWith('.md') && /[\\/]memory[\\/][^\\/]+\.md$/.test(p);
}

/** Replays tool records in time order; the last known content of each memory file wins. */
export function replayTranscripts(projectsDir: string): Map<string, string> {
  if (!existsSync(projectsDir)) throw new Error(`transcript folder not found: ${projectsDir}`);
  const files = jsonlFiles(projectsDir)
    .map((f) => ({ f, m: statSync(f).mtimeMs }))
    .sort((a, b) => a.m - b.m);
  const state = new Map<string, string>();
  for (const { f } of files) {
    const pendingReads = new Map<string, string>();
    for (const line of readFileSync(f, 'utf-8').split('\n')) {
      let rec: { message?: { content?: unknown } };
      try {
        rec = JSON.parse(line) as typeof rec;
      } catch {
        continue;
      }
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content as Array<Record<string, unknown>>) {
        if (c.type === 'tool_use') {
          const t = c as unknown as ToolUse;
          const fp = t.input?.file_path;
          if (!isMemoryFile(fp)) continue;
          const name = basename(fp);
          if (t.name === 'Write' && typeof t.input?.content === 'string') {
            state.set(name, t.input.content);
          } else if (t.name === 'Edit' && state.has(name)) {
            const cur = state.get(name) as string;
            const oldS = t.input?.old_string;
            const newS = t.input?.new_string;
            if (typeof oldS === 'string' && typeof newS === 'string' && cur.includes(oldS)) {
              state.set(
                name,
                t.input?.replace_all === true
                  ? cur.split(oldS).join(newS)
                  : cur.replace(oldS, () => newS),
              );
            }
          } else if (
            t.name === 'Read' &&
            t.id &&
            t.input?.offset === undefined &&
            t.input?.limit === undefined
          ) {
            pendingReads.set(t.id, name);
          }
        } else if (c.type === 'tool_result' && typeof c.tool_use_id === 'string') {
          const name = pendingReads.get(c.tool_use_id);
          if (name === undefined) continue;
          pendingReads.delete(c.tool_use_id);
          const text = stripLineNumbers(resultText(c.content));
          if (text.trim() && !c.is_error) state.set(name, text);
        }
      }
    }
  }
  return state;
}

export function recoverFromTranscripts(opts: {
  projectsDir: string;
  memoryDir: string;
  now?: Date;
}): RecoverResult {
  const at = opts.now ?? now();
  const state = replayTranscripts(opts.projectsDir);
  const outputDir = outputDirFor(opts.memoryDir, at);
  mkdirSync(outputDir, { recursive: true });
  const recovered: string[] = [];
  for (const [name, text] of state) {
    writeFileSync(join(outputDir, name), text);
    if (name !== INDEX_FILE) recovered.push(name);
  }
  recovered.sort();
  // Live notes survive: carry them in when the transcripts do not hold them.
  const live = existsSync(opts.memoryDir) ? readMemoryFolder(opts.memoryDir) : null;
  for (const n of live?.notes ?? []) {
    if (!state.has(n.file)) {
      writeFileSync(join(outputDir, n.file), n.raw);
      recovered.push(n.file);
    }
  }
  const indexText = state.get(INDEX_FILE) ?? live?.indexText ?? '';
  if (!state.has(INDEX_FILE) && indexText) writeFileSync(join(outputDir, INDEX_FILE), indexText);
  const have = new Set(recovered);
  const missingBodies = parseIndex(indexText)
    .map((e) => e.file)
    .filter((f) => !have.has(f));
  const snapshot = Object.fromEntries((live?.notes ?? []).map((n) => [n.file, n.hash]));
  mkdirSync(opts.memoryDir, { recursive: true });
  const meta: RunMeta = {
    version: 1,
    startedAt: at.toISOString(),
    inputDir: opts.memoryDir,
    snapshot,
  };
  writeFileSync(metaPathFor(outputDir), JSON.stringify(meta, null, 2));
  const report = [
    `# Memory recovery from transcripts`,
    '',
    `Recovered ${recovered.length} note(s).`,
    '',
    `## Index entries with no recoverable body (${missingBodies.length})`,
    ...missingBodies.map((f) => `- ${f}`),
    '',
  ].join('\n');
  writeFileSync(`${outputDir}.report.md`, report);
  return { outputDir, recovered, missingBodies };
}
