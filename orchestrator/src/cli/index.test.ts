/**
 * Integration tests for the CLI entry point — exercise the actual
 * commander pipeline (option:version listener registration, unknown-
 * subcommand handler) end-to-end so regressions in either path are
 * caught even without spawning the compiled binary.
 *
 * Why not unit-test `formatVersionBlock` alone? Because the round-1
 * implementation called `program.on('option:version', ...)` which
 * silently lost to commander 12's own listener (registered first
 * inside `.version()`). Pure unit tests on the formatter passed but
 * `ai-sdlc --version` printed only the bare version. These tests
 * exercise the listener pipeline so that bug class is now covered.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, symlinkSync, rmSync } from 'fs';
import { pathToFileURL } from 'url';
import { buildProgram, computeIsMainEntry } from './index.js';
import type { VersionTriple } from './versions.js';

interface CapturedExit {
  code: number;
  signal: string;
  message: string;
}

/**
 * Build a program with stdout/stderr captured into in-memory buffers
 * and exitOverride() configured so test assertions can run after the
 * commander pipeline would otherwise have called process.exit().
 */
function harness(versions: VersionTriple) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = buildProgram(versions);
  program.configureOutput({
    writeOut: (s) => {
      stdout.push(s);
    },
    writeErr: (s) => {
      stderr.push(s);
    },
  });
  let captured: CapturedExit | undefined;
  program.exitOverride((err) => {
    captured = { code: err.exitCode, signal: err.code, message: err.message };
    // Throw to break out of commander's parseAsync — exitOverride
    // requires a throw to halt execution.
    throw err;
  });
  return {
    program,
    stdout: () => stdout.join(''),
    stderr: () => stderr.join(''),
    exit: () => captured,
  };
}

const versions: VersionTriple = {
  cli: '0.6.0',
  orchestrator: '0.6.0',
  plugin: '0.7.1',
  drift: true,
};

describe('CLI --version (integration)', () => {
  it('prints the 3-line provenance block, not just the bare version', async () => {
    const h = harness(versions);
    await expect(h.program.parseAsync(['node', 'ai-sdlc', '--version'])).rejects.toMatchObject({
      exitCode: 0,
      code: 'commander.version',
    });
    const out = h.stdout();
    // 3 expected rows from formatVersionBlock — these are the lines
    // that the original buggy implementation never printed.
    expect(out).toMatch(/ai-sdlc CLI:\s+0\.6\.0/);
    expect(out).toMatch(/orchestrator:\s+0\.6\.0/);
    expect(out).toMatch(/plugin:\s+0\.7\.1/);
    // And the drift warning, since we passed a triple with drift=true.
    expect(out).toContain('versions out of sync');
    // CRITICAL: the bare-version single-line output (commander's
    // default) must NOT have leaked through. If it did, `out` would
    // contain a line that's just `0.6.0\n` and nothing else.
    expect(out.trim().split('\n').length).toBeGreaterThan(1);
  });

  it('also responds to the short -V flag', async () => {
    const h = harness(versions);
    await expect(h.program.parseAsync(['node', 'ai-sdlc', '-V'])).rejects.toMatchObject({
      exitCode: 0,
    });
    expect(h.stdout()).toMatch(/orchestrator:\s+0\.6\.0/);
  });
});

describe('CLI unknown subcommand (integration)', () => {
  it('prints the upgrade hint and exits 1 on a bogus command', async () => {
    const h = harness(versions);
    await expect(h.program.parseAsync(['node', 'ai-sdlc', 'bogus-command'])).rejects.toMatchObject({
      exitCode: 1,
      code: 'commander.unknownCommand',
    });
    const err = h.stderr();
    expect(err).toContain('Unknown subcommand: bogus-command');
    // Drift was set — the hint should reference both components.
    expect(err).toContain('cli=0.6.0');
    expect(err).toContain('orchestrator=0.6.0');
    expect(err).toContain('plugin=0.7.1');
    expect(err).toContain('Run `ai-sdlc --help`');
  });

  it('falls back to the "confirm latest" hint when no drift', async () => {
    const h = harness({
      cli: '0.6.0',
      orchestrator: '0.6.0',
      plugin: '0.6.0',
      drift: false,
    });
    await expect(h.program.parseAsync(['node', 'ai-sdlc', 'nope'])).rejects.toMatchObject({
      exitCode: 1,
    });
    const err = h.stderr();
    expect(err).toContain('Unknown subcommand: nope');
    // Without drift, the hint nudges the user to run --version to confirm.
    expect(err).toMatch(/--version/);
  });
});

describe('computeIsMainEntry — symlink-aware main detection', () => {
  // Temporary files created during tests, cleaned up in afterEach.
  const created: string[] = [];

  afterEach(() => {
    for (const p of created.splice(0)) {
      try {
        rmSync(p);
      } catch {
        // Best-effort cleanup; ignore if already removed.
      }
    }
  });

  it('returns false when argv1 is undefined', () => {
    expect(computeIsMainEntry('file:///some/module.js', undefined)).toBe(false);
  });

  it('returns false when argv1 does not exist on disk', () => {
    expect(computeIsMainEntry('file:///some/module.js', '/no/such/path/cli.js')).toBe(false);
  });

  it('returns false when argv1 points to a different file', () => {
    const target = join(tmpdir(), `aisdlc-test-other-${process.pid}.js`);
    writeFileSync(target, '');
    created.push(target);
    // The moduleUrl is for a completely different file, so they must not match.
    const moduleUrl = pathToFileURL(target + '.different').href;
    expect(computeIsMainEntry(moduleUrl, target)).toBe(false);
  });

  it('returns true when argv1 is the exact same file as moduleUrl', () => {
    const target = join(tmpdir(), `aisdlc-test-exact-${process.pid}.js`);
    writeFileSync(target, '');
    created.push(target);
    const moduleUrl = pathToFileURL(target).href;
    expect(computeIsMainEntry(moduleUrl, target)).toBe(true);
  });

  it('returns true when argv1 is a symlink that resolves to the module file (npm bin scenario)', () => {
    // This is the core regression test: simulate `npm install -g` creating
    // a symlink in the bin directory that points to the real dist/cli/index.js.
    const realFile = join(tmpdir(), `aisdlc-test-real-${process.pid}.js`);
    const symlinkPath = join(tmpdir(), `aisdlc-test-symlink-${process.pid}`);
    writeFileSync(realFile, '');
    symlinkSync(realFile, symlinkPath);
    created.push(realFile, symlinkPath);

    // moduleUrl represents import.meta.url of the real dist file.
    const moduleUrl = pathToFileURL(realFile).href;

    // argv1 is the symlink path — what `which ai-sdlc` returns after npm -g install.
    expect(computeIsMainEntry(moduleUrl, symlinkPath)).toBe(true);
  });

  it('returns false when the symlink points to a different file than moduleUrl', () => {
    const realFile = join(tmpdir(), `aisdlc-test-real2-${process.pid}.js`);
    const otherFile = join(tmpdir(), `aisdlc-test-other2-${process.pid}.js`);
    const symlinkPath = join(tmpdir(), `aisdlc-test-symlink2-${process.pid}`);
    writeFileSync(realFile, '');
    writeFileSync(otherFile, '');
    symlinkSync(realFile, symlinkPath);
    created.push(realFile, otherFile, symlinkPath);

    // moduleUrl is for otherFile, but the symlink resolves to realFile.
    const moduleUrl = pathToFileURL(otherFile).href;
    expect(computeIsMainEntry(moduleUrl, symlinkPath)).toBe(false);
  });
});
