/**
 * `ai-sdlc init` interactive wizard + feature dispatcher (AISDLC-143).
 *
 * Per Q4(b) of the operator-ratified quality-gate redesign, `ai-sdlc init`
 * is a wizard by default with `--yes` for non-interactive (CI/scripts) and
 * `--with-X` flags for explicit opt-in (`--with-dor`, `--with-attestation`,
 * `--with-classifier`, `--with-branch-protection`). This module owns:
 *
 *   1. The ordered prompt list (resolveFeatureSelection).
 *   2. The feature-toggle → file-write dispatcher (applyFeatureSelection).
 *   3. The branch-protection helper (applyBranchProtection) including the
 *      `--dry-run` JSON-print path required by AC #6.
 *   4. The "next steps" summary printed at the end of init (AC #5).
 *   5. The compliance-posture wizard step (RFC-0022 §7 / AISDLC-324).
 *
 * Test surface: every public function takes a small options bag with
 * injectable side-effect adapters (prompter, writeFile, runCommand) so the
 * test suite can drive every wizard branch hermetically without spinning
 * up a TTY or shelling out to `gh`. Production callers in `init.ts` pass
 * the real adapters.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import type { DerivedGates } from '../../compliance/types.js';
import { BASELINE_DERIVED_GATES } from '../../compliance/types.js';
import {
  ATTESTATION_TEMPLATES,
  BASELINE_WORKFLOW_TEMPLATES,
  CLASSIFIER_TEMPLATES,
  DOR_TEMPLATES,
  HUSKY_PREPUSH_SIGN_SNIPPET,
  SIGNAL_INGESTION_TEMPLATES,
  WORKFLOWS_TEMPLATES,
  type FeatureTemplateSet,
} from './init-templates.js';

// ── Compliance wizard types (RFC-0022 §7 / AISDLC-324) ───────────────────

/**
 * A single regulatory regime option shown in the init wizard multi-select.
 */
export interface ComplianceRegimeChoice {
  /** Canonical regime identifier (e.g. 'HIPAA', 'SOC2-T2'). */
  value: string;
  /** Human-readable label shown in the prompt. */
  label: string;
}

/**
 * Canonical list of regulatory regimes presented in the compliance wizard.
 * Mirrors the entries in spec/compliance/regime-mappings.yaml.
 */
export const COMPLIANCE_REGIME_CHOICES: readonly ComplianceRegimeChoice[] = [
  { value: 'SOC2-T2', label: 'SOC2 Type 2 (Service Organization Control)' },
  { value: 'HIPAA', label: 'HIPAA (Health Insurance Portability and Accountability Act)' },
  { value: 'PCI-DSS-L1', label: 'PCI-DSS Level 1 (Payment Card Industry Data Security Standard)' },
  { value: 'GDPR', label: 'GDPR (General Data Protection Regulation; EU)' },
  { value: 'FedRAMP-Moderate', label: 'FedRAMP Moderate (US federal)' },
  { value: 'ISO-27001:2022', label: 'ISO 27001:2022' },
] as const;

/**
 * Inline regime → DerivedGates mapping for the init wizard.
 * Mirrors spec/compliance/regime-mappings.yaml so the wizard works in
 * installed-package contexts (where the YAML file is not bundled).
 *
 * NOTE: This data is intentionally duplicated from regime-mappings.yaml to
 * avoid a runtime file-read dependency in the init wizard. When regime-mappings.yaml
 * is updated, this table MUST be updated in sync. The RFC-0022 §13 Q7 PR-template
 * compliance-impact checkbox enforces this via reviewer check.
 */
const INIT_WIZARD_REGIME_GATES: Readonly<Record<string, DerivedGates>> = {
  'SOC2-T2': {
    databaseBranchPool: 'per-shard',
    secretScanStrictness: 'strict',
    attestationRequired: true,
    auditRetentionDays: 2555,
    reviewerAuthorityModel: 'allowlist+role',
  },
  HIPAA: {
    databaseBranchPool: 'per-shard',
    secretScanStrictness: 'strict',
    attestationRequired: true,
    auditRetentionDays: 2190,
    reviewerAuthorityModel: 'allowlist+role',
  },
  'PCI-DSS-L1': {
    databaseBranchPool: 'per-shard',
    secretScanStrictness: 'strict',
    attestationRequired: true,
    auditRetentionDays: 365,
    reviewerAuthorityModel: 'allowlist+role',
  },
  GDPR: {
    databaseBranchPool: 'per-shard',
    secretScanStrictness: 'standard',
    attestationRequired: true,
    auditRetentionDays: 365,
    reviewerAuthorityModel: 'allowlist',
  },
  'FedRAMP-Moderate': {
    databaseBranchPool: 'per-shard',
    secretScanStrictness: 'strict',
    attestationRequired: true,
    auditRetentionDays: 1095,
    reviewerAuthorityModel: 'allowlist+role',
  },
  'ISO-27001:2022': {
    databaseBranchPool: 'per-shard',
    secretScanStrictness: 'strict',
    attestationRequired: true,
    auditRetentionDays: 365,
    reviewerAuthorityModel: 'allowlist+role',
  },
} as const;

/**
 * Ordinal scales for tightest-wins composition.
 */
const SECRET_SCAN_ORDINAL: Record<DerivedGates['secretScanStrictness'], number> = {
  minimal: 0,
  standard: 1,
  strict: 2,
};
const REVIEWER_AUTHORITY_ORDINAL: Record<DerivedGates['reviewerAuthorityModel'], number> = {
  open: 0,
  allowlist: 1,
  'allowlist+role': 2,
};

/**
 * Compute DerivedGates from a list of regime IDs using tightest-wins semantics.
 * Unknown regime IDs are skipped (the wizard's informational display degrades
 * gracefully rather than throwing).
 *
 * This is a lightweight inline computation used exclusively by the init wizard.
 * The canonical composer (orchestrator/src/compliance/composer.ts) is used for
 * all post-init runtime gate resolution.
 */
export function computeInitWizardDerivedGates(regimes: string[]): DerivedGates {
  if (regimes.length === 0) return { ...BASELINE_DERIVED_GATES };

  let accumulated: DerivedGates = { ...BASELINE_DERIVED_GATES };

  for (const regimeId of regimes) {
    const entry = INIT_WIZARD_REGIME_GATES[regimeId];
    if (!entry) continue; // Unknown regime — skip gracefully

    // databaseBranchPool: per-shard beats shared-with-rls
    if (entry.databaseBranchPool === 'per-shard') {
      accumulated = { ...accumulated, databaseBranchPool: 'per-shard' };
    }

    // secretScanStrictness: ordinal max
    if (
      SECRET_SCAN_ORDINAL[entry.secretScanStrictness] >
      SECRET_SCAN_ORDINAL[accumulated.secretScanStrictness]
    ) {
      accumulated = { ...accumulated, secretScanStrictness: entry.secretScanStrictness };
    }

    // attestationRequired: boolean OR
    if (entry.attestationRequired) {
      accumulated = { ...accumulated, attestationRequired: true };
    }

    // auditRetentionDays: max
    if (entry.auditRetentionDays > accumulated.auditRetentionDays) {
      accumulated = { ...accumulated, auditRetentionDays: entry.auditRetentionDays };
    }

    // reviewerAuthorityModel: ordinal max
    if (
      REVIEWER_AUTHORITY_ORDINAL[entry.reviewerAuthorityModel] >
      REVIEWER_AUTHORITY_ORDINAL[accumulated.reviewerAuthorityModel]
    ) {
      accumulated = { ...accumulated, reviewerAuthorityModel: entry.reviewerAuthorityModel };
    }
  }

  return accumulated;
}

// ── OQ-11 DatabaseBranchPool trigger checklist (RFC-0009 §8.7 / AISDLC-319) ──

/**
 * RFC-0009 §8.7 enumerates THREE triggers under which the framework's
 * `shared-with-rls` default for `DatabaseBranchPool` is INSUFFICIENT and the
 * operator MUST upgrade to a per-soul (`per-shard`) pool:
 *
 *  1. **Regulatory hard requirement** — HIPAA / PCI-DSS L1 / FedRAMP /
 *     SOC2-with-physical-isolation / regional data residency. The compliance
 *     posture wizard already drives this trigger via `INIT_WIZARD_REGIME_GATES`
 *     (regimes → `databaseBranchPool: 'per-shard'` on `DerivedGates`).
 *
 *  2. **Customer contract** — a vendor agreement explicitly requires tenant
 *     physical isolation, independent of regulatory baseline. Adopter-declared
 *     during `init`; not derivable from RFC-0022.
 *
 *  3. **Operator security review** — an explicit risk identified during
 *     operator security review that RLS cannot mitigate (side-channel,
 *     supply-chain, regulator pre-approval gap). Adopter-declared during
 *     `init`; not derivable from RFC-0022.
 *
 *  If ANY trigger fires → per-soul pool is required. Triggers 2 + 3 are
 *  opt-in answers the init wizard collects directly; trigger 1 is computed
 *  from declared regimes upstream.
 *
 *  Per RFC-0009 OQ-11 resolution (2026-05-04): the framework cannot
 *  auto-detect triggers 2 and 3 — the operator declares them via the wizard
 *  checklist.
 */
export type Oq11TriggerKind = 'regulatory' | 'customer-contract' | 'operator-security-review';

/**
 * Adopter-declared answers for triggers 2 + 3 of the §8.7 checklist.
 * Trigger 1 (regulatory) is sourced from declared regimes, not from this bag.
 */
export interface Oq11TriggerAnswers {
  /** Trigger 2 — customer contract requires tenant physical isolation. */
  customerContract: boolean;
  /** Trigger 3 — operator security review identified a risk RLS cannot mitigate. */
  operatorSecurityReview: boolean;
}

/**
 * Result of applying the OQ-11 trigger checklist on top of regime-derived gates.
 */
export interface Oq11TriggerChecklistResult {
  /** The (possibly upgraded) DerivedGates. `databaseBranchPool` is `per-shard` when any trigger fires. */
  derivedGates: DerivedGates;
  /** Names of the triggers that fired (empty when none fire — shared-with-rls remains). */
  triggers: Oq11TriggerKind[];
}

/**
 * Apply the RFC-0009 §8.7 / OQ-11 trigger checklist on top of regime-derived
 * `DerivedGates`. Upgrades `databaseBranchPool` from `shared-with-rls` to
 * `per-shard` when ANY of the three triggers fires:
 *
 *  - Regulatory: already reflected in `inputGates.databaseBranchPool === 'per-shard'`
 *    (set by `computeInitWizardDerivedGates` when a per-shard-forcing regime was
 *    declared). When this is the case, 'regulatory' is recorded in `triggers`.
 *  - Customer contract: `answers.customerContract === true`.
 *  - Operator security review: `answers.operatorSecurityReview === true`.
 *
 *  The function is monotonic — once `databaseBranchPool` is `per-shard`, it stays
 *  `per-shard`. Other DerivedGates fields are passed through unchanged.
 *
 *  Pure function — no I/O, no side-effects. The wizard wires it into
 *  `runComplianceStep`; tests pin behavior directly.
 */
export function applyOq11TriggerChecklistUpgrade(
  inputGates: DerivedGates,
  answers: Oq11TriggerAnswers,
): Oq11TriggerChecklistResult {
  const triggers: Oq11TriggerKind[] = [];

  // Trigger 1 (regulatory) — surfaces only when the gate was already
  // upgraded upstream by a per-shard-forcing regime declaration.
  if (inputGates.databaseBranchPool === 'per-shard') {
    triggers.push('regulatory');
  }

  if (answers.customerContract) {
    triggers.push('customer-contract');
  }
  if (answers.operatorSecurityReview) {
    triggers.push('operator-security-review');
  }

  const upgraded = triggers.length > 0;
  return {
    derivedGates: upgraded ? { ...inputGates, databaseBranchPool: 'per-shard' } : { ...inputGates },
    triggers,
  };
}

/**
 * Human-readable line for each trigger kind, shown in the wizard summary so
 * the operator can see WHY the framework selected `per-shard`.
 */
export function describeOq11Trigger(kind: Oq11TriggerKind): string {
  switch (kind) {
    case 'regulatory':
      return 'regulatory regime declared in .ai-sdlc/compliance.yaml (RFC-0022 derivedGates)';
    case 'customer-contract':
      return 'customer contract requires tenant physical isolation (operator-declared)';
    case 'operator-security-review':
      return 'operator security review identified a risk RLS cannot mitigate (operator-declared)';
  }
}

/**
 * Result of the compliance posture wizard step.
 */
export interface ComplianceStepResult {
  /** Regime IDs declared by the operator (empty = "(none declared)" baseline). */
  regimes: string[];
  /** Who attested the regimes apply. Auto-filled from git config user.email. */
  attestedBy: string;
  /** ISO-8601 timestamp of attestation. Auto-filled at wizard run time. */
  attestedAt: string;
  /** Optional operator rationale for the attestation. */
  attestedNotes?: string;
  /** Derived gate values computed from the declared regimes (+ §8.7 trigger upgrade). */
  derivedGates: DerivedGates;
  /**
   * Triggers from the RFC-0009 §8.7 / OQ-11 checklist that fired during this
   * wizard run (empty when none fired — shared-with-rls is sufficient).
   */
  oq11Triggers: Oq11TriggerKind[];
  /** Absolute path of the written compliance.yaml file. */
  yamlPath: string;
  /** True if compliance.yaml was written; false in dry-run or if already exists. */
  written: boolean;
}

/**
 * Build the .ai-sdlc/compliance.yaml content for a given compliance declaration.
 *
 * The written file contains the declared `spec.regimes` with attestation metadata.
 * The computed `derivedGates` are added as YAML comments (read-only reference)
 * so the loader continues to compute them from regimes (not from spec.derivedGates,
 * which is the operator-override field requiring _notes for each entry).
 *
 * Pure function — no filesystem side-effects, fully testable.
 */
export function buildComplianceYaml(opts: {
  projectName: string;
  regimes: string[];
  attestedBy: string;
  attestedAt: string;
  attestedNotes?: string;
  derivedGates: DerivedGates;
}): string {
  const { projectName, regimes, attestedBy, attestedAt, attestedNotes, derivedGates } = opts;

  // AISDLC-324 review fix: quote attestedBy/id/attestedAt so an operator
  // git config user.email containing ": " or other YAML-significant chars
  // can't break the YAML structure. attestedNotes already quoted+escaped.
  const quotedAttestedBy = `"${attestedBy.replace(/"/g, '\\"')}"`;
  const regimeItems = regimes
    .map((id) => {
      // id is from hardcoded COMPLIANCE_REGIME_CHOICES (validated upstream)
      // so it's safe to emit unquoted; YAML-significant chars never reach here.
      const lines = [
        `    - id: ${id}`,
        `      attestedBy: ${quotedAttestedBy}`,
        `      attestedAt: "${attestedAt}"`,
      ];
      if (attestedNotes) {
        lines.push(`      attestedNotes: "${attestedNotes.replace(/"/g, '\\"')}"`);
      }
      return lines.join('\n');
    })
    .join('\n');

  const derivedGatesComment = [
    '# --- Derived gates (computed from declared regimes; read-only) ---',
    `# databaseBranchPool: ${derivedGates.databaseBranchPool}`,
    `# secretScanStrictness: ${derivedGates.secretScanStrictness}`,
    `# attestationRequired: ${derivedGates.attestationRequired}`,
    `# auditRetentionDays: ${derivedGates.auditRetentionDays}`,
    `# reviewerAuthorityModel: ${derivedGates.reviewerAuthorityModel}`,
    '#',
    '# To override a gate, add spec.derivedGates.<field> with a sibling _notes entry.',
    '# See docs/operations/compliance-posture.md for override patterns.',
  ].join('\n');

  // AISDLC-324 review fix: avoid duplicate `regimes:` key when empty.
  // Inline `[]` for empty case; emit block under `regimes:` for non-empty.
  const regimesSection = regimes.length === 0 ? `  regimes: []` : `  regimes:\n${regimeItems}`;

  return [
    `apiVersion: ai-sdlc.io/v1alpha1`,
    `kind: CompliancePosture`,
    `metadata:`,
    `  name: "${projectName.replace(/"/g, '\\"')}"`,
    `spec:`,
    regimesSection,
    `  auditExports: []`,
    '',
    derivedGatesComment,
    '',
  ].join('\n');
}

/**
 * Format the derived gates for console display (the "✓ Wrote ... with derived gates:" block).
 */
export function formatDerivedGatesDisplay(derivedGates: DerivedGates): string {
  return [
    `   databaseBranchPool: ${derivedGates.databaseBranchPool}`,
    `   secretScanStrictness: ${derivedGates.secretScanStrictness}`,
    `   attestationRequired: ${derivedGates.attestationRequired}`,
    `   auditRetentionDays: ${derivedGates.auditRetentionDays}`,
    `   reviewerAuthorityModel: ${derivedGates.reviewerAuthorityModel}`,
  ].join('\n');
}

/**
 * DB-pool rationale displayed when a compliance regime forces `per-shard`.
 * Returns null if the DB-pool is `shared-with-rls` (no rationale needed).
 */
export function getDbPoolRationale(regimes: string[], derivedGates: DerivedGates): string | null {
  if (derivedGates.databaseBranchPool !== 'per-shard') return null;
  if (regimes.length === 0) return null;
  const forcingRegimes = regimes.filter(
    (id) => INIT_WIZARD_REGIME_GATES[id]?.databaseBranchPool === 'per-shard',
  );
  if (forcingRegimes.length === 0) return null;
  return `  (${forcingRegimes.join(', ')} declared at .ai-sdlc/compliance.yaml requires per-shard isolation)`;
}

/**
 * Run the compliance posture wizard step (RFC-0022 §7 / AISDLC-324).
 *
 * Inserted into the init wizard BEFORE the gate-config feature prompts.
 * Always runs — even for unregulated projects (declaring "(none)" is the
 * explicit choice; the resulting compliance.yaml carries that decision).
 *
 * Flow:
 *  1. Auto-detect git config user.email for attestedBy default.
 *  2. If --yes or non-TTY: use baseline (no regimes), auto-fill attestedBy.
 *  3. Otherwise: multi-select regimes, text-input attestedBy + notes.
 *  4. Compute derivedGates via inline tightest-wins composition.
 *  5. Write .ai-sdlc/compliance.yaml (skips if file already exists and not
 *     in --add compliance mode).
 *  6. Log derived gates + DB-pool rationale.
 */
export async function runComplianceStep(
  projectDir: string,
  flags: WizardFlags,
  adapters: FeatureAdapters,
): Promise<ComplianceStepResult> {
  const compliancePath = join(projectDir, '.ai-sdlc', 'compliance.yaml');

  // ── Auto-detect git email for attestedBy default ──────────────────────
  let gitEmail = '';
  try {
    const result = adapters.runCommand('git', ['config', 'user.email']);
    if (result.exitCode === 0) {
      gitEmail = result.stdout.trim();
    }
  } catch {
    // Ignore — git config may not be set; attestedBy will be empty default
  }

  // Resolve project name from git remote or directory basename.
  const projectName = (() => {
    try {
      const r = adapters.runCommand('git', ['remote', 'get-url', 'origin']);
      if (r.exitCode === 0) {
        // Extract repo name from remote URL (ssh: git@github.com:org/repo.git, https: .../org/repo.git)
        const m = r.stdout.trim().match(/\/([^/]+?)(\.git)?$/);
        if (m) return m[1];
      }
    } catch {
      // Ignore
    }
    return basename(projectDir);
  })();

  // ── --yes / non-TTY path: baseline (no regimes, no triggers) ──────────
  if (flags.yes || !process.stdin.isTTY) {
    const derivedGates = computeInitWizardDerivedGates([]);
    const attestedAt = new Date().toISOString();
    const written = writeComplianceYaml({
      projectDir,
      compliancePath,
      projectName,
      regimes: [],
      attestedBy: gitEmail,
      attestedAt,
      attestedNotes: undefined,
      derivedGates,
      flags,
      adapters,
    });
    adapters.log('');
    adapters.log(`  Compliance posture: no regimes declared (unregulated baseline)`);
    adapters.log(`  derivedGates: ${JSON.stringify(derivedGates)}`);
    return {
      regimes: [],
      attestedBy: gitEmail,
      attestedAt,
      attestedNotes: undefined,
      derivedGates,
      oq11Triggers: [],
      yamlPath: compliancePath,
      written,
    };
  }

  // ── Interactive path ──────────────────────────────────────────────────
  adapters.log('> Compliance posture');
  adapters.log('');

  const selectedRegimes = await adapters.multiSelect(
    'Which regulatory regimes apply to this project? (space to toggle, enter to confirm)',
    COMPLIANCE_REGIME_CHOICES as ComplianceRegimeChoice[],
  );

  const attestedBy = await adapters.textInput(
    'Who is attesting these regimes apply?',
    gitEmail || undefined,
  );

  const attestedNotesRaw = await adapters.textInput(
    'Notes on the attestation (optional, audit-visible):',
    undefined,
  );
  const attestedNotes = attestedNotesRaw.trim() || undefined;

  const attestedAt = new Date().toISOString();
  const regimeDerivedGates = computeInitWizardDerivedGates(selectedRegimes);

  // ── RFC-0009 §8.7 / OQ-11 trigger checklist (AISDLC-319) ──────────────
  // Trigger 1 (regulatory) is already reflected in `regimeDerivedGates`;
  // collect triggers 2 + 3 from the operator. The framework cannot auto-detect
  // these (per RFC-0009 §8.7) — operator declares.
  adapters.log('');
  adapters.log('> DatabaseBranchPool trigger checklist (RFC-0009 §8.7)');
  adapters.log('  Default is shared pool with row-level-security isolation. Answer Yes only');
  adapters.log('  if the trigger actually applies — per-soul pools add operational complexity.');

  const customerContract = await adapters.prompt(
    'Does any customer contract require tenant physical isolation (independent of regulatory baseline)?',
    false,
  );
  const operatorSecurityReview = await adapters.prompt(
    'Has operator security review identified a risk that RLS cannot mitigate?',
    false,
  );

  const triggerResult = applyOq11TriggerChecklistUpgrade(regimeDerivedGates, {
    customerContract,
    operatorSecurityReview,
  });
  const derivedGates = triggerResult.derivedGates;
  const oq11Triggers = triggerResult.triggers;

  const written = writeComplianceYaml({
    projectDir,
    compliancePath,
    projectName,
    regimes: selectedRegimes,
    attestedBy,
    attestedAt,
    attestedNotes,
    derivedGates,
    flags,
    adapters,
  });

  adapters.log('');
  if (written) {
    adapters.log(`✓ Wrote .ai-sdlc/compliance.yaml with derived gates:`);
  } else {
    adapters.log(
      `  .ai-sdlc/compliance.yaml already exists — skipped (run --add compliance to update)`,
    );
    adapters.log(`  Derived gates (from existing compliance.yaml, if unchanged):`);
  }
  adapters.log(formatDerivedGatesDisplay(derivedGates));

  // DB-pool rationale: surface BOTH the regime-derived rationale (AC #6) and
  // the OQ-11 trigger checklist rationale (AISDLC-319 AC #2/#4).
  const dbRationale = getDbPoolRationale(selectedRegimes, derivedGates);
  if (dbRationale) {
    adapters.log('');
    adapters.log(`  DatabaseBranchPool pre-selection: per-shard`);
    adapters.log(dbRationale);
  } else if (oq11Triggers.length > 0) {
    // Triggers 2 / 3 fired but no regulatory trigger — explain the upgrade.
    adapters.log('');
    adapters.log(`  DatabaseBranchPool pre-selection: per-shard`);
    adapters.log(`  (RFC-0009 §8.7 trigger fired:`);
    for (const t of oq11Triggers) {
      if (t === 'regulatory') continue; // already covered by dbRationale path
      adapters.log(`    - ${describeOq11Trigger(t)}`);
    }
    adapters.log(`  )`);
  }

  adapters.log('');
  adapters.log(`  Review with: cat .ai-sdlc/compliance.yaml`);
  adapters.log(
    `  Override any field with the attestedNotes pattern (see docs/operations/compliance-posture.md).`,
  );

  return {
    regimes: selectedRegimes,
    attestedBy,
    attestedAt,
    attestedNotes,
    derivedGates,
    oq11Triggers,
    yamlPath: compliancePath,
    written,
  };
}

/** Helper: write .ai-sdlc/compliance.yaml (or skip if exists). Returns true if written. */
function writeComplianceYaml(opts: {
  projectDir: string;
  compliancePath: string;
  projectName: string;
  regimes: string[];
  attestedBy: string;
  attestedAt: string;
  attestedNotes?: string;
  derivedGates: DerivedGates;
  flags: WizardFlags;
  adapters: FeatureAdapters;
}): boolean {
  const { compliancePath, flags, adapters } = opts;

  if (flags.dryRun) {
    adapters.log(`  would write .ai-sdlc/compliance.yaml`);
    return false;
  }

  if (adapters.exists(compliancePath)) {
    return false;
  }

  const yamlContent = buildComplianceYaml({
    projectName: opts.projectName,
    regimes: opts.regimes,
    attestedBy: opts.attestedBy,
    attestedAt: opts.attestedAt,
    attestedNotes: opts.attestedNotes,
    derivedGates: opts.derivedGates,
  });

  adapters.mkdirp(join(opts.projectDir, '.ai-sdlc'));
  adapters.writeFile(compliancePath, yamlContent);
  return true;
}

// ── Types ────────────────────────────────────────────────────────────────

/** Per-feature on/off bits derived from prompts + flags. */
export interface FeatureSelection {
  dor: boolean;
  attestation: boolean;
  classifier: boolean;
  branchProtection: boolean;
  /**
   * `workflows` — scaffold the full GitHub Actions workflow bundle
   * (ai-sdlc-gate, verify-attestation, ai-sdlc-review, auto-enable-auto-merge).
   * Enabled by `--with-workflows` flag or `--add workflows` subcommand (AISDLC-261).
   */
  workflows: boolean;
  /**
   * `signalIngestion` — scaffold the RFC-0030 signal-ingestion config stub at
   * `.ai-sdlc/signal-ingestion.yaml` (Phase 6 / AISDLC-348). The file ships
   * `enabled: false`; the pipeline runtime stays dark until the operator
   * explicitly flips it AND opts in via `AI_SDLC_SIGNAL_INGESTION` during
   * the soak window. Default OFF in `--yes` mode (per the soak convention)
   * but available via `--with-signal-ingestion` / `--add signal-ingestion`.
   */
  signalIngestion: boolean;
}

/** All feature flags off — used as the initial state before flags + prompts. */
export const NO_FEATURES: FeatureSelection = {
  dor: false,
  attestation: false,
  classifier: false,
  branchProtection: false,
  workflows: false,
  signalIngestion: false,
};

/**
 * All features on — the answer used by `--yes` (accept all defaults).
 *
 * Note: `signalIngestion` is deliberately FALSE in this set even though
 * `--yes` accepts all *defaults*. RFC-0030's pipeline is gated by the
 * `AI_SDLC_SIGNAL_INGESTION` env flag during its soak window, and the
 * shipped default for the flag is OFF. Scaffolding the config stub on a
 * fresh adopter who hasn't opted in would be noise; the file is only
 * meaningful when the operator has explicit interest. Adopters opt in
 * via `--with-signal-ingestion` or `--add signal-ingestion`.
 */
export const ALL_FEATURES: FeatureSelection = {
  dor: true,
  attestation: true,
  classifier: true,
  branchProtection: true,
  workflows: true,
  signalIngestion: false,
};

/** Flag-bag controlling wizard behavior (already parsed from argv). */
export interface WizardFlags {
  /** `--yes` short-circuits the wizard; treats every prompt as "yes". */
  yes: boolean;
  /** `--with-dor` forces the DoR feature on without prompting. */
  withDor: boolean;
  /** `--with-attestation` forces attestation infra on without prompting. */
  withAttestation: boolean;
  /** `--with-classifier` forces the classifier on without prompting. */
  withClassifier: boolean;
  /** `--with-branch-protection` forces branch-protection on without prompting. */
  withBranchProtection: boolean;
  /**
   * `--with-workflows` scaffolds the full GitHub Actions workflow bundle
   * (ai-sdlc-gate, verify-attestation, ai-sdlc-review, auto-enable-auto-merge)
   * without prompting (AISDLC-261).
   */
  withWorkflows: boolean;
  /**
   * `--with-signal-ingestion` scaffolds the RFC-0030 signal-ingestion config
   * stub at `.ai-sdlc/signal-ingestion.yaml` without prompting (AISDLC-348).
   * The file ships `enabled: false`; the pipeline stays dark until the
   * operator explicitly opts in. Always OFF by default in `--yes` mode.
   */
  withSignalIngestion: boolean;
  /**
   * `--add <feature>` extends an already-initialized repo with a single
   * feature without re-prompting. AC #7 (idempotent extension). When set,
   * the wizard short-circuits to scaffold ONLY this feature.
   */
  add?:
    | 'dor'
    | 'attestation'
    | 'classifier'
    | 'branch-protection'
    | 'workflows'
    | 'signal-ingestion';
  /** `--dry-run` — print what would be done, don't write. */
  dryRun: boolean;
  /**
   * `--workspace <name>` opts into a per-workspace install at
   * `packages/<name>/.ai-sdlc/` instead of the git-root default.
   * Only relevant when the git root already has an `.ai-sdlc/` directory
   * (e.g. the repo root already has AI-SDLC installed and the operator
   * wants to add a child-workspace install). Without this flag, init
   * refuses to nest if the git root already has `.ai-sdlc/`.
   */
  workspace?: string;
  /**
   * `--force` — when set, overwrite workflow files that already exist instead
   * of skipping them. Only applies to the `workflows` feature (AISDLC-261).
   */
  force: boolean;
}

/**
 * Single-question prompter contract — accepts a question + default and
 * returns the user's answer. The production adapter wraps `@inquirer/prompts`
 * so the user gets a real readline TTY; tests inject a stub that returns
 * scripted answers without touching stdin.
 *
 * Why a single-question primitive instead of "ask all questions at once":
 * the prompts are conditional in some cases (e.g. branch-protection only
 * makes sense after the user has chosen which CI gates exist). Keeping
 * the primitive small lets `resolveFeatureSelection` decide ordering +
 * skip questions whose answer is already determined by a `--with-X` flag.
 */
export type Prompter = (question: string, defaultYes: boolean) => Promise<boolean>;

/**
 * Side-effect adapter bag — every part of the dispatcher that touches
 * disk or shells out goes through this so tests can assert on intents
 * without mocking `node:fs` globally.
 */
export interface FeatureAdapters {
  /** Resolve to an interactive prompt answer. */
  prompt: Prompter;
  /** Write a file. Production = `node:fs.writeFileSync`. */
  writeFile: (path: string, contents: string) => void;
  /**
   * Append `contents` to `path` exactly once: if `sentinel` is already
   * present in the file, no-op. If the file doesn't exist, behaves like
   * a write. Used for the husky pre-push sign block + CLAUDE.md pointer
   * (both of which need to coexist with user-edited content).
   */
  appendOnce: (path: string, contents: string, sentinel: string) => 'appended' | 'skipped';
  /** mkdir -p. Production = `node:fs.mkdirSync({ recursive: true })`. */
  mkdirp: (path: string) => void;
  /** Test for path existence. Production = `node:fs.existsSync`. */
  exists: (path: string) => boolean;
  /** Run a shell command (used for `gh api`). Production = `execSync`. */
  runCommand: (cmd: string, args: string[]) => { stdout: string; exitCode: number };
  /** Sink for operator-visible output (defaults to console.log). */
  log: (line: string) => void;
  /**
   * Multi-select prompt — returns the array of selected choice values.
   * Production adapter uses `@inquirer/prompts` `checkbox`.
   * Tests inject a stub that returns scripted selections.
   */
  multiSelect: (question: string, choices: ComplianceRegimeChoice[]) => Promise<string[]>;
  /**
   * Text input prompt — returns the entered string.
   * Production adapter uses `@inquirer/prompts` `input`.
   * Tests inject a stub that returns scripted values.
   */
  textInput: (question: string, defaultValue?: string) => Promise<string>;
}

// ── Install-target resolution (AISDLC-262) ───────────────────────────────

/**
 * Result returned by `resolveInstallTarget`. The caller uses `installDir`
 * as the `projectDir` argument passed down to `initProject` and the wizard
 * stage. The `resolved` flag is true when the target differs from `cwd`
 * (i.e. we walked up to the git root).
 */
export interface InstallTargetResult {
  /** Absolute path to the directory where `.ai-sdlc/` should be written. */
  installDir: string;
  /** True when `installDir !== cwd` (we resolved up to the git root). */
  resolved: boolean;
  /** Error message when the target is refused; installDir is unset in this case. */
  error?: string;
}

/**
 * Options bag for `resolveInstallTarget`. Adapters allow tests to inject
 * controlled filesystem / subprocess behaviour without touching real disk.
 */
export interface ResolveInstallTargetOptions {
  /** Working directory to start from (defaults to `process.cwd()`). */
  cwd?: string;
  /** The `--workspace <name>` flag value, if provided. */
  workspace?: string;
  /** Config directory name (defaults to `.ai-sdlc`). */
  configDirName?: string;
  /**
   * Override for `git rev-parse --show-toplevel`. Receives the cwd and
   * returns the git root path, or throws if not inside a git repo.
   */
  gitShowToplevel?: (cwd: string) => string;
  /** Override for existence checks (defaults to `node:fs.existsSync`). */
  exists?: (path: string) => boolean;
  /**
   * When true, skip the "already installed at <root>" nesting check.
   * Used by the `--add <feature>` extension path, which intentionally
   * extends an already-initialized repo (the existing `.ai-sdlc/` IS
   * the install the operator wants to extend).
   */
  skipExistingCheck?: boolean;
}

/**
 * Resolve the AI-SDLC install target directory for the current invocation
 * (AISDLC-262).
 *
 * ## Default behavior (no `--workspace` flag)
 *
 * 1. Shell out to `git rev-parse --show-toplevel` to find the repo root.
 *    - If the cwd is not inside a git repo, install at cwd (plain-dir
 *      fallback — same as the pre-AISDLC-262 behavior).
 * 2. If `<git-root>/.ai-sdlc/` **already exists**, refuse with a clear
 *    "already installed at <root>; pass --workspace <name>" message so
 *    the operator knows exactly what to do next.
 * 3. Otherwise install at the git root.
 *
 * ## `--workspace <name>` mode
 *
 * The operator explicitly wants a per-workspace install at
 * `packages/<name>/.ai-sdlc/` (or `<name>/.ai-sdlc/` if `packages/` does
 * not exist under the git root). No nesting check is performed — the
 * operator has opted in.
 *
 * ## Dry-run output
 *
 * The resolved `installDir` is logged by the caller on the FIRST output
 * line so adopters can sanity-check the target before any files are written.
 */
export function resolveInstallTarget(opts: ResolveInstallTargetOptions = {}): InstallTargetResult {
  const cwd = opts.cwd ?? process.cwd();
  const configDirName = opts.configDirName ?? '.ai-sdlc';
  const exists = opts.exists ?? existsSync;

  // Resolve git root (or fall back to cwd when not in a git repo).
  let gitRoot: string;
  try {
    const getToplevel =
      opts.gitShowToplevel ??
      ((dir: string) =>
        execSync(`git rev-parse --show-toplevel`, {
          cwd: dir,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim());
    gitRoot = getToplevel(cwd);
  } catch {
    // Not inside a git repo — install at cwd (plain-dir fallback).
    gitRoot = cwd;
  }

  if (opts.workspace) {
    // Per-workspace install: `<git-root>/packages/<name>` if packages/ exists,
    // otherwise `<git-root>/<name>`.
    const packagesDir = join(gitRoot, 'packages');
    const workspaceBase = exists(packagesDir) ? packagesDir : gitRoot;
    const installDir = join(workspaceBase, opts.workspace);
    return { installDir, resolved: installDir !== cwd };
  }

  // Default: install at git root. If `.ai-sdlc/` already exists there,
  // refuse with a helpful message — UNLESS `skipExistingCheck` is set
  // (used by `--add <feature>`, which intentionally extends an existing
  // install and thus expects the directory to already be present).
  const rootConfigDir = join(gitRoot, configDirName);
  if (exists(rootConfigDir) && !opts.skipExistingCheck) {
    return {
      installDir: gitRoot,
      resolved: gitRoot !== cwd,
      error:
        `AI-SDLC is already installed at ${gitRoot}; ` +
        `pass --workspace <name> to add a child install at packages/<name>/.ai-sdlc/`,
    };
  }

  return { installDir: gitRoot, resolved: gitRoot !== cwd };
}

// ── Production adapter factory ───────────────────────────────────────────

/**
 * Build the production adapter bag. Pulled into a factory so tests can
 * compose a partial override bag (e.g. only override `prompt`) and let
 * the rest fall through to real disk writes.
 *
 * The `prompt` adapter is a lazy import of `@inquirer/prompts.confirm`
 * so that:
 *   1. Tests don't pay the import cost when they inject their own stub.
 *   2. `--yes` runs (which never call `prompt`) don't pay it either.
 *   3. The orchestrator's runtime `dist/` is smaller for the common case.
 */
export function buildProductionAdapters(): FeatureAdapters {
  return {
    prompt: async (question, defaultYes) => {
      // Lazy import — see docblock above for why.
      const { confirm } = await import('@inquirer/prompts');
      return confirm({ message: question, default: defaultYes });
    },
    multiSelect: async (question, choices) => {
      const { checkbox } = await import('@inquirer/prompts');
      return checkbox({
        message: question,
        choices: choices.map((c) => ({ name: c.label, value: c.value })),
      });
    },
    textInput: async (question, defaultValue) => {
      const { input } = await import('@inquirer/prompts');
      return input({ message: question, default: defaultValue });
    },
    writeFile: (path, contents) => writeFileSync(path, contents, 'utf-8'),
    appendOnce: (path, contents, sentinel) => {
      // Make sure the parent dir exists (appendFileSync errors with ENOENT
      // otherwise; we may be writing into a freshly-created `.husky/`).
      mkdirSync(dirname(path), { recursive: true });
      const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
      if (existing.includes(sentinel)) return 'skipped';
      const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      writeFileSync(path, existing + sep + contents, 'utf-8');
      return 'appended';
    },
    mkdirp: (path) => mkdirSync(path, { recursive: true }),
    exists: (path) => existsSync(path),
    runCommand: (cmd, args) => {
      try {
        // Use `execFileSync` (no shell) so args are passed as a true
        // argv array — never word-split or shell-interpreted. The prior
        // `execSync(\`${cmd} ${args.join(' ')}\`)` form ran the command
        // through `/bin/sh -c` and silently broke whenever any argument
        // contained whitespace (e.g. macOS users with `~/Documents/My
        // Project/` in their projectDir, where the `--input <tmpPath>`
        // arg to `gh api` would word-split and `gh` would see two
        // unrelated tokens — branch protection would silently fail or
        // apply wrong content). Switching to `execFileSync` eliminates
        // both word-splitting AND any shell-injection surface in one
        // change. Stderr stays muted so users still get the clean
        // single-line error rendered by `applyBranchProtection`.
        const stdout = execFileSync(cmd, args, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return { stdout, exitCode: 0 };
      } catch (err) {
        const e = err as { stdout?: Buffer | string; status?: number };
        return {
          stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() ?? ''),
          exitCode: e.status ?? 1,
        };
      }
    },
    log: (line) => console.log(line),
  };
}

// ── Wizard ───────────────────────────────────────────────────────────────

/**
 * Resolve the per-feature on/off vector by combining (in priority order):
 *   1. `--add <feature>` — if set, ONLY that feature is on; everything
 *      else is suppressed (idempotent extension, AC #7).
 *   2. `--yes` — accept every default (every feature on).
 *   3. `--with-X` flags — opt-in without prompting.
 *   4. Interactive prompts for any feature still undetermined.
 *
 * Returns a fully-determined FeatureSelection. The dispatcher then writes
 * exactly the union of features marked true.
 */
export async function resolveFeatureSelection(
  flags: WizardFlags,
  adapters: Pick<FeatureAdapters, 'prompt' | 'log'>,
): Promise<FeatureSelection> {
  // ── Path 1: `--add` — single-feature extension ────────────────────────
  if (flags.add) {
    const sel: FeatureSelection = { ...NO_FEATURES };
    switch (flags.add) {
      case 'dor':
        sel.dor = true;
        break;
      case 'attestation':
        sel.attestation = true;
        break;
      case 'classifier':
        sel.classifier = true;
        break;
      case 'branch-protection':
        sel.branchProtection = true;
        break;
      case 'workflows':
        sel.workflows = true;
        break;
      case 'signal-ingestion':
        sel.signalIngestion = true;
        break;
    }
    return sel;
  }

  // ── Path 2: `--yes` — all defaults on, no prompts ─────────────────────
  if (flags.yes) {
    return { ...ALL_FEATURES };
  }

  // ── Path 2b: non-TTY auto-fall-through ────────────────────────────────
  // When stdin is not a TTY (CI runners, agent bash, piped input, Docker
  // containers without `-it`), interactive prompts hang then throw an
  // unhandled ExitPromptError. Auto-fall-through to ALL_FEATURES (same
  // as --yes) so adopters can run `ai-sdlc init` in CI without any
  // additional flags. This matches the documented behavior of --yes, which
  // is defined as "accept all defaults non-interactively".
  if (!process.stdin.isTTY) {
    adapters.log(
      'Non-TTY stdin detected — auto-accepting all feature defaults (equivalent to --yes).',
    );
    adapters.log('Pass --yes explicitly to suppress this message.');
    return { ...ALL_FEATURES };
  }

  // ── Path 3+4: `--with-X` overrides + prompts for the rest ─────────────
  const sel: FeatureSelection = { ...NO_FEATURES };

  // DoR
  if (flags.withDor) {
    sel.dor = true;
  } else {
    sel.dor = await adapters.prompt('Will this repo use Definition-of-Ready gates?', true);
  }

  // Attestation
  if (flags.withAttestation) {
    sel.attestation = true;
  } else {
    sel.attestation = await adapters.prompt(
      'Do you want attestation infrastructure (audit-only)?',
      true,
    );
  }

  // Classifier
  if (flags.withClassifier) {
    sel.classifier = true;
  } else {
    sel.classifier = await adapters.prompt(
      'Add review classifier for cost-optimized reviews?',
      true,
    );
  }

  // Branch protection
  if (flags.withBranchProtection) {
    sel.branchProtection = true;
  } else {
    sel.branchProtection = await adapters.prompt(
      'Apply recommended branch protection? (required: ai-sdlc/pr-ready + codecov/patch)',
      true,
    );
  }

  // GitHub Actions workflows bundle (AISDLC-261)
  if (flags.withWorkflows) {
    sel.workflows = true;
  } else {
    sel.workflows = await adapters.prompt(
      'Scaffold GitHub Actions workflows (gate, review, attestation, auto-merge)?',
      true,
    );
  }

  // RFC-0030 Signal Ingestion Pipeline (AISDLC-348)
  // Default to FALSE in the interactive prompt: the pipeline is in a soak
  // window gated by AI_SDLC_SIGNAL_INGESTION; scaffolding the config on a
  // fresh adopter who hasn't opted in is noise. Opt-in path: --with-signal-
  // ingestion or --add signal-ingestion.
  if (flags.withSignalIngestion) {
    sel.signalIngestion = true;
  } else {
    sel.signalIngestion = await adapters.prompt(
      'Scaffold RFC-0030 signal-ingestion config (default OFF; opt in via AI_SDLC_SIGNAL_INGESTION soak)?',
      false,
    );
  }

  return sel;
}

// ── Dispatcher ───────────────────────────────────────────────────────────

/** Return value of `applyFeatureSelection` — what was actually written. */
export interface ApplyResult {
  /** Files that were newly created on this run. */
  created: string[];
  /** Files that already existed and were left untouched (idempotent). */
  skipped: string[];
  /** Files that would have been created if not for `--dry-run`. */
  wouldCreate: string[];
  /** Branch-protection result, if attempted. */
  branchProtection?: BranchProtectionResult;
}

/**
 * Write the union of feature templates into the project dir. AC #4 says
 * the BASELINE workflow templates (gate workflow) are always written; the
 * per-feature template sets are written only when their toggle is on.
 *
 * Idempotent: any file that already exists at the target path is skipped
 * with a "skip" log line. This is what makes `--add <feature>` safe to
 * run on an already-initialized repo (AC #7).
 *
 * The `workflows` feature (AISDLC-261) supports `--force` to overwrite
 * existing workflow files with the current template versions. Use this
 * to upgrade a pre-261 repo to the full workflow bundle.
 */
export async function applyFeatureSelection(
  projectDir: string,
  selection: FeatureSelection,
  flags: WizardFlags,
  adapters: FeatureAdapters,
): Promise<ApplyResult> {
  const result: ApplyResult = { created: [], skipped: [], wouldCreate: [] };

  // Build the union of templates to write.
  const templateSets: FeatureTemplateSet[] = [];

  // `--add` mode: skip the baseline (we're EXTENDING an existing init).
  // Exception: `--add workflows` must write the workflows bundle even in
  // --add mode (the bundle IS the feature; it's not an extension of baseline).
  if (!flags.add) {
    templateSets.push(BASELINE_WORKFLOW_TEMPLATES);
  }
  if (selection.dor) templateSets.push(DOR_TEMPLATES);
  if (selection.attestation) templateSets.push(ATTESTATION_TEMPLATES);
  if (selection.classifier) templateSets.push(CLASSIFIER_TEMPLATES);
  if (selection.workflows) templateSets.push(WORKFLOWS_TEMPLATES);
  if (selection.signalIngestion) templateSets.push(SIGNAL_INGESTION_TEMPLATES);

  // AISDLC-261 PR #480 review fix: dedupe across template sets so e.g.
  // `ai-sdlc-gate.yml` (in BOTH BASELINE_WORKFLOW_TEMPLATES and
  // WORKFLOWS_TEMPLATES) doesn't get written twice on
  // `--with-workflows --force` (which would log "overwrite ${relPath}
  // (--force)" against the duplicate, doubling result.created entries).
  // First-set wins (BASELINE comes first, then feature bundles).
  const seenRelPaths = new Set<string>();

  for (const set of templateSets) {
    for (const [relPath, contents] of Object.entries(set.files)) {
      if (seenRelPaths.has(relPath)) continue;
      seenRelPaths.add(relPath);
      const absPath = join(projectDir, relPath);

      if (flags.dryRun) {
        const isWorkflowFileDry = relPath.startsWith('.github/workflows/');
        const wouldForce = isWorkflowFileDry && flags.force && adapters.exists(absPath);
        result.wouldCreate.push(relPath);
        adapters.log(
          wouldForce ? `  would overwrite ${relPath} (--force)` : `  would create ${relPath}`,
        );
        continue;
      }

      // For the workflows feature: `--force` overwrites existing files.
      // For all other features: existing files are always skipped (idempotent).
      const isWorkflowFile = relPath.startsWith('.github/workflows/');
      const shouldForce = isWorkflowFile && flags.force;
      const alreadyExists = adapters.exists(absPath);

      if (alreadyExists && !shouldForce) {
        result.skipped.push(relPath);
        adapters.log(`  skip ${relPath} (already exists)`);
        continue;
      }

      // mkdir -p the parent
      adapters.mkdirp(dirname(absPath));
      adapters.writeFile(absPath, contents);
      result.created.push(relPath);
      if (alreadyExists && shouldForce) {
        adapters.log(`  overwrite ${relPath} (--force)`);
      } else {
        adapters.log(`  created ${relPath}`);
      }
    }
  }

  // Husky pre-push sign hook is a separate concern from the
  // FeatureTemplateSet because it's an APPEND (not a write-from-empty)
  // — adopters often already have a .husky/pre-push from their existing
  // tooling and we don't want to clobber it. Only fired when attestation
  // is on.
  if (selection.attestation && !flags.dryRun) {
    const hookPath = join(projectDir, '.husky', 'pre-push');
    if (!adapters.exists(hookPath)) {
      // No existing hook — write a minimal one with the sign block.
      adapters.mkdirp(dirname(hookPath));
      adapters.writeFile(
        hookPath,
        `#!/usr/bin/env bash\nset -euo pipefail\n\n${HUSKY_PREPUSH_SIGN_SNIPPET}`,
      );
      result.created.push('.husky/pre-push');
      adapters.log(`  created .husky/pre-push`);
    } else {
      const status = adapters.appendOnce(
        hookPath,
        HUSKY_PREPUSH_SIGN_SNIPPET,
        '# ai-sdlc:attestation-sign-block',
      );
      if (status === 'appended') {
        adapters.log(`  updated .husky/pre-push (appended sign block)`);
      } else {
        result.skipped.push('.husky/pre-push');
        adapters.log(`  skip .husky/pre-push (sign block already present)`);
      }
    }
  } else if (selection.attestation && flags.dryRun) {
    result.wouldCreate.push('.husky/pre-push');
    adapters.log('  would update .husky/pre-push (sign block)');
  }

  // Branch protection (always last — depends on the gate workflow being
  // present so the required check exists when the rule is applied).
  if (selection.branchProtection) {
    result.branchProtection = await applyBranchProtection(projectDir, flags, adapters);
  }

  return result;
}

// ── Branch protection ────────────────────────────────────────────────────

export interface BranchProtectionResult {
  /** Whether the rule was actually applied. False in dry-run. */
  applied: boolean;
  /** The PUT body as a JSON string (always populated for visibility). */
  bodyJson: string;
  /** Error message from `gh api`, if non-zero exit. */
  error?: string;
}

/**
 * Recommended branch-protection ruleset for AI-SDLC adopters. AC #1 #4:
 * the required checks are `ai-sdlc/pr-ready` (the gate aggregator) and
 * `codecov/patch` (the de facto coverage signal). Other AI-SDLC apps
 * post their own statuses but they're all rolled into pr-ready.
 *
 * The body conforms to the GitHub REST API
 * `PUT /repos/{owner}/{repo}/branches/{branch}/protection` schema.
 */
export const RECOMMENDED_BRANCH_PROTECTION_BODY = {
  required_status_checks: {
    strict: true,
    contexts: ['ai-sdlc/pr-ready', 'codecov/patch'],
  },
  enforce_admins: false,
  required_pull_request_reviews: {
    dismiss_stale_reviews: true,
    require_code_owner_reviews: false,
    required_approving_review_count: 1,
  },
  restrictions: null,
  allow_force_pushes: false,
  allow_deletions: false,
};

/**
 * Apply (or print, in dry-run) the recommended branch protection rule
 * to the `main` branch of the repo at `projectDir`. AC #6 explicitly
 * requires that `--dry-run` print the JSON without applying.
 *
 * The repo identity (`owner/repo`) is resolved by shelling out to
 * `gh repo view --json nameWithOwner -q .nameWithOwner`. We could parse
 * the git remote ourselves (see git-remote.ts) but `gh` already resolves
 * forks + renames + custom default branches consistently, and the user
 * needs `gh` on PATH for the PUT to work anyway.
 */
export async function applyBranchProtection(
  projectDir: string,
  flags: WizardFlags,
  adapters: Pick<FeatureAdapters, 'runCommand' | 'log'>,
): Promise<BranchProtectionResult> {
  const bodyJson = JSON.stringify(RECOMMENDED_BRANCH_PROTECTION_BODY, null, 2);

  if (flags.dryRun) {
    adapters.log('');
    adapters.log('Branch-protection dry-run — would PUT the following body:');
    adapters.log(bodyJson);
    adapters.log('');
    adapters.log('  endpoint: PUT /repos/{owner}/{repo}/branches/main/protection');
    adapters.log('  apply with: gh api -X PUT repos/{owner}/{repo}/branches/main/protection ...');
    return { applied: false, bodyJson };
  }

  // Resolve owner/repo via gh.
  const ownerRepo = adapters.runCommand('gh', [
    'repo',
    'view',
    '--json',
    'nameWithOwner',
    '-q',
    '.nameWithOwner',
  ]);
  if (ownerRepo.exitCode !== 0) {
    return {
      applied: false,
      bodyJson,
      error: `gh repo view failed: ${ownerRepo.stdout.trim() || 'unknown error'}`,
    };
  }
  const slug = ownerRepo.stdout.trim();
  if (!slug) {
    return {
      applied: false,
      bodyJson,
      error: 'gh repo view returned empty owner/repo',
    };
  }

  // Use the file-based input form so we don't have to thread quoted JSON
  // through a shell. We write to a tmpfile, point gh at it, and let the
  // adapter's runCommand spawn `gh` directly.
  const tmpPath = join(projectDir, '.ai-sdlc', 'branch-protection-body.json');
  // adapters.runCommand can't write files, so we use the underlying
  // primitives directly here — branch protection is a one-shot operation
  // and doesn't need to be hermetic in the same way as the file writes.
  // Tests inject a stub that intercepts the runCommand call and never
  // touches this path. See test for the contract.
  try {
    mkdirSync(dirname(tmpPath), { recursive: true });
    writeFileSync(tmpPath, bodyJson, 'utf-8');
  } catch (err) {
    return {
      applied: false,
      bodyJson,
      error: `failed to stage branch-protection body: ${(err as Error).message}`,
    };
  }

  const apply = adapters.runCommand('gh', [
    'api',
    '-X',
    'PUT',
    `repos/${slug}/branches/main/protection`,
    '--input',
    tmpPath,
  ]);
  if (apply.exitCode !== 0) {
    return {
      applied: false,
      bodyJson,
      error: `gh api PUT failed: ${apply.stdout.trim() || 'unknown error'}`,
    };
  }

  adapters.log(`  applied branch protection to ${slug}:main`);
  return { applied: true, bodyJson };
}

// ── Next-steps summary ───────────────────────────────────────────────────

/**
 * Print the structured "next steps" summary at the end of init. AC #5:
 * the summary must include operator action items conditional on which
 * features were chosen (e.g. `gh secret set` commands when attestation
 * was opted in).
 *
 * Returns the rendered summary as a string in addition to logging it,
 * so tests can assert on it without re-stringifying console output.
 */
export function renderNextSteps(
  selection: FeatureSelection,
  result: ApplyResult,
  adapters: Pick<FeatureAdapters, 'log'>,
): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━ Next steps ━━━');
  lines.push('');

  // Always present (baseline gate)
  lines.push('1. Commit the scaffolded files:');
  lines.push('     git add .ai-sdlc .github/workflows package.json');
  lines.push('     git commit -m "chore: bootstrap AI-SDLC config"');
  lines.push('');

  let stepN = 2;

  if (selection.dor) {
    lines.push(`${stepN}. DoR (Definition-of-Ready) is in WARN-ONLY mode by default.`);
    lines.push('     Tune .ai-sdlc/dor-config.yaml then flip evaluationMode: enforce');
    lines.push('     after a soak window confirms the false-positive rate is low.');
    lines.push('');
    stepN++;
  }

  if (selection.attestation) {
    lines.push(`${stepN}. Attestation infrastructure was scaffolded in AUDIT-ONLY mode.`);
    lines.push('     a) Bootstrap your signing key: /ai-sdlc init-signing-key');
    lines.push('     b) Open a PR adding the printed YAML block to');
    lines.push('        .ai-sdlc/trusted-reviewers.yaml');
    // AISDLC-152: removed the optional CI-side signer step (the AISDLC-87
    // CI-attestor was retired in AISDLC-140 sub-4 alongside attestation
    // becoming audit-only). New adopters no longer need to provision the
    // AI_SDLC_CI_ATTESTOR_PRIVATE_KEY secret.
    lines.push('');
    stepN++;
  }

  if (selection.classifier) {
    lines.push(`${stepN}. Review classifier config was scaffolded.`);
    lines.push('     The classifier RUNTIME ships in AISDLC-141 (follow-up). Until');
    lines.push('     that lands, .ai-sdlc/review-classifier.yaml is advisory only.');
    lines.push('');
    stepN++;
  }

  if (selection.workflows) {
    lines.push(`${stepN}. GitHub Actions workflows were scaffolded into .github/workflows/.`);
    lines.push('     Four files are now in place:');
    lines.push('       - ai-sdlc-gate.yml       — ai-sdlc/pr-ready rollup check');
    lines.push('       - verify-attestation.yml  — DSSE attestation verifier (audit-only)');
    lines.push('       - ai-sdlc-review.yml      — PR review status (stub: wire your reviewers)');
    lines.push('       - auto-enable-auto-merge.yml — arms auto-merge on same-repo PRs');
    lines.push('     To activate auto-merge:');
    lines.push('       a) Enable "Allow auto-merge" in GitHub Settings → General.');
    lines.push('       b) Set the AI_SDLC_PAT secret with write access to the repo.');
    lines.push('     Re-run with --force to overwrite workflows on a pre-261 repo:');
    lines.push('       ai-sdlc init --add workflows --force');
    lines.push('');
    stepN++;
  }

  if (selection.signalIngestion) {
    lines.push(`${stepN}. RFC-0030 signal-ingestion config was scaffolded (DISABLED by default).`);
    lines.push('     .ai-sdlc/signal-ingestion.yaml ships every block commented-out under');
    lines.push('     enabled: false. The pipeline is gated by BOTH the YAML toggle AND the');
    lines.push('     AI_SDLC_SIGNAL_INGESTION env flag during the soak window.');
    lines.push('     To opt in:');
    lines.push('       a) Read docs/operations/signal-ingestion.md (adapter setup +');
    lines.push('          tier-multiplier + SA-threshold tuning + manual entry workflow).');
    lines.push('       b) Set AI_SDLC_SIGNAL_INGESTION=1 in your shell / CI env.');
    lines.push('       c) Edit .ai-sdlc/signal-ingestion.yaml, set spec.enabled: true,');
    lines.push('          uncomment the adapters block, and confirm tier multipliers.');
    lines.push('     Config edits emit SignalIngestionConfigChanged governance events to');
    lines.push('     <ARTIFACTS_DIR>/_orchestrator/events-YYYY-MM-DD.jsonl.');
    lines.push('     Promotion runbook: docs/operations/signal-ingestion-promotion.md');
    lines.push('');
    stepN++;
  }

  if (selection.branchProtection) {
    if (result.branchProtection?.applied) {
      lines.push(`${stepN}. Branch protection on \`main\` was updated.`);
      lines.push('     Required checks: ai-sdlc/pr-ready, codecov/patch');
    } else if (result.branchProtection?.error) {
      lines.push(`${stepN}. Branch protection was NOT applied:`);
      lines.push(`     ${result.branchProtection.error}`);
      lines.push('     After resolving (gh auth login, repo permissions, etc.) re-run:');
      lines.push('     ai-sdlc init --add branch-protection');
    } else {
      lines.push(`${stepN}. Branch protection (dry-run) — see JSON above; apply with:`);
      lines.push('     ai-sdlc init --add branch-protection');
    }
    lines.push('');
    stepN++;
  }

  lines.push(`${stepN}. Verify your configuration: ai-sdlc health`);
  lines.push('');
  lines.push(
    'Adopter docs: https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/docs/operations/init.md',
  );

  const out = lines.join('\n');
  for (const line of lines) adapters.log(line);
  return out;
}

// ── CLAUDE.md recommendation pointer (AC #4) ─────────────────────────────

/**
 * The pointer block we append to CLAUDE.md so a freshly-initialized repo's
 * Claude Code sessions know where to find the AI-SDLC quality-gate docs.
 * Idempotent — guarded by a sentinel so re-running init doesn't duplicate
 * the block.
 */
export const CLAUDE_MD_POINTER = `
<!-- ai-sdlc:recommendation-pointer -->
## AI-SDLC quality gate

This repo is bootstrapped with the AI-SDLC framework. The single PR-ready
merge gate is \`ai-sdlc/pr-ready\` (see \`.github/workflows/ai-sdlc-gate.yml\`).
Run \`ai-sdlc health\` to verify your local config; see
\`docs/operations/init.md\` for the adopter guide.
<!-- end ai-sdlc:recommendation-pointer -->
`;

/** Sentinel marker used by the CLAUDE.md pointer for idempotency. */
export const CLAUDE_MD_SENTINEL = '<!-- ai-sdlc:recommendation-pointer -->';

/**
 * Append the recommendation pointer to CLAUDE.md (or create the file if
 * missing). Idempotent: if the sentinel is already present we no-op.
 */
export function ensureClaudeMdPointer(
  projectDir: string,
  adapters: Pick<FeatureAdapters, 'exists' | 'writeFile' | 'appendOnce' | 'log'>,
  dryRun: boolean,
): void {
  const path = join(projectDir, 'CLAUDE.md');

  if (dryRun) {
    adapters.log('  would update CLAUDE.md (recommendation pointer)');
    return;
  }

  if (!adapters.exists(path)) {
    adapters.writeFile(path, `# Project instructions\n${CLAUDE_MD_POINTER}`);
    adapters.log('  created CLAUDE.md');
    return;
  }

  const status = adapters.appendOnce(path, CLAUDE_MD_POINTER, CLAUDE_MD_SENTINEL);
  if (status === 'appended') {
    adapters.log('  updated CLAUDE.md (recommendation pointer)');
  } else {
    adapters.log('  skip CLAUDE.md (recommendation pointer already present)');
  }
}
