import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reportCapabilityOutcome } from '@ai-sdlc/reference';
import { checkCapabilityLiveness, type DoctorCheckAdapters } from './doctor-checks.js';

const file = (required: string[]) =>
  `apiVersion: ai-sdlc.io/v1alpha1\nkind: CapabilitiesConfig\nmetadata:\n  name: c\nspec:\n  required: [${required.join(', ')}]\n`;

describe('checkCapabilityLiveness', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'doctor-cap-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** `committed` is what `git show` returns for the base ref; null means no file. */
  const run = (committed: string | null) => {
    const commands: string[][] = [];
    const adapters = {
      env: { ARTIFACTS_DIR: dir },
      runCommand: (_cmd: string, args: string[]) => {
        commands.push(args);
        return committed === null
          ? { stdout: '', exitCode: 128 }
          : { stdout: committed, exitCode: 0 };
      },
    } as unknown as DoctorCheckAdapters;
    return { result: checkCapabilityLiveness({ projectDir: dir, adapters }), commands };
  };

  it('passes and prints the table when no file is on the base ref', () => {
    const { result } = run(null);
    expect(result.severity).toBe('pass');
    expect(result.title).toContain('no required capabilities declared');
    expect(result.title).toContain('dor.stage-b  never-observed');
  });

  it('reads the base ref through git show, never the working tree', () => {
    const { commands } = run(file([]));
    expect(commands[0]).toEqual(['-C', dir, 'show', 'origin/main:.ai-sdlc/capabilities.yaml']);
  });

  it('fails for a required capability that is never observed', () => {
    const { result } = run(file(['dor.stage-b']));
    expect(result.severity).toBe('fail');
    expect(result.title).toContain('dor.stage-b');
  });

  it('fails for a required capability that is degraded', () => {
    reportCapabilityOutcome('dor.stage-b', 'degraded', { artifactsDir: dir, reason: 'no backend' });
    expect(run(file(['dor.stage-b'])).result.severity).toBe('fail');
  });

  it('warns for a required capability in shadow', () => {
    reportCapabilityOutcome('dor.stage-b', 'shadow', { artifactsDir: dir });
    expect(run(file(['dor.stage-b'])).result.severity).toBe('warn');
  });

  it('passes when every required capability is live', () => {
    reportCapabilityOutcome('dor.stage-b', 'live', { artifactsDir: dir });
    reportCapabilityOutcome('dor.stage-c-x', 'live', { artifactsDir: dir });
    const { result } = run(file(['dor.stage-b', 'dor.stage-c-x']));
    expect(result.severity).toBe('pass');
    expect(result.title).toContain('all 2 required capabilities are live');
  });

  it('defaults the state directory under the project when ARTIFACTS_DIR is unset', () => {
    const adapters = {
      env: {},
      runCommand: () => ({ stdout: '', exitCode: 1 }),
    } as unknown as DoctorCheckAdapters;
    expect(checkCapabilityLiveness({ projectDir: dir, adapters }).severity).toBe('pass');
  });
});
