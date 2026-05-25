/**
 * Tests for the AISDLC-143 init wizard + feature dispatcher.
 *
 * These exercise the public API of `init-features.ts` directly with stub
 * adapters (no real disk writes, no real `gh` shell-out, no real prompts).
 * Test naming explicitly cross-references the AC numbers from the AISDLC-143
 * task body so an operator scanning failures knows which acceptance gate
 * regressed.
 *
 * Coverage strategy: each public function has a positive-path test and at
 * least one branch-coverage test for any decision the function makes
 * (--add short-circuit, --yes short-circuit, idempotent re-run, dry-run,
 * error path on `gh` failure). The actual filesystem-touching wiring is
 * exercised in `init-workspace.test.ts` to keep the two suites
 * complementary instead of duplicative.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALL_FEATURES,
  applyBranchProtection,
  applyFeatureSelection,
  buildProductionAdapters,
  CLAUDE_MD_POINTER,
  CLAUDE_MD_SENTINEL,
  ensureClaudeMdPointer,
  NO_FEATURES,
  RECOMMENDED_BRANCH_PROTECTION_BODY,
  renderNextSteps,
  resolveFeatureSelection,
  type FeatureAdapters,
  type WizardFlags,
} from './init-features.js';

// ── Stub-adapter factory ─────────────────────────────────────────────────

/**
 * Build a fresh stub adapter bag with in-memory file-state + a scripted
 * prompt queue. Each test composes these via `makeStub()` instead of
 * sharing global mocks so cases can't leak state into each other.
 */
interface StubState {
  files: Map<string, string>;
  log: string[];
  promptCalls: { question: string; defaultYes: boolean }[];
  runCommandCalls: { cmd: string; args: string[] }[];
  /** FIFO queue of scripted prompt answers; throws if exhausted. */
  promptAnswers: boolean[];
  /** Map<command-prefix, response> for runCommand. */
  runResponses: Map<string, { stdout: string; exitCode: number }>;
  /** FIFO queue of scripted multi-select answers (string[][]); returns [] if exhausted. */
  multiSelectAnswers: string[][];
  /** FIFO queue of scripted text-input answers (string); returns '' if exhausted. */
  textInputAnswers: string[];
}

function makeStub(opts: Partial<StubState> = {}): { state: StubState; adapters: FeatureAdapters } {
  const state: StubState = {
    files: opts.files ?? new Map(),
    log: opts.log ?? [],
    promptCalls: opts.promptCalls ?? [],
    runCommandCalls: opts.runCommandCalls ?? [],
    promptAnswers: opts.promptAnswers ?? [],
    runResponses: opts.runResponses ?? new Map(),
    multiSelectAnswers: opts.multiSelectAnswers ?? [],
    textInputAnswers: opts.textInputAnswers ?? [],
  };
  const adapters: FeatureAdapters = {
    prompt: async (question, defaultYes) => {
      state.promptCalls.push({ question, defaultYes });
      const ans = state.promptAnswers.shift();
      if (ans === undefined) {
        throw new Error(`Stub prompt exhausted on question: "${question}"`);
      }
      return ans;
    },
    multiSelect: async (_question, _choices) => {
      return state.multiSelectAnswers.shift() ?? [];
    },
    textInput: async (_question, _defaultValue) => {
      return state.textInputAnswers.shift() ?? '';
    },
    writeFile: (p, c) => {
      state.files.set(p, c);
    },
    appendOnce: (p, c, sentinel) => {
      const existing = state.files.get(p) ?? '';
      if (existing.includes(sentinel)) return 'skipped';
      const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      state.files.set(p, existing + sep + c);
      return 'appended';
    },
    mkdirp: () => {
      // no-op for stubs — file writes are flat key/value
    },
    exists: (p) => state.files.has(p),
    runCommand: (cmd, args) => {
      state.runCommandCalls.push({ cmd, args });
      // Look up by `cmd args.join(' ')` prefix so tests can match
      // e.g. `gh repo view ...` without enumerating every flag.
      const key = `${cmd} ${args.join(' ')}`;
      for (const [prefix, response] of state.runResponses) {
        if (key.startsWith(prefix)) return response;
      }
      // Default: success with empty stdout.
      return { stdout: '', exitCode: 0 };
    },
    log: (line) => {
      state.log.push(line);
    },
  };
  return { state, adapters };
}

const baseFlags: WizardFlags = {
  yes: false,
  withDor: false,
  withAttestation: false,
  withClassifier: false,
  withBranchProtection: false,
  withWorkflows: false,
  withSignalIngestion: false,
  add: undefined,
  dryRun: false,
  force: false,
};

// ── resolveFeatureSelection ──────────────────────────────────────────────

describe('resolveFeatureSelection', () => {
  // The test runner itself runs in a non-TTY context (stdin is not a TTY),
  // so tests that exercise the interactive prompt path must stub isTTY to
  // true to prevent the AISDLC-263 non-TTY guard from short-circuiting.
  // The nested AISDLC-263 describe restores isTTY to undefined to test
  // the non-TTY path explicitly.
  let originalIsTTY: boolean | undefined;
  beforeAll(() => {
    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });
  afterAll(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
  });

  it('AC #2: --yes accepts ALL defaults without prompting', async () => {
    const { state, adapters } = makeStub();
    const sel = await resolveFeatureSelection({ ...baseFlags, yes: true }, adapters);
    expect(sel).toEqual(ALL_FEATURES);
    expect(state.promptCalls.length).toBe(0);
  });

  it('AC #1: prompts in the documented order when no flags are set', async () => {
    const { state, adapters } = makeStub({
      // 6 prompts: dor, attestation, classifier, branchProtection, workflows, signalIngestion
      promptAnswers: [true, false, true, false, true, false],
    });
    const sel = await resolveFeatureSelection(baseFlags, adapters);
    expect(state.promptCalls.map((c) => c.question)).toEqual([
      'Will this repo use Definition-of-Ready gates?',
      'Do you want attestation infrastructure (audit-only)?',
      'Add review classifier for cost-optimized reviews?',
      'Apply recommended branch protection? (required: ai-sdlc/pr-ready + codecov/patch)',
      'Scaffold GitHub Actions workflows (gate, review, attestation, auto-merge)?',
      'Scaffold RFC-0030 signal-ingestion config (default OFF; opt in via AI_SDLC_SIGNAL_INGESTION soak)?',
    ]);
    expect(sel).toEqual({
      dor: true,
      attestation: false,
      classifier: true,
      branchProtection: false,
      workflows: true,
      signalIngestion: false,
    });
  });

  it('AC #3: --with-X flags suppress the matching prompt', async () => {
    // withDor + withClassifier set → 4 prompts remain: attestation, branchProtection,
    // workflows, signalIngestion. signalIngestion prompt answered false to match
    // ALL_FEATURES (which carries signalIngestion: false per AISDLC-348 soak default).
    const { state, adapters } = makeStub({ promptAnswers: [true, true, true, false] });
    const sel = await resolveFeatureSelection(
      { ...baseFlags, withDor: true, withClassifier: true },
      adapters,
    );
    expect(state.promptCalls.map((c) => c.question)).toEqual([
      'Do you want attestation infrastructure (audit-only)?',
      'Apply recommended branch protection? (required: ai-sdlc/pr-ready + codecov/patch)',
      'Scaffold GitHub Actions workflows (gate, review, attestation, auto-merge)?',
      'Scaffold RFC-0030 signal-ingestion config (default OFF; opt in via AI_SDLC_SIGNAL_INGESTION soak)?',
    ]);
    expect(sel).toEqual(ALL_FEATURES);
  });

  it('AC #7: --add short-circuits to a single feature, no prompts', async () => {
    const { state, adapters } = makeStub();
    const sel = await resolveFeatureSelection({ ...baseFlags, add: 'attestation' }, adapters);
    expect(state.promptCalls.length).toBe(0);
    expect(sel).toEqual({ ...NO_FEATURES, attestation: true });
  });

  it('AC #7: --add branch-protection works (the multi-word feature name)', async () => {
    const { adapters } = makeStub();
    const sel = await resolveFeatureSelection({ ...baseFlags, add: 'branch-protection' }, adapters);
    expect(sel).toEqual({ ...NO_FEATURES, branchProtection: true });
  });

  it('--yes precedence: --yes wins over individual --with-X (no prompts; all on)', async () => {
    const { state, adapters } = makeStub();
    const sel = await resolveFeatureSelection({ ...baseFlags, yes: true, withDor: true }, adapters);
    expect(sel).toEqual(ALL_FEATURES);
    expect(state.promptCalls.length).toBe(0);
  });

  it('default-No prompt answer is honored', async () => {
    // 6 prompts: dor, attestation, classifier, branchProtection, workflows, signalIngestion.
    const { adapters } = makeStub({ promptAnswers: [false, false, false, false, false, false] });
    const sel = await resolveFeatureSelection(baseFlags, adapters);
    expect(sel).toEqual(NO_FEATURES);
  });

  describe('AISDLC-263: non-TTY auto-fall-through', () => {
    // The outer beforeAll set isTTY=true for prompt tests. For non-TTY
    // tests, we need to temporarily restore the falsy (undefined) value.
    beforeAll(() => {
      Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    });
    afterAll(() => {
      // Restore to true so the sibling tests in the outer describe continue
      // to behave as interactive-TTY. The outer afterAll will do the final
      // restore to whatever the real runtime value was.
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    });

    it('AC #1 (AISDLC-263): auto-accepts ALL_FEATURES when stdin is not a TTY (no prompts, no error)', async () => {
      // Simulate a non-TTY context (CI, agent bash, `ai-sdlc init < /dev/null`).
      // process.stdin.isTTY is undefined in non-TTY contexts; we stub it to
      // undefined (falsy) to replicate that.
      const { state, adapters } = makeStub();
      const sel = await resolveFeatureSelection(baseFlags, adapters);
      expect(sel).toEqual(ALL_FEATURES);
      // No prompts should have been called — the non-TTY guard must short-circuit.
      expect(state.promptCalls.length).toBe(0);
      // A descriptive log message should have been emitted so the operator
      // knows why the wizard skipped interactive prompts.
      const joined = state.log.join('\n');
      expect(joined).toContain('Non-TTY stdin detected');
      expect(joined).toContain('--yes');
    });

    it('AC #1 (AISDLC-263): --yes still wins when both --yes flag and non-TTY are present (no log about non-TTY)', async () => {
      const { state, adapters } = makeStub();
      // --yes path is checked BEFORE the non-TTY guard so no non-TTY message
      // is emitted — the flag is explicit user intent.
      const sel = await resolveFeatureSelection({ ...baseFlags, yes: true }, adapters);
      expect(sel).toEqual(ALL_FEATURES);
      expect(state.promptCalls.length).toBe(0);
      // The non-TTY log message must NOT appear when --yes was explicit.
      expect(state.log.join('\n')).not.toContain('Non-TTY stdin detected');
    });
  });
});

// ── applyFeatureSelection ────────────────────────────────────────────────

describe('applyFeatureSelection', () => {
  it('AC #4: writes the baseline gate workflow even when all features are off', async () => {
    const { state, adapters } = makeStub();
    await applyFeatureSelection('/proj', NO_FEATURES, baseFlags, adapters);
    // The gate workflow is the only "always-on" baseline file written by
    // the wizard dispatcher; pipeline.yaml et al. are written by the
    // separate initProject step in init.ts (existing pre-AISDLC-143 path).
    expect(state.files.has('/proj/.github/workflows/ai-sdlc-gate.yml')).toBe(true);
    const gate = state.files.get('/proj/.github/workflows/ai-sdlc-gate.yml');
    expect(gate).toContain('ai-sdlc/pr-ready');
    expect(gate).toContain('re-actors/alls-green');
  });

  it('AC #1 (DoR branch): writes dor-config.yaml + dor-ingress.yml when dor=true', async () => {
    const { state, adapters } = makeStub();
    await applyFeatureSelection('/proj', { ...NO_FEATURES, dor: true }, baseFlags, adapters);
    expect(state.files.has('/proj/.ai-sdlc/dor-config.yaml')).toBe(true);
    expect(state.files.has('/proj/.github/workflows/dor-ingress.yml')).toBe(true);
    const cfg = state.files.get('/proj/.ai-sdlc/dor-config.yaml')!;
    expect(cfg).toContain('evaluationMode: warn-only');
  });

  it('AC #1 (attestation branch): writes trusted-reviewers.yaml + verify-attestation.yml + attestations dir + husky hook', async () => {
    const { state, adapters } = makeStub();
    await applyFeatureSelection(
      '/proj',
      { ...NO_FEATURES, attestation: true },
      baseFlags,
      adapters,
    );
    expect(state.files.has('/proj/.ai-sdlc/trusted-reviewers.yaml')).toBe(true);
    expect(state.files.has('/proj/.github/workflows/verify-attestation.yml')).toBe(true);
    expect(state.files.has('/proj/.ai-sdlc/attestations/.gitkeep')).toBe(true);
    expect(state.files.has('/proj/.husky/pre-push')).toBe(true);

    // The husky hook should carry our sentinel block so a follow-up run
    // detects it and doesn't append twice.
    const hook = state.files.get('/proj/.husky/pre-push')!;
    expect(hook).toContain('# ai-sdlc:attestation-sign-block');
    expect(hook).toContain('AI_SDLC_SKIP_ATTESTATION_SIGN');

    // Audit-only verifier (Q3): no commit-status posting.
    const verify = state.files.get('/proj/.github/workflows/verify-attestation.yml')!;
    expect(verify).toContain('audit');
    expect(verify).not.toContain('commit_status'); // sanity: no status posting
  });

  it('AC #1 (classifier branch): writes review-classifier.yaml stub when classifier=true', async () => {
    const { state, adapters } = makeStub();
    await applyFeatureSelection('/proj', { ...NO_FEATURES, classifier: true }, baseFlags, adapters);
    expect(state.files.has('/proj/.ai-sdlc/review-classifier.yaml')).toBe(true);
    const stub = state.files.get('/proj/.ai-sdlc/review-classifier.yaml')!;
    expect(stub).toContain('ReviewClassifier');
    expect(stub).toContain('AISDLC-141');
  });

  it('AC #7: idempotent — re-run on existing files leaves them untouched', async () => {
    // First run
    const { state, adapters } = makeStub();
    await applyFeatureSelection('/proj', { ...NO_FEATURES, dor: true }, baseFlags, adapters);
    const firstContent = state.files.get('/proj/.ai-sdlc/dor-config.yaml')!;
    // Tamper with file as if user edited it
    state.files.set('/proj/.ai-sdlc/dor-config.yaml', firstContent + '\n# user edit\n');

    // Second run with same selection — should skip, NOT overwrite.
    const result2 = await applyFeatureSelection(
      '/proj',
      { ...NO_FEATURES, dor: true },
      baseFlags,
      adapters,
    );
    expect(result2.skipped).toContain('.ai-sdlc/dor-config.yaml');
    expect(state.files.get('/proj/.ai-sdlc/dor-config.yaml')).toContain('# user edit');
  });

  it('AC #7: --add mode skips the baseline (only writes the chosen feature)', async () => {
    const { state, adapters } = makeStub();
    await applyFeatureSelection(
      '/proj',
      { ...NO_FEATURES, classifier: true },
      { ...baseFlags, add: 'classifier' },
      adapters,
    );
    // Baseline gate workflow should NOT be written in --add mode.
    expect(state.files.has('/proj/.github/workflows/ai-sdlc-gate.yml')).toBe(false);
    expect(state.files.has('/proj/.ai-sdlc/review-classifier.yaml')).toBe(true);
  });

  it('AC #6 + dry-run: --dry-run does not write any files, populates wouldCreate', async () => {
    const { state, adapters } = makeStub();
    const result = await applyFeatureSelection(
      '/proj',
      { ...NO_FEATURES, dor: true, attestation: true },
      { ...baseFlags, dryRun: true },
      adapters,
    );
    expect(state.files.size).toBe(0);
    expect(result.wouldCreate).toContain('.ai-sdlc/dor-config.yaml');
    expect(result.wouldCreate).toContain('.github/workflows/dor-ingress.yml');
    expect(result.wouldCreate).toContain('.ai-sdlc/trusted-reviewers.yaml');
    expect(result.wouldCreate).toContain('.husky/pre-push');
  });

  it('husky hook: appends to existing pre-push without clobbering user content', async () => {
    const { state, adapters } = makeStub();
    // Pre-existing user pre-push hook
    state.files.set('/proj/.husky/pre-push', '#!/bin/sh\necho "user gate"\n');

    await applyFeatureSelection(
      '/proj',
      { ...NO_FEATURES, attestation: true },
      baseFlags,
      adapters,
    );

    const updated = state.files.get('/proj/.husky/pre-push')!;
    // User content survives
    expect(updated).toContain('echo "user gate"');
    // Our block is appended
    expect(updated).toContain('# ai-sdlc:attestation-sign-block');
  });

  it('husky hook: re-run skips appending when sentinel already present (idempotent)', async () => {
    const { state, adapters } = makeStub();
    // Run once
    await applyFeatureSelection(
      '/proj',
      { ...NO_FEATURES, attestation: true },
      baseFlags,
      adapters,
    );
    const afterFirst = state.files.get('/proj/.husky/pre-push')!;
    const sentinelCount = (afterFirst.match(/# ai-sdlc:attestation-sign-block/g) ?? []).length;
    expect(sentinelCount).toBe(1);

    // Run twice — sentinel must still appear exactly once.
    const result2 = await applyFeatureSelection(
      '/proj',
      { ...NO_FEATURES, attestation: true },
      baseFlags,
      adapters,
    );
    const afterSecond = state.files.get('/proj/.husky/pre-push')!;
    const sentinelCount2 = (afterSecond.match(/# ai-sdlc:attestation-sign-block/g) ?? []).length;
    expect(sentinelCount2).toBe(1);
    expect(result2.skipped).toContain('.husky/pre-push');
  });

  // ── AISDLC-261: workflows feature ───────────────────────────────────────

  it('AISDLC-261: --with-workflows writes all 4 canonical workflow files', async () => {
    const { state, adapters } = makeStub();
    await applyFeatureSelection('/proj', { ...NO_FEATURES, workflows: true }, baseFlags, adapters);
    expect(state.files.has('/proj/.github/workflows/ai-sdlc-gate.yml')).toBe(true);
    expect(state.files.has('/proj/.github/workflows/verify-attestation.yml')).toBe(true);
    expect(state.files.has('/proj/.github/workflows/ai-sdlc-review.yml')).toBe(true);
    expect(state.files.has('/proj/.github/workflows/auto-enable-auto-merge.yml')).toBe(true);

    // Spot-check content of each workflow
    const gate = state.files.get('/proj/.github/workflows/ai-sdlc-gate.yml')!;
    expect(gate).toContain('ai-sdlc/pr-ready');
    expect(gate).toContain('re-actors/alls-green');

    const verify = state.files.get('/proj/.github/workflows/verify-attestation.yml')!;
    expect(verify).toContain('audit');

    const review = state.files.get('/proj/.github/workflows/ai-sdlc-review.yml')!;
    expect(review).toContain('Post Review Results');

    const autoMerge = state.files.get('/proj/.github/workflows/auto-enable-auto-merge.yml')!;
    expect(autoMerge).toContain('auto-merge');
    expect(autoMerge).toContain('release-please--');
  });

  it('AISDLC-261: --add workflows writes all 4 workflow files (skips baseline duplication)', async () => {
    const { state, adapters } = makeStub();
    await applyFeatureSelection(
      '/proj',
      { ...NO_FEATURES, workflows: true },
      { ...baseFlags, add: 'workflows' },
      adapters,
    );
    // All 4 workflows are present even in --add mode (workflows IS the feature)
    expect(state.files.has('/proj/.github/workflows/ai-sdlc-gate.yml')).toBe(true);
    expect(state.files.has('/proj/.github/workflows/verify-attestation.yml')).toBe(true);
    expect(state.files.has('/proj/.github/workflows/ai-sdlc-review.yml')).toBe(true);
    expect(state.files.has('/proj/.github/workflows/auto-enable-auto-merge.yml')).toBe(true);
    // Non-workflow baseline files are NOT written in --add workflows mode
    // (the wizard doesn't push BASELINE_WORKFLOW_TEMPLATES separately in --add mode)
  });

  it('AISDLC-261: idempotent — re-run skips existing workflow files by default', async () => {
    const { adapters } = makeStub();
    // First run: all 4 workflow files are created
    const result1 = await applyFeatureSelection(
      '/proj',
      { ...NO_FEATURES, workflows: true },
      baseFlags,
      adapters,
    );
    expect(result1.created).toContain('.github/workflows/ai-sdlc-gate.yml');

    // Second run: all 4 workflow files are skipped (already exist)
    const result2 = await applyFeatureSelection(
      '/proj',
      { ...NO_FEATURES, workflows: true },
      baseFlags,
      adapters,
    );
    expect(result2.skipped).toContain('.github/workflows/ai-sdlc-gate.yml');
    expect(result2.skipped).toContain('.github/workflows/verify-attestation.yml');
    expect(result2.skipped).toContain('.github/workflows/ai-sdlc-review.yml');
    expect(result2.skipped).toContain('.github/workflows/auto-enable-auto-merge.yml');
    expect(result2.created).toHaveLength(0);
  });

  it('AISDLC-261: --force overwrites existing workflow files', async () => {
    const { state, adapters } = makeStub();
    // Pre-seed an "old" version of the gate workflow
    state.files.set('/proj/.github/workflows/ai-sdlc-gate.yml', '# old gate workflow content\n');

    const result = await applyFeatureSelection(
      '/proj',
      { ...NO_FEATURES, workflows: true },
      { ...baseFlags, force: true },
      adapters,
    );

    // The gate workflow was overwritten
    expect(result.created).toContain('.github/workflows/ai-sdlc-gate.yml');
    const newContent = state.files.get('/proj/.github/workflows/ai-sdlc-gate.yml')!;
    expect(newContent).toContain('ai-sdlc/pr-ready');
    expect(newContent).not.toBe('# old gate workflow content\n');
    // Log confirms the overwrite
    const logLine = state.log.find((l) => l.includes('overwrite') && l.includes('ai-sdlc-gate'));
    expect(logLine).toBeDefined();
  });

  it('AISDLC-261: --force only affects workflow files (non-workflow files still skip)', async () => {
    const { state, adapters } = makeStub();
    // Pre-seed a non-workflow file AND a workflow file
    state.files.set('/proj/.ai-sdlc/dor-config.yaml', '# user-edited dor config\n');
    state.files.set('/proj/.github/workflows/ai-sdlc-gate.yml', '# old gate\n');

    await applyFeatureSelection(
      '/proj',
      { ...NO_FEATURES, dor: true, workflows: true },
      { ...baseFlags, force: true },
      adapters,
    );

    // dor-config.yaml is NOT overwritten (--force only applies to workflow files)
    expect(state.files.get('/proj/.ai-sdlc/dor-config.yaml')).toBe('# user-edited dor config\n');
    // ai-sdlc-gate.yml IS overwritten (it's a workflow file + --force)
    const gateContent = state.files.get('/proj/.github/workflows/ai-sdlc-gate.yml')!;
    expect(gateContent).not.toBe('# old gate\n');
    expect(gateContent).toContain('ai-sdlc/pr-ready');
  });

  it('AISDLC-261: --add workflows resolveFeatureSelection short-circuit', async () => {
    const { state, adapters } = makeStub();
    const sel = await resolveFeatureSelection({ ...baseFlags, add: 'workflows' }, adapters);
    expect(state.promptCalls.length).toBe(0);
    expect(sel).toEqual({ ...NO_FEATURES, workflows: true });
  });

  it('AISDLC-261: --with-workflows flag suppresses the prompt', async () => {
    const { state, adapters } = makeStub({ promptAnswers: [true, true, true, true] });
    // withWorkflows set → only the 4 non-workflows prompts fire
    const sel = await resolveFeatureSelection({ ...baseFlags, withWorkflows: true }, adapters);
    expect(state.promptCalls.map((c) => c.question)).not.toContain(
      'Scaffold GitHub Actions workflows (gate, review, attestation, auto-merge)?',
    );
    expect(sel.workflows).toBe(true);
  });

  it('AISDLC-261: dry-run with --force logs "would overwrite" for existing workflow files', async () => {
    const { state, adapters } = makeStub();
    state.files.set('/proj/.github/workflows/ai-sdlc-gate.yml', '# old\n');

    const result = await applyFeatureSelection(
      '/proj',
      { ...NO_FEATURES, workflows: true },
      { ...baseFlags, dryRun: true, force: true },
      adapters,
    );
    // No files written in dry-run
    expect(state.files.size).toBe(1); // only the pre-seeded file
    // wouldCreate populated
    expect(result.wouldCreate).toContain('.github/workflows/ai-sdlc-gate.yml');
    // Log says "would overwrite" for the existing file
    const overwriteLog = state.log.find(
      (l) => l.includes('would overwrite') && l.includes('ai-sdlc-gate'),
    );
    expect(overwriteLog).toBeDefined();
  });
});

// ── applyBranchProtection ────────────────────────────────────────────────

describe('applyBranchProtection', () => {
  it('AC #6: --dry-run prints the JSON body and does NOT call gh api', async () => {
    const { state, adapters } = makeStub();
    const result = await applyBranchProtection('/proj', { ...baseFlags, dryRun: true }, adapters);
    expect(result.applied).toBe(false);
    expect(result.bodyJson).toContain('"ai-sdlc/pr-ready"');
    expect(result.bodyJson).toContain('"codecov/patch"');
    // `gh` should NOT have been invoked in dry-run.
    expect(state.runCommandCalls.length).toBe(0);
    // The JSON must have been logged.
    const joined = state.log.join('\n');
    expect(joined).toContain('Branch-protection dry-run');
    expect(joined).toContain('PUT /repos/{owner}/{repo}/branches/main/protection');
  });

  it('AC #1 (branch-protection branch): the recommended body has the two required checks', () => {
    expect(RECOMMENDED_BRANCH_PROTECTION_BODY.required_status_checks.contexts).toEqual([
      'ai-sdlc/pr-ready',
      'codecov/patch',
    ]);
    // Stale-review dismissal is critical for the post-force-push workflow
    // documented in CLAUDE.md.
    expect(
      RECOMMENDED_BRANCH_PROTECTION_BODY.required_pull_request_reviews.dismiss_stale_reviews,
    ).toBe(true);
  });

  it('error path: surfaces a clean error when gh repo view fails', async () => {
    const { adapters } = makeStub({
      runResponses: new Map([['gh repo view', { stdout: 'not authenticated', exitCode: 1 }]]),
    });
    const result = await applyBranchProtection('/proj', baseFlags, adapters);
    expect(result.applied).toBe(false);
    expect(result.error).toContain('gh repo view failed');
    expect(result.error).toContain('not authenticated');
  });

  it('round-2 MAJOR fix: handles projectDir with a literal space without word-splitting', async () => {
    // Reviewer flagged that the prior `execSync(\`${cmd} ${args.join(' ')}\`)`
    // form ran the command through `/bin/sh -c`, which word-splits on
    // unquoted whitespace. On macOS, projectDir often lives under a path
    // like `~/Documents/My Project/`, so the `--input <tmpPath>` arg to
    // `gh api` was getting split into `--input /Users/foo/My` + the
    // stray token `Project/.ai-sdlc/branch-protection-body.json`. `gh`
    // would then either fail with a confusing error or apply the wrong
    // body.
    //
    // This test pins the contract that callers pass the tmpPath as a
    // SINGLE argv element (no whitespace shenanigans), which combined
    // with the production runCommand using `execFileSync` (no shell)
    // means the path-with-space case is now correct end-to-end. The
    // production-adapter half of the proof lives in the
    // `buildProductionAdapters` describe block below.
    const { state, adapters } = makeStub({
      runResponses: new Map([
        ['gh repo view', { stdout: 'owner/repo\n', exitCode: 0 }],
        ['gh api', { stdout: '{}', exitCode: 0 }],
      ]),
    });
    const projectDir = mkdtempSync(join(tmpdir(), 'init-with space-'));
    try {
      expect(projectDir).toContain(' '); // sanity: tmpdir really has a space
      const result = await applyBranchProtection(projectDir, baseFlags, adapters);
      expect(result.applied).toBe(true);

      const apiCall = state.runCommandCalls.find((c) => c.cmd === 'gh' && c.args[0] === 'api');
      expect(apiCall).toBeDefined();
      const inputIdx = apiCall!.args.indexOf('--input');
      expect(inputIdx).toBeGreaterThan(-1);
      const tmpPathArg = apiCall!.args[inputIdx + 1];
      // The tmpPath MUST be passed as a single argv element containing
      // the literal space — not split across two args.
      expect(tmpPathArg).toContain(projectDir);
      expect(tmpPathArg).toContain(' ');
      expect(tmpPathArg).toMatch(/branch-protection-body\.json$/);

      // And the body file must actually exist + be valid JSON, since
      // the implementation writes it via writeFileSync (not through the
      // adapter). Reads it back to ensure no path corruption.
      const written = readFileSync(tmpPathArg, 'utf-8');
      expect(JSON.parse(written)).toEqual(RECOMMENDED_BRANCH_PROTECTION_BODY);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

// ── renderNextSteps ──────────────────────────────────────────────────────

describe('renderNextSteps', () => {
  it('AC #5: lists the operator action items conditional on the chosen features', () => {
    const { adapters, state } = makeStub();
    const out = renderNextSteps(
      ALL_FEATURES,
      {
        created: [],
        skipped: [],
        wouldCreate: [],
        branchProtection: { applied: true, bodyJson: '{}' },
      },
      adapters,
    );

    // DoR mention
    expect(out).toContain('Definition-of-Ready');
    // Case-insensitive for the phrase since the next-steps copy uses
    // the more emphatic UPPERCASE for the mode name in the user-visible
    // string ("WARN-ONLY mode by default") while the config file itself
    // uses the lowercased `warn-only` literal.
    expect(out.toLowerCase()).toContain('warn-only');
    expect(out).toContain('evaluationMode: enforce');

    // Attestation step still mentions the local-key bootstrap; the
    // CI-attestor `gh secret set AI_SDLC_CI_ATTESTOR_PRIVATE_KEY` line
    // was removed in AISDLC-152 (the AISDLC-87 attestor was retired in
    // AISDLC-140 sub-4 — attestation is audit-only).
    expect(out).toContain('init-signing-key');
    expect(out).not.toContain('AI_SDLC_CI_ATTESTOR_PRIVATE_KEY');

    // Classifier callout pointing at AISDLC-141
    expect(out).toContain('AISDLC-141');

    // Branch-protection success line
    expect(out).toContain('Branch protection');

    // AISDLC-261: workflows summary included when workflows=true
    expect(out).toContain('GitHub Actions workflows were scaffolded');
    expect(out).toContain('auto-enable-auto-merge.yml');

    // Always: ai-sdlc health hint
    expect(out).toContain('ai-sdlc health');

    // Logged via adapter, not just returned
    expect(state.log.length).toBeGreaterThan(0);
  });

  it('AC #5: omits feature-specific steps when the feature was not chosen', () => {
    const { adapters } = makeStub();
    const out = renderNextSteps(
      NO_FEATURES,
      { created: [], skipped: [], wouldCreate: [] },
      adapters,
    );
    expect(out).not.toContain('Definition-of-Ready');
    expect(out).not.toContain('AI_SDLC_CI_ATTESTOR_PRIVATE_KEY');
    expect(out).not.toContain('AISDLC-141');
    expect(out).not.toContain('Branch protection');
    // AISDLC-261: no workflows section when workflows=false
    expect(out).not.toContain('GitHub Actions workflows were scaffolded');
    // Always-present hint + commit instructions still emitted
    expect(out).toContain('ai-sdlc health');
    expect(out).toContain('Commit the scaffolded files');
  });

  it('AC #5: surfaces branch-protection error message when the apply failed', () => {
    const { adapters } = makeStub();
    const out = renderNextSteps(
      { ...NO_FEATURES, branchProtection: true },
      {
        created: [],
        skipped: [],
        wouldCreate: [],
        branchProtection: { applied: false, bodyJson: '{}', error: 'gh: not found' },
      },
      adapters,
    );
    expect(out).toContain('NOT applied');
    expect(out).toContain('gh: not found');
    expect(out).toContain('ai-sdlc init --add branch-protection');
  });
});

// ── ensureClaudeMdPointer ────────────────────────────────────────────────

describe('ensureClaudeMdPointer', () => {
  it('AC #4: creates CLAUDE.md when missing', () => {
    const { state, adapters } = makeStub();
    ensureClaudeMdPointer('/proj', adapters, false);
    expect(state.files.has('/proj/CLAUDE.md')).toBe(true);
    expect(state.files.get('/proj/CLAUDE.md')).toContain(CLAUDE_MD_SENTINEL);
    expect(state.files.get('/proj/CLAUDE.md')).toContain('ai-sdlc/pr-ready');
  });

  it('AC #4: appends pointer to existing CLAUDE.md without clobbering user content', () => {
    const { state, adapters } = makeStub();
    state.files.set('/proj/CLAUDE.md', '# My project\n\nUser content here.\n');
    ensureClaudeMdPointer('/proj', adapters, false);
    const result = state.files.get('/proj/CLAUDE.md')!;
    expect(result).toContain('User content here.');
    expect(result).toContain(CLAUDE_MD_SENTINEL);
  });

  it('AC #4: idempotent — re-run on file with pointer already present is a no-op', () => {
    const { state, adapters } = makeStub();
    state.files.set('/proj/CLAUDE.md', `# Existing\n${CLAUDE_MD_POINTER}`);
    ensureClaudeMdPointer('/proj', adapters, false);
    // Sentinel still appears exactly once.
    const occurrences = (
      state.files.get('/proj/CLAUDE.md')!.match(new RegExp(CLAUDE_MD_SENTINEL, 'g')) ?? []
    ).length;
    expect(occurrences).toBe(1);
  });

  it('respects --dry-run by not touching the file', () => {
    const { state, adapters } = makeStub();
    ensureClaudeMdPointer('/proj', adapters, true);
    expect(state.files.size).toBe(0);
  });
});

// ── buildProductionAdapters ──────────────────────────────────────────────

describe('buildProductionAdapters', () => {
  it('returns a fully-populated adapter bag (smoke test for the factory)', () => {
    const adapters = buildProductionAdapters();
    expect(typeof adapters.prompt).toBe('function');
    expect(typeof adapters.writeFile).toBe('function');
    expect(typeof adapters.appendOnce).toBe('function');
    expect(typeof adapters.mkdirp).toBe('function');
    expect(typeof adapters.exists).toBe('function');
    expect(typeof adapters.runCommand).toBe('function');
    expect(typeof adapters.log).toBe('function');
  });

  it('round-2 MAJOR fix: runCommand passes args as argv (no shell word-splitting)', () => {
    // Pre-fix, runCommand built a shell string via
    // `execSync(\`${cmd} ${args.join(' ')}\`)`, which `/bin/sh -c`
    // word-splits on whitespace. We exercise the post-fix `execFileSync`
    // path with a single arg containing a literal space + a literal
    // shell metacharacter (`$`). If runCommand were still going through
    // the shell, the metacharacter would expand and the space would
    // split the arg into two — neither happens with the argv form.
    const adapters = buildProductionAdapters();
    const argWithSpaceAndDollar = 'has space and $HOME literal';
    const result = adapters.runCommand(process.execPath, [
      '-e',
      'process.stdout.write(process.argv[1])',
      argWithSpaceAndDollar,
    ]);
    expect(result.exitCode).toBe(0);
    // Must round-trip the literal — no word-splitting, no $HOME expansion.
    expect(result.stdout).toBe(argWithSpaceAndDollar);
  });
});
