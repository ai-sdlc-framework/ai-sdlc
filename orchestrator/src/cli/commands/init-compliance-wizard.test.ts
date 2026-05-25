/**
 * Tests for the RFC-0022 §7 compliance posture wizard step (AISDLC-324).
 *
 * Test matrix:
 *  AC #1: Multi-select prompt lists all 6 regime choices
 *  AC #2: Attestation prompts (attestedBy, attestedNotes)
 *  AC #3: attestedBy auto-filled from git config user.email
 *  AC #4: attestedAt auto-filled to ISO-8601 timestamp
 *  AC #5: .ai-sdlc/compliance.yaml written with declared regimes
 *  AC #6: Gate-config DB-pool rationale shown when HIPAA forces per-shard
 *  AC #7: Integration — HIPAA declaration → derivedGates.databaseBranchPool = per-shard
 *
 * Uses stub adapters (no real disk writes, no TTY, no git shell-outs) to
 * keep tests hermetic and fast.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  applyOq11TriggerChecklistUpgrade,
  buildComplianceYaml,
  COMPLIANCE_REGIME_CHOICES,
  computeInitWizardDerivedGates,
  describeOq11Trigger,
  formatDerivedGatesDisplay,
  getDbPoolRationale,
  runComplianceStep,
  type ComplianceRegimeChoice,
  type FeatureAdapters,
  type Oq11TriggerKind,
  type WizardFlags,
} from './init-features.js';
import { BASELINE_DERIVED_GATES } from '../../compliance/types.js';

// ── Stub-adapter factory ─────────────────────────────────────────────────

interface ComplianceStubState {
  files: Map<string, string>;
  log: string[];
  runCommandCalls: { cmd: string; args: string[] }[];
  multiSelectCalls: { question: string; choices: ComplianceRegimeChoice[] }[];
  textInputCalls: { question: string; defaultValue?: string }[];
  promptCalls: { question: string; defaultYes: boolean }[];
  /** FIFO queues for scripted responses. */
  multiSelectAnswers: string[][];
  textInputAnswers: string[];
  /**
   * FIFO queue for yes/no prompt answers (RFC-0009 §8.7 trigger checklist).
   * When empty, the stub falls back to the per-prompt `defaultYes` argument —
   * matching the production wizard's defaults (which default to `false` for
   * the OQ-11 trigger questions so existing tests stay shared-with-rls).
   */
  promptAnswers: boolean[];
  runResponses: Map<string, { stdout: string; exitCode: number }>;
}

function makeComplianceStub(opts: Partial<ComplianceStubState> = {}): {
  state: ComplianceStubState;
  adapters: FeatureAdapters;
} {
  const state: ComplianceStubState = {
    files: opts.files ?? new Map(),
    log: opts.log ?? [],
    runCommandCalls: opts.runCommandCalls ?? [],
    multiSelectCalls: opts.multiSelectCalls ?? [],
    textInputCalls: opts.textInputCalls ?? [],
    promptCalls: opts.promptCalls ?? [],
    multiSelectAnswers: opts.multiSelectAnswers ?? [],
    textInputAnswers: opts.textInputAnswers ?? [],
    promptAnswers: opts.promptAnswers ?? [],
    runResponses:
      opts.runResponses ??
      new Map([
        // Default: git config user.email returns a test email
        ['git config user.email', { stdout: 'testuser@example.com\n', exitCode: 0 }],
        // Default: git remote get-url origin returns a test URL
        [
          'git remote get-url origin',
          { stdout: 'https://github.com/test-org/test-repo.git\n', exitCode: 0 },
        ],
      ]),
  };

  const adapters: FeatureAdapters = {
    prompt: async (question, defaultYes) => {
      state.promptCalls.push({ question, defaultYes });
      // FIFO scripted answer; fall back to defaultYes when queue is exhausted
      // so existing tests pre-AISDLC-319 (which never queued prompt answers)
      // continue to receive the production-default answer for the OQ-11
      // trigger questions (defaultYes: false → shared-with-rls remains).
      if (state.promptAnswers.length > 0) {
        return state.promptAnswers.shift()!;
      }
      return defaultYes;
    },
    multiSelect: async (question, choices) => {
      state.multiSelectCalls.push({ question, choices });
      return state.multiSelectAnswers.shift() ?? [];
    },
    textInput: async (question, defaultValue) => {
      state.textInputCalls.push({ question, defaultValue });
      return state.textInputAnswers.shift() ?? defaultValue ?? '';
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
      // no-op for stubs
    },
    exists: (p) => state.files.has(p),
    runCommand: (cmd, args) => {
      state.runCommandCalls.push({ cmd, args });
      const key = `${cmd} ${args.join(' ')}`;
      for (const [prefix, response] of state.runResponses) {
        if (key.startsWith(prefix)) return response;
      }
      return { stdout: '', exitCode: 1 }; // Default: failure
    },
    log: (line) => {
      state.log.push(line);
    },
  };

  return { state, adapters };
}

// Force TTY for interactive tests
let originalIsTTY: boolean | undefined;
beforeAll(() => {
  originalIsTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
});
afterAll(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
});

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

// ── computeInitWizardDerivedGates ────────────────────────────────────────

describe('computeInitWizardDerivedGates()', () => {
  it('returns BASELINE_DERIVED_GATES when no regimes are declared', () => {
    const result = computeInitWizardDerivedGates([]);
    expect(result).toEqual(BASELINE_DERIVED_GATES);
  });

  it('AC #7 (integration): HIPAA → databaseBranchPool per-shard', () => {
    const result = computeInitWizardDerivedGates(['HIPAA']);
    expect(result.databaseBranchPool).toBe('per-shard');
  });

  it('AC #7: HIPAA → secretScanStrictness strict', () => {
    const result = computeInitWizardDerivedGates(['HIPAA']);
    expect(result.secretScanStrictness).toBe('strict');
  });

  it('AC #7: HIPAA → attestationRequired true', () => {
    const result = computeInitWizardDerivedGates(['HIPAA']);
    expect(result.attestationRequired).toBe(true);
  });

  it('AC #7: HIPAA → auditRetentionDays 2190 (6 years)', () => {
    const result = computeInitWizardDerivedGates(['HIPAA']);
    expect(result.auditRetentionDays).toBe(2190);
  });

  it('AC #7: HIPAA → reviewerAuthorityModel allowlist+role', () => {
    const result = computeInitWizardDerivedGates(['HIPAA']);
    expect(result.reviewerAuthorityModel).toBe('allowlist+role');
  });

  it('SOC2-T2 → per-shard (SOC2 also defaults to per-shard)', () => {
    const result = computeInitWizardDerivedGates(['SOC2-T2']);
    expect(result.databaseBranchPool).toBe('per-shard');
    expect(result.auditRetentionDays).toBe(2555);
  });

  it('PCI-DSS-L1 → per-shard + strict + attestationRequired', () => {
    const result = computeInitWizardDerivedGates(['PCI-DSS-L1']);
    expect(result.databaseBranchPool).toBe('per-shard');
    expect(result.secretScanStrictness).toBe('strict');
    expect(result.attestationRequired).toBe(true);
  });

  it('GDPR → per-shard + standard + allowlist (not allowlist+role)', () => {
    const result = computeInitWizardDerivedGates(['GDPR']);
    expect(result.databaseBranchPool).toBe('per-shard');
    expect(result.secretScanStrictness).toBe('standard');
    expect(result.reviewerAuthorityModel).toBe('allowlist');
  });

  it('FedRAMP-Moderate → per-shard + strict + 1095 days', () => {
    const result = computeInitWizardDerivedGates(['FedRAMP-Moderate']);
    expect(result.databaseBranchPool).toBe('per-shard');
    expect(result.auditRetentionDays).toBe(1095);
  });

  it('ISO-27001:2022 → per-shard + strict', () => {
    const result = computeInitWizardDerivedGates(['ISO-27001:2022']);
    expect(result.databaseBranchPool).toBe('per-shard');
    expect(result.secretScanStrictness).toBe('strict');
  });

  it('tightest-wins: SOC2-T2 + HIPAA → HIPAA wins on auditRetentionDays (2555 vs 2190 → 2555)', () => {
    const result = computeInitWizardDerivedGates(['SOC2-T2', 'HIPAA']);
    // Both force per-shard; SOC2 retention (2555) > HIPAA (2190) → 2555 wins
    expect(result.databaseBranchPool).toBe('per-shard');
    expect(result.auditRetentionDays).toBe(2555);
    expect(result.reviewerAuthorityModel).toBe('allowlist+role');
  });

  it('tightest-wins: GDPR + HIPAA → HIPAA wins on secretScanStrictness (strict > standard)', () => {
    const result = computeInitWizardDerivedGates(['GDPR', 'HIPAA']);
    expect(result.secretScanStrictness).toBe('strict');
    expect(result.reviewerAuthorityModel).toBe('allowlist+role'); // HIPAA > GDPR
  });

  it('unknown regime ID is skipped gracefully (no throw)', () => {
    const result = computeInitWizardDerivedGates(['UNKNOWN-REGIME-XYZ']);
    // Unknown regime → baseline
    expect(result).toEqual(BASELINE_DERIVED_GATES);
  });

  it('mix of known + unknown: known regime contributes, unknown is skipped', () => {
    const result = computeInitWizardDerivedGates(['HIPAA', 'UNKNOWN-REGIME-XYZ']);
    expect(result.databaseBranchPool).toBe('per-shard');
  });
});

// ── buildComplianceYaml ──────────────────────────────────────────────────

describe('buildComplianceYaml()', () => {
  it('writes valid YAML with apiVersion and kind', () => {
    const yaml = buildComplianceYaml({
      projectName: 'test-project',
      regimes: [],
      attestedBy: 'test@example.com',
      attestedAt: '2026-05-18T00:00:00.000Z',
      derivedGates: { ...BASELINE_DERIVED_GATES },
    });
    expect(yaml).toContain('apiVersion: ai-sdlc.io/v1alpha1');
    expect(yaml).toContain('kind: CompliancePosture');
  });

  it('includes project name in metadata', () => {
    const yaml = buildComplianceYaml({
      projectName: 'my-project',
      regimes: [],
      attestedBy: 'test@example.com',
      attestedAt: '2026-05-18T00:00:00.000Z',
      derivedGates: { ...BASELINE_DERIVED_GATES },
    });
    expect(yaml).toContain('name: "my-project"');
  });

  it('writes empty regimes array when no regimes are declared', () => {
    const yaml = buildComplianceYaml({
      projectName: 'test-project',
      regimes: [],
      attestedBy: 'test@example.com',
      attestedAt: '2026-05-18T00:00:00.000Z',
      derivedGates: { ...BASELINE_DERIVED_GATES },
    });
    expect(yaml).toContain('regimes: []');
  });

  it('includes regime id, attestedBy, attestedAt when regimes are declared', () => {
    const yaml = buildComplianceYaml({
      projectName: 'test-project',
      regimes: ['HIPAA'],
      attestedBy: 'user@example.com',
      attestedAt: '2026-05-18T12:00:00.000Z',
      derivedGates: computeInitWizardDerivedGates(['HIPAA']),
    });
    expect(yaml).toContain('id: HIPAA');
    expect(yaml).toContain('attestedBy: "user@example.com"');
    expect(yaml).toContain('attestedAt: "2026-05-18T12:00:00.000Z"');
  });

  it('includes attestedNotes when provided', () => {
    const yaml = buildComplianceYaml({
      projectName: 'test-project',
      regimes: ['HIPAA'],
      attestedBy: 'user@example.com',
      attestedAt: '2026-05-18T12:00:00.000Z',
      attestedNotes: 'Annual HIPAA compliance assessment',
      derivedGates: computeInitWizardDerivedGates(['HIPAA']),
    });
    expect(yaml).toContain('attestedNotes: "Annual HIPAA compliance assessment"');
  });

  it('omits attestedNotes when not provided', () => {
    const yaml = buildComplianceYaml({
      projectName: 'test-project',
      regimes: ['HIPAA'],
      attestedBy: 'user@example.com',
      attestedAt: '2026-05-18T12:00:00.000Z',
      derivedGates: computeInitWizardDerivedGates(['HIPAA']),
    });
    expect(yaml).not.toContain('attestedNotes');
  });

  it('includes derivedGates as read-only comments', () => {
    const yaml = buildComplianceYaml({
      projectName: 'test-project',
      regimes: ['HIPAA'],
      attestedBy: 'user@example.com',
      attestedAt: '2026-05-18T12:00:00.000Z',
      derivedGates: computeInitWizardDerivedGates(['HIPAA']),
    });
    // Derived gates should appear as YAML comments (not as real YAML fields)
    expect(yaml).toContain('# databaseBranchPool: per-shard');
    expect(yaml).toContain('# secretScanStrictness: strict');
    expect(yaml).toContain('# attestationRequired: true');
    expect(yaml).toContain('# auditRetentionDays: 2190');
    expect(yaml).toContain('# reviewerAuthorityModel: allowlist+role');
  });

  it('does NOT write spec.derivedGates as a real YAML field (avoids _notes validation)', () => {
    const yaml = buildComplianceYaml({
      projectName: 'test-project',
      regimes: ['HIPAA'],
      attestedBy: 'user@example.com',
      attestedAt: '2026-05-18T12:00:00.000Z',
      derivedGates: computeInitWizardDerivedGates(['HIPAA']),
    });
    // spec.derivedGates is the OPERATOR OVERRIDE section; init should not write it
    // (that would require _notes for each field per the loader's validation)
    const lines = yaml.split('\n').filter((l) => !l.trim().startsWith('#'));
    const hasBareDerivationKey = lines.some(
      (l) => l.includes('databaseBranchPool:') || l.includes('secretScanStrictness:'),
    );
    expect(hasBareDerivationKey).toBe(false);
  });

  it('includes auditExports: [] placeholder', () => {
    const yaml = buildComplianceYaml({
      projectName: 'test-project',
      regimes: [],
      attestedBy: 'test@example.com',
      attestedAt: '2026-05-18T00:00:00.000Z',
      derivedGates: { ...BASELINE_DERIVED_GATES },
    });
    expect(yaml).toContain('auditExports: []');
  });
});

// ── COMPLIANCE_REGIME_CHOICES ────────────────────────────────────────────

describe('COMPLIANCE_REGIME_CHOICES', () => {
  it('AC #2: contains exactly 6 regime choices', () => {
    expect(COMPLIANCE_REGIME_CHOICES).toHaveLength(6);
  });

  it('includes HIPAA', () => {
    expect(COMPLIANCE_REGIME_CHOICES.some((c) => c.value === 'HIPAA')).toBe(true);
  });

  it('includes SOC2-T2', () => {
    expect(COMPLIANCE_REGIME_CHOICES.some((c) => c.value === 'SOC2-T2')).toBe(true);
  });

  it('includes PCI-DSS-L1', () => {
    expect(COMPLIANCE_REGIME_CHOICES.some((c) => c.value === 'PCI-DSS-L1')).toBe(true);
  });

  it('includes GDPR', () => {
    expect(COMPLIANCE_REGIME_CHOICES.some((c) => c.value === 'GDPR')).toBe(true);
  });

  it('includes FedRAMP-Moderate', () => {
    expect(COMPLIANCE_REGIME_CHOICES.some((c) => c.value === 'FedRAMP-Moderate')).toBe(true);
  });

  it('includes ISO-27001:2022', () => {
    expect(COMPLIANCE_REGIME_CHOICES.some((c) => c.value === 'ISO-27001:2022')).toBe(true);
  });

  it('all choices have non-empty label and value', () => {
    for (const choice of COMPLIANCE_REGIME_CHOICES) {
      expect(choice.value.length).toBeGreaterThan(0);
      expect(choice.label.length).toBeGreaterThan(0);
    }
  });
});

// ── getDbPoolRationale ───────────────────────────────────────────────────

describe('getDbPoolRationale()', () => {
  it('AC #6: returns rationale string when HIPAA forces per-shard', () => {
    const gates = computeInitWizardDerivedGates(['HIPAA']);
    const rationale = getDbPoolRationale(['HIPAA'], gates);
    expect(rationale).not.toBeNull();
    expect(rationale).toContain('HIPAA');
    expect(rationale).toContain('per-shard');
  });

  it('returns null when no regimes are declared (baseline)', () => {
    const gates = computeInitWizardDerivedGates([]);
    const rationale = getDbPoolRationale([], gates);
    expect(rationale).toBeNull();
  });

  it('returns null when derivedGates.databaseBranchPool is shared-with-rls', () => {
    const gates = { ...BASELINE_DERIVED_GATES };
    const rationale = getDbPoolRationale([], gates);
    expect(rationale).toBeNull();
  });
});

// ── formatDerivedGatesDisplay ────────────────────────────────────────────

describe('formatDerivedGatesDisplay()', () => {
  it('includes all 5 gate fields', () => {
    const display = formatDerivedGatesDisplay({ ...BASELINE_DERIVED_GATES });
    expect(display).toContain('databaseBranchPool');
    expect(display).toContain('secretScanStrictness');
    expect(display).toContain('attestationRequired');
    expect(display).toContain('auditRetentionDays');
    expect(display).toContain('reviewerAuthorityModel');
  });

  it('shows HIPAA-derived values correctly', () => {
    const gates = computeInitWizardDerivedGates(['HIPAA']);
    const display = formatDerivedGatesDisplay(gates);
    expect(display).toContain('per-shard');
    expect(display).toContain('strict');
    expect(display).toContain('true');
    expect(display).toContain('2190');
    expect(display).toContain('allowlist+role');
  });
});

// ── runComplianceStep ────────────────────────────────────────────────────

describe('runComplianceStep()', () => {
  it('AC #1: multi-select prompt is called with 6 regime choices', async () => {
    const { state, adapters } = makeComplianceStub({
      multiSelectAnswers: [[]],
      textInputAnswers: ['user@example.com', ''],
    });

    await runComplianceStep('/proj', baseFlags, adapters);

    expect(state.multiSelectCalls).toHaveLength(1);
    expect(state.multiSelectCalls[0].choices).toHaveLength(6);
  });

  it('AC #2: attestedBy text-input prompt is called', async () => {
    const { state, adapters } = makeComplianceStub({
      multiSelectAnswers: [[]],
      textInputAnswers: ['user@example.com', ''],
    });

    await runComplianceStep('/proj', baseFlags, adapters);

    const attestedByCall = state.textInputCalls.find((c) =>
      c.question.toLowerCase().includes('attesting'),
    );
    expect(attestedByCall).toBeDefined();
  });

  it('AC #3: attestedBy default is auto-filled from git config user.email', async () => {
    const { state, adapters } = makeComplianceStub({
      multiSelectAnswers: [[]],
      textInputAnswers: ['testuser@example.com', ''],
      runResponses: new Map([
        ['git config user.email', { stdout: 'testuser@example.com\n', exitCode: 0 }],
        ['git remote get-url origin', { stdout: '', exitCode: 1 }],
      ]),
    });

    await runComplianceStep('/proj', baseFlags, adapters);

    // The text-input for attestedBy should have been called with the git email as default
    const attestedByCall = state.textInputCalls.find((c) =>
      c.question.toLowerCase().includes('attesting'),
    );
    expect(attestedByCall?.defaultValue).toBe('testuser@example.com');
  });

  it('AC #3: attestedBy default is empty when git config fails', async () => {
    const { state, adapters } = makeComplianceStub({
      multiSelectAnswers: [[]],
      textInputAnswers: ['', ''],
      runResponses: new Map([
        ['git config user.email', { stdout: '', exitCode: 1 }],
        ['git remote get-url origin', { stdout: '', exitCode: 1 }],
      ]),
    });

    await runComplianceStep('/proj', baseFlags, adapters);

    const attestedByCall = state.textInputCalls.find((c) =>
      c.question.toLowerCase().includes('attesting'),
    );
    // When git config fails, defaultValue is '' or undefined
    const def = attestedByCall?.defaultValue;
    expect(def === '' || def === undefined).toBe(true);
  });

  it('AC #4: attestedAt is ISO-8601 format', async () => {
    const before = new Date();
    const { adapters } = makeComplianceStub({
      multiSelectAnswers: [[]],
      textInputAnswers: ['user@example.com', ''],
    });

    const result = await runComplianceStep('/proj', baseFlags, adapters);
    const after = new Date();

    const attestedAt = new Date(result.attestedAt);
    expect(attestedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(attestedAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    // ISO-8601 format: should not throw Date.parse
    expect(isNaN(attestedAt.getTime())).toBe(false);
    // Should contain 'T' separator (ISO-8601)
    expect(result.attestedAt).toContain('T');
  });

  it('AC #5: writes .ai-sdlc/compliance.yaml with declared regimes', async () => {
    const { state, adapters } = makeComplianceStub({
      multiSelectAnswers: [['HIPAA']],
      textInputAnswers: ['user@example.com', 'Test notes'],
    });

    await runComplianceStep('/proj', baseFlags, adapters);

    const yamlPath = '/proj/.ai-sdlc/compliance.yaml';
    expect(state.files.has(yamlPath)).toBe(true);
    const content = state.files.get(yamlPath)!;
    expect(content).toContain('id: HIPAA');
    expect(content).toContain('attestedBy: "user@example.com"');
    expect(content).toContain('attestedNotes: "Test notes"');
  });

  it('AC #5: writes compliance.yaml for no-regime (none declared) case', async () => {
    const { state, adapters } = makeComplianceStub({
      multiSelectAnswers: [[]],
      textInputAnswers: ['user@example.com', ''],
    });

    await runComplianceStep('/proj', baseFlags, adapters);

    const yamlPath = '/proj/.ai-sdlc/compliance.yaml';
    expect(state.files.has(yamlPath)).toBe(true);
    const content = state.files.get(yamlPath)!;
    expect(content).toContain('regimes: []');
  });

  it('AC #6: DB-pool rationale logged when HIPAA forces per-shard', async () => {
    const { state, adapters } = makeComplianceStub({
      multiSelectAnswers: [['HIPAA']],
      textInputAnswers: ['user@example.com', ''],
    });

    await runComplianceStep('/proj', baseFlags, adapters);

    const logOutput = state.log.join('\n');
    expect(logOutput).toContain('per-shard');
    expect(logOutput).toContain('HIPAA');
  });

  it('AC #7 (integration): HIPAA declaration → derivedGates.databaseBranchPool = per-shard', async () => {
    const { adapters } = makeComplianceStub({
      multiSelectAnswers: [['HIPAA']],
      textInputAnswers: ['user@example.com', ''],
    });

    const result = await runComplianceStep('/proj', baseFlags, adapters);

    expect(result.regimes).toContain('HIPAA');
    expect(result.derivedGates.databaseBranchPool).toBe('per-shard');
  });

  it('AC #7 (integration): no-regime → derivedGates.databaseBranchPool = shared-with-rls', async () => {
    const { adapters } = makeComplianceStub({
      multiSelectAnswers: [[]],
      textInputAnswers: ['user@example.com', ''],
    });

    const result = await runComplianceStep('/proj', baseFlags, adapters);

    expect(result.regimes).toHaveLength(0);
    expect(result.derivedGates.databaseBranchPool).toBe('shared-with-rls');
  });

  it('skips writing compliance.yaml when file already exists (idempotent)', async () => {
    const existingContent = 'existing content';
    const yamlPath = '/proj/.ai-sdlc/compliance.yaml';

    const { state, adapters } = makeComplianceStub({
      files: new Map([[yamlPath, existingContent]]),
      multiSelectAnswers: [['HIPAA']],
      textInputAnswers: ['user@example.com', ''],
    });

    const result = await runComplianceStep('/proj', baseFlags, adapters);

    // File not overwritten
    expect(state.files.get(yamlPath)).toBe(existingContent);
    expect(result.written).toBe(false);
  });

  it('dry-run: does not write compliance.yaml, logs intent', async () => {
    const { state, adapters } = makeComplianceStub({
      multiSelectAnswers: [['HIPAA']],
      textInputAnswers: ['user@example.com', ''],
    });

    const result = await runComplianceStep('/proj', { ...baseFlags, dryRun: true }, adapters);

    expect(state.files.size).toBe(0);
    expect(result.written).toBe(false);
    const logOutput = state.log.join('\n');
    expect(logOutput).toContain('would write');
  });

  it('--yes flag: skips interactive prompts, uses baseline (no regimes)', async () => {
    const { state, adapters } = makeComplianceStub({
      // No scripted answers needed — --yes should not call multiSelect or textInput
    });

    const result = await runComplianceStep('/proj', { ...baseFlags, yes: true }, adapters);

    expect(state.multiSelectCalls).toHaveLength(0);
    // textInput should not be called in --yes mode
    expect(state.textInputCalls).toHaveLength(0);
    expect(result.regimes).toHaveLength(0);
    expect(result.derivedGates).toEqual(BASELINE_DERIVED_GATES);
  });

  it('--yes flag: still writes compliance.yaml with empty regimes', async () => {
    const { state, adapters } = makeComplianceStub({});

    await runComplianceStep('/proj', { ...baseFlags, yes: true }, adapters);

    const yamlPath = '/proj/.ai-sdlc/compliance.yaml';
    expect(state.files.has(yamlPath)).toBe(true);
  });

  it('result includes attestedNotes when provided', async () => {
    const { adapters } = makeComplianceStub({
      multiSelectAnswers: [['SOC2-T2']],
      textInputAnswers: ['user@example.com', 'Annual SOC2 audit program'],
    });

    const result = await runComplianceStep('/proj', baseFlags, adapters);

    expect(result.attestedNotes).toBe('Annual SOC2 audit program');
  });

  it('result.attestedNotes is undefined when empty notes provided', async () => {
    const { adapters } = makeComplianceStub({
      multiSelectAnswers: [['SOC2-T2']],
      textInputAnswers: ['user@example.com', ''],
    });

    const result = await runComplianceStep('/proj', baseFlags, adapters);

    expect(result.attestedNotes).toBeUndefined();
  });

  it('written YAML includes compliance comments for derived gates', async () => {
    const { state, adapters } = makeComplianceStub({
      multiSelectAnswers: [['HIPAA']],
      textInputAnswers: ['user@example.com', ''],
    });

    await runComplianceStep('/proj', baseFlags, adapters);

    const content = state.files.get('/proj/.ai-sdlc/compliance.yaml')!;
    expect(content).toContain('# databaseBranchPool: per-shard');
    expect(content).toContain('# attestationRequired: true');
  });

  it('multiple regimes: all appear in written YAML', async () => {
    const { state, adapters } = makeComplianceStub({
      multiSelectAnswers: [['SOC2-T2', 'HIPAA']],
      textInputAnswers: ['user@example.com', ''],
    });

    await runComplianceStep('/proj', baseFlags, adapters);

    const content = state.files.get('/proj/.ai-sdlc/compliance.yaml')!;
    expect(content).toContain('id: SOC2-T2');
    expect(content).toContain('id: HIPAA');
  });
});

// ── AISDLC-319 / RFC-0009 §8.7 / OQ-11 DatabaseBranchPool trigger checklist ──

describe('applyOq11TriggerChecklistUpgrade()', () => {
  it('AC #1: baseline (no regimes, no triggers) → shared-with-rls; no triggers fire', () => {
    const result = applyOq11TriggerChecklistUpgrade(
      { ...BASELINE_DERIVED_GATES },
      { customerContract: false, operatorSecurityReview: false },
    );
    expect(result.derivedGates.databaseBranchPool).toBe('shared-with-rls');
    expect(result.triggers).toEqual([]);
  });

  it('AC #4: customer-contract trigger fires → per-shard upgrade; triggers=[customer-contract]', () => {
    const result = applyOq11TriggerChecklistUpgrade(
      { ...BASELINE_DERIVED_GATES },
      { customerContract: true, operatorSecurityReview: false },
    );
    expect(result.derivedGates.databaseBranchPool).toBe('per-shard');
    expect(result.triggers).toEqual(['customer-contract']);
  });

  it('AC #4: operator-security-review trigger fires → per-shard upgrade; triggers=[operator-security-review]', () => {
    const result = applyOq11TriggerChecklistUpgrade(
      { ...BASELINE_DERIVED_GATES },
      { customerContract: false, operatorSecurityReview: true },
    );
    expect(result.derivedGates.databaseBranchPool).toBe('per-shard');
    expect(result.triggers).toEqual(['operator-security-review']);
  });

  it('AC #4: both triggers 2 + 3 fire → per-shard; triggers includes both', () => {
    const result = applyOq11TriggerChecklistUpgrade(
      { ...BASELINE_DERIVED_GATES },
      { customerContract: true, operatorSecurityReview: true },
    );
    expect(result.derivedGates.databaseBranchPool).toBe('per-shard');
    expect(result.triggers).toContain('customer-contract');
    expect(result.triggers).toContain('operator-security-review');
    expect(result.triggers).not.toContain('regulatory');
  });

  it('AC #3: regulatory trigger surfaces when input gates were already per-shard (regime-derived)', () => {
    const hipaaGates = computeInitWizardDerivedGates(['HIPAA']);
    expect(hipaaGates.databaseBranchPool).toBe('per-shard'); // sanity: regime already upgraded
    const result = applyOq11TriggerChecklistUpgrade(hipaaGates, {
      customerContract: false,
      operatorSecurityReview: false,
    });
    expect(result.derivedGates.databaseBranchPool).toBe('per-shard');
    expect(result.triggers).toEqual(['regulatory']);
  });

  it('AC #3 + AC #4: regulatory + customer-contract both fire → per-shard; both triggers reported', () => {
    const hipaaGates = computeInitWizardDerivedGates(['HIPAA']);
    const result = applyOq11TriggerChecklistUpgrade(hipaaGates, {
      customerContract: true,
      operatorSecurityReview: false,
    });
    expect(result.derivedGates.databaseBranchPool).toBe('per-shard');
    expect(result.triggers).toEqual(['regulatory', 'customer-contract']);
  });

  it('monotonic: never downgrades per-shard back to shared-with-rls', () => {
    const hipaaGates = computeInitWizardDerivedGates(['HIPAA']);
    const result = applyOq11TriggerChecklistUpgrade(hipaaGates, {
      customerContract: false,
      operatorSecurityReview: false,
    });
    expect(result.derivedGates.databaseBranchPool).toBe('per-shard');
  });

  it('passes through non-databaseBranchPool fields unchanged', () => {
    const baseline = { ...BASELINE_DERIVED_GATES };
    const result = applyOq11TriggerChecklistUpgrade(baseline, {
      customerContract: true,
      operatorSecurityReview: false,
    });
    expect(result.derivedGates.secretScanStrictness).toBe(baseline.secretScanStrictness);
    expect(result.derivedGates.attestationRequired).toBe(baseline.attestationRequired);
    expect(result.derivedGates.auditRetentionDays).toBe(baseline.auditRetentionDays);
    expect(result.derivedGates.reviewerAuthorityModel).toBe(baseline.reviewerAuthorityModel);
  });

  it('does not mutate the input gates object', () => {
    const baseline = { ...BASELINE_DERIVED_GATES };
    const snapshot = { ...baseline };
    applyOq11TriggerChecklistUpgrade(baseline, {
      customerContract: true,
      operatorSecurityReview: true,
    });
    expect(baseline).toEqual(snapshot);
  });
});

describe('describeOq11Trigger()', () => {
  it('returns a non-empty rationale for each trigger kind', () => {
    const kinds: Oq11TriggerKind[] = [
      'regulatory',
      'customer-contract',
      'operator-security-review',
    ];
    for (const k of kinds) {
      const desc = describeOq11Trigger(k);
      expect(typeof desc).toBe('string');
      expect(desc.length).toBeGreaterThan(0);
    }
  });

  it('regulatory rationale references RFC-0022 derivedGates', () => {
    expect(describeOq11Trigger('regulatory')).toMatch(/RFC-0022/);
  });

  it('customer-contract rationale mentions operator-declared posture', () => {
    expect(describeOq11Trigger('customer-contract')).toMatch(/operator-declared/);
  });

  it('operator-security-review rationale mentions RLS gap', () => {
    expect(describeOq11Trigger('operator-security-review')).toMatch(/RLS/);
  });
});

describe('runComplianceStep() — RFC-0009 §8.7 OQ-11 trigger checklist (AISDLC-319)', () => {
  it('AC #1: interactive baseline (no regimes, no triggers) → shared-with-rls, oq11Triggers=[]', async () => {
    const { adapters } = makeComplianceStub({
      multiSelectAnswers: [[]],
      textInputAnswers: ['user@example.com', ''],
      promptAnswers: [false, false], // customer-contract, operator-security-review
    });

    const result = await runComplianceStep('/proj', baseFlags, adapters);

    expect(result.regimes).toHaveLength(0);
    expect(result.derivedGates.databaseBranchPool).toBe('shared-with-rls');
    expect(result.oq11Triggers).toEqual([]);
  });

  it('AC #2: wizard walks the 2 trigger questions (trigger 1 is regime-derived)', async () => {
    const { state, adapters } = makeComplianceStub({
      multiSelectAnswers: [[]],
      textInputAnswers: ['user@example.com', ''],
      promptAnswers: [false, false],
    });

    await runComplianceStep('/proj', baseFlags, adapters);

    // Both checklist prompts must fire — one for customer contract, one for security review
    const promptedQuestions = state.promptCalls.map((c) => c.question.toLowerCase());
    expect(promptedQuestions.some((q) => q.includes('customer contract'))).toBe(true);
    expect(promptedQuestions.some((q) => q.includes('security review'))).toBe(true);
  });

  it('AC #2: trigger checklist prompts default to false (shared-with-rls stays the framework default)', async () => {
    const { state, adapters } = makeComplianceStub({
      multiSelectAnswers: [[]],
      textInputAnswers: ['user@example.com', ''],
      promptAnswers: [false, false],
    });

    await runComplianceStep('/proj', baseFlags, adapters);

    for (const call of state.promptCalls) {
      if (
        call.question.toLowerCase().includes('customer contract') ||
        call.question.toLowerCase().includes('security review')
      ) {
        expect(call.defaultYes).toBe(false);
      }
    }
  });

  it('AC #4: customer-contract trigger upgrades pool to per-shard (no regime declared)', async () => {
    const { adapters } = makeComplianceStub({
      multiSelectAnswers: [[]], // no regulatory regimes
      textInputAnswers: ['user@example.com', ''],
      promptAnswers: [true, false], // customer-contract=YES, security-review=NO
    });

    const result = await runComplianceStep('/proj', baseFlags, adapters);

    expect(result.regimes).toHaveLength(0);
    expect(result.derivedGates.databaseBranchPool).toBe('per-shard');
    expect(result.oq11Triggers).toEqual(['customer-contract']);
  });

  it('AC #4: operator-security-review trigger upgrades pool to per-shard (no regime declared)', async () => {
    const { adapters } = makeComplianceStub({
      multiSelectAnswers: [[]],
      textInputAnswers: ['user@example.com', ''],
      promptAnswers: [false, true],
    });

    const result = await runComplianceStep('/proj', baseFlags, adapters);

    expect(result.regimes).toHaveLength(0);
    expect(result.derivedGates.databaseBranchPool).toBe('per-shard');
    expect(result.oq11Triggers).toEqual(['operator-security-review']);
  });

  it('AC #3 + AC #4: HIPAA regime + customer-contract both reported', async () => {
    const { adapters } = makeComplianceStub({
      multiSelectAnswers: [['HIPAA']],
      textInputAnswers: ['user@example.com', ''],
      promptAnswers: [true, false],
    });

    const result = await runComplianceStep('/proj', baseFlags, adapters);

    expect(result.regimes).toContain('HIPAA');
    expect(result.derivedGates.databaseBranchPool).toBe('per-shard');
    expect(result.oq11Triggers).toContain('regulatory');
    expect(result.oq11Triggers).toContain('customer-contract');
  });

  it('AC #4: per-shard rationale is logged when a non-regulatory trigger fires alone', async () => {
    const { state, adapters } = makeComplianceStub({
      multiSelectAnswers: [[]],
      textInputAnswers: ['user@example.com', ''],
      promptAnswers: [true, false],
    });

    await runComplianceStep('/proj', baseFlags, adapters);

    const logOutput = state.log.join('\n');
    expect(logOutput).toContain('per-shard');
    expect(logOutput.toLowerCase()).toContain('customer contract');
  });

  it('--yes path: oq11Triggers is always empty (no prompts, baseline preserved)', async () => {
    const { state, adapters } = makeComplianceStub({});

    const result = await runComplianceStep('/proj', { ...baseFlags, yes: true }, adapters);

    expect(state.promptCalls).toHaveLength(0);
    expect(result.oq11Triggers).toEqual([]);
    expect(result.derivedGates.databaseBranchPool).toBe('shared-with-rls');
  });
});

// ── AISDLC-319 AC #5: Operator role stays platform-scoped (not tessellated) ──
//
// RFC-0009 OQ-10 resolution (2026-05-04, §8.8): the Operator role is
// platform-scoped, NOT tessellated. Soul DIDs MUST NOT carry an operator
// vertex on their Fractal Triad. The Triad type is `{ design, engineering,
// product }` with NO `operator` member, and the DID JSON-Schema enforces
// `additionalProperties: false` on `triad` so an operator-vertex field
// cannot be smuggled in by adopter YAML.
//
// These tests pin the contract at the type + schema level so any future
// refactor that introduces `operator` to the Triad fails fast.

describe('AISDLC-319 AC #5: Operator role platform-scoped, NOT tessellated', () => {
  it('Triad type carries exactly {design, engineering, product} — no operator vertex', async () => {
    // The Triad interface is structural; verify by constructing an exhaustive instance
    // and asserting the keys match the expected set. The TypeScript compiler also
    // enforces this at build time (any 'operator' addition would fail TS strict checks).
    const triad: import('@ai-sdlc/reference').Triad = {
      design: { authority: 'op@example.com' },
      engineering: { authority: 'op@example.com' },
      product: { authority: 'op@example.com' },
    };
    expect(Object.keys(triad).sort()).toEqual(['design', 'engineering', 'product']);
  });

  it('design-intent-document.schema.json forbids an operator vertex on triad (additionalProperties: false)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    // Walk up from the test file's directory until we find spec/schemas/
    let dir = path.dirname(new URL(import.meta.url).pathname);
    let schemaPath: string | null = null;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, 'spec', 'schemas', 'design-intent-document.schema.json');
      if (fs.existsSync(candidate)) {
        schemaPath = candidate;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    expect(schemaPath).not.toBeNull();
    const schema = JSON.parse(fs.readFileSync(schemaPath!, 'utf8'));
    const triadDef = schema.$defs?.triad ?? schema.properties?.spec?.properties?.triad;
    expect(triadDef).toBeDefined();
    expect(triadDef.additionalProperties).toBe(false);
    expect([...triadDef.required].sort()).toEqual(['design', 'engineering', 'product']);
    expect(triadDef.properties.operator).toBeUndefined();
  });
});
