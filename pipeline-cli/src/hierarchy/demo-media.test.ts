import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BEAT_NAMES, cutCast, parseCast, runCut, runRender } from './demo-media.js';

const BEATS = [30, 130, 230, 330, 430, 530];

function fixtureCast(version: 2 | 3 = 2): string {
  const lines = [
    version === 2
      ? '{"version":2,"width":120,"height":30}'
      : '{"version":3,"term":{"cols":120,"rows":30}}',
  ];
  for (let t = 0; t <= 600; t++) {
    lines.push(JSON.stringify([version === 2 ? t : t === 0 ? 0 : 1, 'o', `line ${t}\r\n`]));
  }
  return `${lines.join('\n')}\n`;
}

const beatsDoc = (skip?: string) => ({
  beats: BEAT_NAMES.filter((n) => n !== skip).map((name) => ({
    name,
    elapsedSeconds: BEATS[BEAT_NAMES.indexOf(name)]!,
  })),
});

describe('demo cut (AISDLC-1079)', () => {
  it.each([2, 3] as const)('cuts a 600s asciicast v%i to 30-60s with no long gap', (v) => {
    const { cast, duration } = cutCast(fixtureCast(v), beatsDoc());
    expect(duration).toBeGreaterThanOrEqual(30);
    expect(duration).toBeLessThanOrEqual(60);
    const events = parseCast(cast).events;
    for (let i = 1; i < events.length; i++) {
      expect(events[i]![0] - events[i - 1]![0]).toBeLessThanOrEqual(1.5 + 1e-9);
    }
    for (const e of events) {
      const t = Number(/line (\d+)/.exec(e[2])![1]);
      expect(BEATS.some((b) => Math.abs(t - b) <= 8)).toBe(true);
    }
  });

  it('names the beat that is missing', () => {
    expect(() => cutCast(fixtureCast(), beatsDoc('brief'))).toThrow("beat 'brief' is missing");
  });

  it('rejects an unsupported cast and a cut outside 30-60s', () => {
    expect(() => parseCast('{"version":1}\n')).toThrow('unsupported');
    expect(() => parseCast('')).toThrow('empty');
    expect(() => cutCast('{"version":2}\n[1,"o","x"]\n', beatsDoc())).toThrow('outside');
  });

  it('runCut reads files, writes the cut and returns non-zero for a missing beat', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cut-'));
    const cast = path.join(dir, 'hierarchy.cast');
    writeFileSync(cast, fixtureCast());
    const good = path.join(dir, 'beats.json');
    const bad = path.join(dir, 'bad.json');
    writeFileSync(good, JSON.stringify(beatsDoc()));
    writeFileSync(bad, JSON.stringify(beatsDoc('pr-landed')));
    const out: string[] = [];
    const err: string[] = [];
    const deps = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    const target = path.join(dir, 'hierarchy.cut.cast');
    expect(runCut({ cast, beats: good, out: target }, deps)).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(out[0]).toMatch(/^kept \d/);
    expect(runCut({ cast, beats: bad, out: target }, deps)).toBe(1);
    expect(err.join('\n')).toContain('pr-landed');
    expect(runCut({}, deps)).toBe(2);
  });
});

const has = (tool: string, flag: string): boolean => spawnSync(tool, [flag]).status === 0;
const toolsPresent = has('agg', '--version') && has('ffmpeg', '-version');
if (!toolsPresent) {
  console.log('demo render test skipped: agg or ffmpeg is not installed on this runner');
}

describe('demo render (AISDLC-1079)', () => {
  it('refuses without flags and when a step fails', () => {
    const err: string[] = [];
    const deps = {
      run: () => ({ status: 1, stdout: '', stderr: 'bad\n' }),
      out: () => {},
      err: (l: string) => err.push(l),
    };
    expect(runRender({}, deps)).toBe(2);
    expect(runRender({ cast: 'x', out: mkdtempSync(path.join(os.tmpdir(), 'r-')) }, deps)).toBe(1);
    expect(err.join('\n')).toContain('agg failed');
  });

  it('refuses a video over 4 MB', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'r-'));
    const err: string[] = [];
    const deps = {
      run: (cmd: string, args: string[]) => {
        if (cmd === 'ffmpeg' && args.at(-1)?.endsWith('.mp4')) {
          writeFileSync(args.at(-1)!, Buffer.alloc(4 * 1024 * 1024 + 1));
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      out: () => {},
      err: (l: string) => err.push(l),
    };
    expect(runRender({ cast: 'x', out: dir }, deps)).toBe(1);
    expect(err.join('\n')).toContain('limit 4 MB');
  });

  it.skipIf(!toolsPresent)(
    'renders the fixture cut cast and writes the manifest',
    () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'render-'));
      const cast = path.join(dir, 'hierarchy.cut.cast');
      writeFileSync(cast, cutCast(fixtureCast(), beatsDoc()).cast);
      writeFileSync(
        path.join(dir, 'beats.json'),
        JSON.stringify({ ...beatsDoc(), task: 'AISDLC-1066', prNumber: 5, mergeSha: 'abc' }),
      );
      const deps = {
        run: (cmd: string, args: string[]) => {
          const r = spawnSync(cmd, args, { encoding: 'utf-8' });
          return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
        },
        out: () => {},
        err: (l: string) => console.error(l),
      };
      expect(runRender({ cast, out: dir }, deps)).toBe(0);
      for (const f of ['hierarchy.mp4', 'hierarchy.webm', 'hierarchy-poster.png']) {
        expect(existsSync(path.join(dir, f))).toBe(true);
      }
      const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
      expect(m).toMatchObject({ task: 'AISDLC-1066', prNumber: 5, mergeSha: 'abc' });
      expect(m.versions.agg).toBeTruthy();
    },
    120_000,
  );

  it('writes a manifest with the tool versions using stubbed tools', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'render-'));
    const cast = path.join(dir, 'hierarchy.cut.cast');
    writeFileSync(cast, cutCast(fixtureCast(), beatsDoc()).cast);
    writeFileSync(path.join(dir, 'hierarchy.cast'), fixtureCast());
    writeFileSync(
      path.join(dir, 'beats.json'),
      JSON.stringify({ ...beatsDoc(), task: 'T-1', prNumber: 9, mergeSha: 'sha' }),
    );
    const deps = {
      run: (cmd: string, args: string[]) => {
        const last = args.at(-1)!;
        if (/\.(mp4|webm|png)$/.test(last)) writeFileSync(last, 'x');
        return { status: 0, stdout: `${cmd} 1.0\n`, stderr: '' };
      },
      out: () => {},
      err: () => {},
    };
    expect(runRender({ cast, out: dir }, deps)).toBe(0);
    const m = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
    expect(m.versions).toEqual({
      asciinema: 'asciinema 1.0',
      agg: 'agg 1.0',
      ffmpeg: 'ffmpeg 1.0',
    });
    expect(m.castSeconds).toBe(600);
    expect(m.prNumber).toBe(9);
  });
});
