/**
 * Stages 2 and 3 of `cli-hierarchy demo` (AISDLC-1079): cut a recorded asciicast down to the
 * beats, and render the cut cast to GIF, MP4, WebM and a poster frame.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const BEAT_NAMES = [
  'request',
  'questions',
  'answers',
  'brief',
  'pr-opened',
  'pr-landed',
] as const;
export type BeatName = (typeof BEAT_NAMES)[number];

export interface BeatsFile {
  task?: string;
  prNumber?: number | null;
  mergeSha?: string | null;
  beats: { name: string; elapsedSeconds: number }[];
}

/** Seconds kept before and after a beat (an 8 second window). */
export const WINDOW_BEFORE = 2;
export const WINDOW_AFTER = 6;
/** Longest silence left in the cut cast. */
export const MAX_GAP = 1.5;
/** Silence inserted where two windows are joined. */
const JOIN_GAP = 0.5;
export const MIN_CUT_SECONDS = 30;
export const MAX_CUT_SECONDS = 60;
export const MAX_VIDEO_BYTES = 4 * 1024 * 1024;

type CastEvent = [number, string, string];

interface ParsedCast {
  header: Record<string, unknown>;
  events: CastEvent[];
}

/** Parse an asciicast v2 (absolute times) or v3 (intervals) into absolute event times. */
export function parseCast(text: string): ParsedCast {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error('the cast file is empty');
  const header = JSON.parse(lines[0] as string) as Record<string, unknown>;
  const version = header['version'];
  if (version !== 2 && version !== 3) throw new Error(`unsupported asciicast version ${version}`);
  let clock = 0;
  const events: CastEvent[] = [];
  for (const line of lines.slice(1)) {
    const e = JSON.parse(line) as [number, string, string];
    clock = version === 3 ? clock + e[0] : e[0];
    events.push([clock, e[1], e[2]]);
  }
  return { header, events };
}

export function parseBeatsFile(text: string): BeatsFile {
  const parsed = JSON.parse(text) as BeatsFile;
  if (!parsed || !Array.isArray(parsed.beats)) throw new Error('the beats file has no beats list');
  return parsed;
}

export interface CutResult {
  cast: string;
  duration: number;
}

/** Cut a cast to windows around the six beats, capping every silence at MAX_GAP. */
export function cutCast(castText: string, beatsFile: BeatsFile): CutResult {
  const byName = new Map(beatsFile.beats.map((b) => [b.name, b.elapsedSeconds]));
  for (const name of BEAT_NAMES) {
    const v = byName.get(name);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`beat '${name}' is missing`);
  }
  const { header, events } = parseCast(castText);
  const windows = BEAT_NAMES.map((n) => byName.get(n) as number);
  const inWindow = (t: number): number =>
    windows.findIndex((b) => t >= b - WINDOW_BEFORE && t <= b + WINDOW_AFTER);

  const out: CastEvent[] = [];
  let prevOrig: number | null = null;
  let prevWin = -1;
  let clock = 0;
  for (const ev of events) {
    const win = inWindow(ev[0]);
    if (win < 0) continue;
    if (prevOrig !== null) {
      const gap = win === prevWin ? ev[0] - prevOrig : JOIN_GAP;
      clock += Math.min(gap, MAX_GAP);
    }
    out.push([Math.round(clock * 1e6) / 1e6, ev[1], ev[2]]);
    prevOrig = ev[0];
    prevWin = win;
  }
  const duration = out.length > 0 ? (out[out.length - 1] as CastEvent)[0] : 0;
  if (duration < MIN_CUT_SECONDS || duration > MAX_CUT_SECONDS) {
    throw new Error(
      `the cut is ${duration.toFixed(1)}s, outside ${MIN_CUT_SECONDS} to ${MAX_CUT_SECONDS}s`,
    );
  }
  const term = header['term'] as { cols?: number; rows?: number } | undefined;
  const outHeader = {
    version: 2,
    width: (header['width'] as number | undefined) ?? term?.cols ?? 120,
    height: (header['height'] as number | undefined) ?? term?.rows ?? 30,
  };
  const body = [JSON.stringify(outHeader), ...out.map((e) => JSON.stringify(e))];
  return { cast: `${body.join('\n')}\n`, duration };
}

export interface MediaDeps {
  run(cmd: string, args: string[]): { status: number; stdout: string; stderr: string };
  out(line: string): void;
  err(line: string): void;
}

/** Stage 2: read the cast and beats files, write the cut cast. Returns the exit code. */
export function runCut(
  flags: Record<string, string>,
  deps: Pick<MediaDeps, 'out' | 'err'>,
): number {
  const { cast, beats, out } = flags;
  if (!cast || cast === 'true' || !beats || beats === 'true' || !out || out === 'true') {
    deps.err('cli-hierarchy demo cut: --cast, --beats and --out are required');
    return 2;
  }
  try {
    const result = cutCast(
      readFileSync(cast, 'utf-8'),
      parseBeatsFile(readFileSync(beats, 'utf-8')),
    );
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(out, result.cast);
    deps.out(`kept ${result.duration.toFixed(1)}s of the cast -> ${out}`);
    return 0;
  } catch (err) {
    deps.err(`cli-hierarchy demo cut: ${(err as Error).message}`);
    return 1;
  }
}

function castDuration(file: string): number | null {
  try {
    return Math.round(parseCast(readFileSync(file, 'utf-8')).events.at(-1)?.[0] ?? 0);
  } catch {
    return null;
  }
}

function firstLine(r: { status: number; stdout: string; stderr: string }): string | null {
  return r.status === 0 ? ((r.stdout || r.stderr).split('\n')[0]?.trim() ?? null) : null;
}

/** Stage 3: render the cut cast to GIF, MP4, WebM and a poster; write manifest.json. */
export function runRender(flags: Record<string, string>, deps: MediaDeps): number {
  const { cast, out } = flags;
  if (!cast || cast === 'true' || !out || out === 'true') {
    deps.err('cli-hierarchy demo render: --cast and --out are required');
    return 2;
  }
  mkdirSync(out, { recursive: true });
  const gif = path.join(out, 'hierarchy.gif');
  const mp4 = path.join(out, 'hierarchy.mp4');
  const webm = path.join(out, 'hierarchy.webm');
  const poster = path.join(out, 'hierarchy-poster.png');
  const steps: [string, string[]][] = [
    [
      'agg',
      ['--theme', 'dracula', '--font-size', '22', '--cols', '120', '--rows', '30', cast, gif],
    ],
    [
      'ffmpeg',
      [
        ...['-y', '-i', gif, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264'],
        ...['-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4],
      ],
    ],
    [
      'ffmpeg',
      [
        ...['-y', '-i', gif, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libvpx-vp9'],
        ...['-crf', '32', '-b:v', '0', '-pix_fmt', 'yuv420p', '-an', webm],
      ],
    ],
    ['ffmpeg', ['-y', '-i', gif, '-frames:v', '1', poster]],
  ];
  for (const [cmd, args] of steps) {
    const r = deps.run(cmd, args);
    if (r.status !== 0) {
      deps.err(`cli-hierarchy demo render: ${cmd} failed: ${r.stderr.trim().split('\n').pop()}`);
      return 1;
    }
  }
  for (const f of [mp4, webm]) {
    const size = existsSync(f) ? statSync(f).size : 0;
    if (size === 0 || size > MAX_VIDEO_BYTES) {
      deps.err(`cli-hierarchy demo render: ${path.basename(f)} is ${size} bytes (limit 4 MB)`);
      return 1;
    }
  }
  const beatsPath = flags['beats'] && flags['beats'] !== 'true' ? flags['beats'] : undefined;
  const beatsFile = path.resolve(beatsPath ?? path.join(out, 'beats.json'));
  const meta = existsSync(beatsFile) ? parseBeatsFile(readFileSync(beatsFile, 'utf-8')) : null;
  const rawCast = path.join(path.dirname(path.resolve(cast)), 'hierarchy.cast');
  const manifest = {
    task: meta?.task ?? null,
    prNumber: meta?.prNumber ?? null,
    mergeSha: meta?.mergeSha ?? null,
    castSeconds: existsSync(rawCast) ? castDuration(rawCast) : null,
    cutSeconds: castDuration(cast),
    versions: {
      asciinema: firstLine(deps.run('asciinema', ['--version'])),
      agg: firstLine(deps.run('agg', ['--version'])),
      ffmpeg: firstLine(deps.run('ffmpeg', ['-version'])),
    },
  };
  writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  deps.out(`rendered ${mp4}, ${webm} and ${poster}`);
  return 0;
}
