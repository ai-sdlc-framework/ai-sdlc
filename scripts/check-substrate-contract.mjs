#!/usr/bin/env node
/**
 * check-substrate-contract.mjs — RFC-0028 Phase 2 CI integrity gate.
 *
 * Runs 5 type-registry assertions against every Substrate Contract file
 * discovered in the repository. These assertions implement the CI integrity
 * gate described in RFC-0028 §4 — the fourth drift-detection mechanism
 * complementing RFC-0009 §7.2's three orchestrator-side rules.
 *
 * Assertions (in order):
 *
 * 1. Registry key matches contract `soulId` field
 *    Catches: mis-registration drift (RFC-0009 §3 Substrate Invariants violation)
 *    Method: filename without extension MUST equal `spec.soulId`
 *
 * 2. `soulId` ∈ runtime soul-membership set
 *    Catches: phantom-Soul DID registration (RFC-0009 §5.2 souls[] integrity)
 *    Method: `spec.soulId` must appear in the tessellation config `souls[]`
 *    §4.2 concrete catch: the exact failure mode surfaced in the reference platform
 *
 * 3. Eρ₅ compliance locks INVIOLABLE on declared-vulnerable Soul DIDs
 *    Catches: categorical gate bypass at authoring time (RFC-0009 §7.1 Eρ₅)
 *    Method: when `spec.compliance.vulnerableAudience === true`, the contract
 *    MUST declare `requiresVulnerableAudienceLockout` in `spec.compliance.locks`
 *    with value `true`
 *
 * 4. Director agent ∈ council membership
 *    Catches: cross-soul authority leak (RFC-0009 §12 Cross-Soul Isolation)
 *    Method: `spec.council.director` must be in `spec.council.agentIds[]`
 *
 * 5. Substrate marker keys ∈ shared SSOT marker registry
 *    Catches: substrate contamination (RFC-0009 §3 No-Soul-Conditionals-in-Substrate)
 *    Method: every key in `spec.markerKeys[]` must appear in the marker registry
 *
 * Cold-start behavior (AC-8): gate is a no-op when no substrate contracts exist.
 * Deterministic: no LLM, no network I/O. All 5 assertions run in <5s.
 *
 * Decision routing: assertion failure emits `Decision: substrate-structural-drift-detected`
 * via `cli-decisions.mjs add` (RFC-0035 default-on Decision Catalog). If
 * `pipeline-cli/bin/cli-decisions.mjs` is absent (fresh clone), emission is skipped
 * gracefully — the exit-code gate still fires.
 *
 * Usage:
 *   node scripts/check-substrate-contract.mjs
 *   node scripts/check-substrate-contract.mjs --contracts-dir <path>
 *   node scripts/check-substrate-contract.mjs --tessellation <path>
 *   node scripts/check-substrate-contract.mjs --marker-registry <path>
 *   node scripts/check-substrate-contract.mjs --repo-root <path>
 *
 * Environment variables:
 *   AI_SDLC_BYPASS_ALL_GATES=1    — bypass this gate (and all others)
 *   AI_SDLC_SKIP_SUBSTRATE_GATE=1 — skip just this gate
 *   AI_SDLC_SKIP_DECISION_EMIT=1  — skip Decision Catalog emission on failure
 *
 * Exit codes:
 *   0 — all assertions passed, OR no substrate contracts discovered (cold-start)
 *   1 — one or more assertions failed
 *
 * Contract file format (substrate-contracts/<soulId>.json):
 * {
 *   "apiVersion": "ai-sdlc/v1alpha1",
 *   "kind": "SubstrateContract",
 *   "metadata": { "name": "<soulId>" },
 *   "spec": {
 *     "soulId": "<soulId>",
 *     // Optional sub-contracts for CI assertions:
 *     "council": {
 *       "director": "<agentId>",         // Assertion 4
 *       "agentIds": ["<agentId>", ...]   // Assertion 4
 *     },
 *     "compliance": {
 *       "vulnerableAudience": true,      // Assertion 3 trigger
 *       "locks": {
 *         "requiresVulnerableAudienceLockout": true  // Assertion 3 required lock
 *       }
 *     },
 *     "markerKeys": ["<markerKey>", ...],  // Assertion 5
 *     "fields": [...]                       // Phase 1 field metadata (RFC-0028 §3.2)
 *   }
 * }
 *
 * Tessellation config (substrate-contracts/tessellation.json):
 * { "souls": ["<soulId>", ...] }
 *
 * Marker registry (substrate-contracts/marker-registry.json):
 * { "markers": ["<markerKey>", ...] }
 *
 * @see spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md §4
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(__dirname, '..');
const DEFAULT_CONTRACTS_SUBDIR = 'substrate-contracts';
const TESSELLATION_FILENAME = 'tessellation.json';
const MARKER_REGISTRY_FILENAME = 'marker-registry.json';
const EXPECTED_KIND = 'SubstrateContract';

// ── Types (JSDoc shapes for IDE / documentation) ─────────────────────────────

/**
 * @typedef {{ soulId: string; council?: CouncilSpec; compliance?: ComplianceSpec; markerKeys?: string[]; fields?: SubstrateField[] }} ContractSpec
 * @typedef {{ director?: string; agentIds?: string[] }} CouncilSpec
 * @typedef {{ vulnerableAudience?: boolean; locks?: Record<string, boolean | undefined> }} ComplianceSpec
 * @typedef {{ name: string; namedConsumer: string; defaultFallback: string; identityClass?: string; complianceLockKind?: string }} SubstrateField
 * @typedef {{ apiVersion?: string; kind: string; metadata?: { name?: string }; spec: ContractSpec }} SubstrateContract
 * @typedef {{ souls: string[] }} TessellationConfig
 * @typedef {{ markers: string[] }} MarkerRegistry
 */

/**
 * @typedef {{
 *   passed: boolean;
 *   assertionId: 1|2|3|4|5;
 *   soulId: string;
 *   field?: string;
 *   message: string;
 *   decisionSummary?: string;
 * }} AssertionResult
 */

/**
 * @typedef {{
 *   contractsFound: number;
 *   failures: AssertionResult[];
 *   passed: boolean;
 *   coldStart: boolean;
 * }} CheckResult
 */

// ── Contract discovery ────────────────────────────────────────────────────────

/**
 * Discover substrate contract files in the given directory.
 *
 * Each contract file must be `<soulId>.json` — NOT `tessellation.json` or
 * `marker-registry.json` (those are supporting files, not contracts).
 *
 * @param {string} contractsDir Absolute path to the `substrate-contracts/` dir
 * @returns {Array<{file: string; registryKey: string}>} Discovered contract files
 */
export function discoverContractFiles(contractsDir) {
  if (!existsSync(contractsDir)) return [];
  const entries = readdirSync(contractsDir).filter(
    (f) => f.endsWith('.json') && f !== TESSELLATION_FILENAME && f !== MARKER_REGISTRY_FILENAME,
  );
  return entries.map((f) => ({
    file: join(contractsDir, f),
    registryKey: basename(f, '.json'),
  }));
}

/**
 * Load and validate a substrate contract file.
 *
 * @param {string} filePath Absolute path to the contract JSON file
 * @returns {{ contract: SubstrateContract | null; error: string | null }}
 */
export function loadContract(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    return { contract: null, error: `Cannot read file: ${String(err)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { contract: null, error: `JSON parse error: ${String(err)}` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { contract: null, error: 'Contract must be a JSON object' };
  }
  if (parsed.kind !== EXPECTED_KIND) {
    return {
      contract: null,
      error: `Expected kind: "${EXPECTED_KIND}", got: "${String(parsed.kind)}"`,
    };
  }
  if (!parsed.spec || typeof parsed.spec !== 'object') {
    return { contract: null, error: 'Missing or invalid "spec" field' };
  }
  if (typeof parsed.spec.soulId !== 'string' || parsed.spec.soulId.trim() === '') {
    return { contract: null, error: 'spec.soulId must be a non-empty string' };
  }
  return { contract: /** @type {SubstrateContract} */ (parsed), error: null };
}

/**
 * Load the tessellation config from disk.
 *
 * Supports two formats:
 *   - `{ "souls": [...] }` (flat)
 *   - `{ "spec": { "souls": [...] } }` (structured, matches ai-sdlc resource pattern)
 *
 * @param {string} tessellationPath Absolute path to tessellation.json
 * @returns {{ config: TessellationConfig | null; error: string | null }}
 */
export function loadTessellationConfig(tessellationPath) {
  if (!existsSync(tessellationPath)) {
    return { config: null, error: null }; // graceful: missing → no assertion-2 run
  }
  let raw;
  try {
    raw = readFileSync(tessellationPath, 'utf8');
  } catch (err) {
    return { config: null, error: `Cannot read tessellation config: ${String(err)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { config: null, error: `Tessellation config JSON parse error: ${String(err)}` };
  }
  // Support both `{ souls: [...] }` and `{ spec: { souls: [...] } }`
  const souls =
    (Array.isArray(parsed?.spec?.souls) ? parsed.spec.souls : null) ??
    (Array.isArray(parsed?.souls) ? parsed.souls : null);
  if (!souls) {
    return {
      config: null,
      error: 'Tessellation config must have "souls" array at root or under "spec"',
    };
  }
  return { config: { souls: /** @type {string[]} */ (souls) }, error: null };
}

/**
 * Load the marker registry from disk.
 *
 * @param {string} registryPath Absolute path to marker-registry.json
 * @returns {{ registry: MarkerRegistry | null; error: string | null }}
 */
export function loadMarkerRegistry(registryPath) {
  if (!existsSync(registryPath)) {
    return { registry: null, error: null }; // graceful: missing → no assertion-5 run
  }
  let raw;
  try {
    raw = readFileSync(registryPath, 'utf8');
  } catch (err) {
    return { registry: null, error: `Cannot read marker registry: ${String(err)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { registry: null, error: `Marker registry JSON parse error: ${String(err)}` };
  }
  // Support both `{ markers: [...] }` and `{ spec: { markers: [...] } }`
  const markers =
    (Array.isArray(parsed?.spec?.markers) ? parsed.spec.markers : null) ??
    (Array.isArray(parsed?.markers) ? parsed.markers : null);
  if (!markers) {
    return {
      registry: null,
      error: 'Marker registry must have "markers" array at root or under "spec"',
    };
  }
  return { registry: { markers: /** @type {string[]} */ (markers) }, error: null };
}

// ── Assertion implementations ─────────────────────────────────────────────────

/**
 * Assertion 1: Registry key matches contract `soulId` field.
 *
 * Catches mis-registration drift: a contract file whose filename does not match
 * the `soulId` declared inside it. The filename is the "registry key" — when
 * contracts are loaded from a directory named `<soulId>.json`, the two MUST agree.
 *
 * @param {SubstrateContract} contract
 * @param {string} registryKey Filename without the `.json` extension
 * @returns {AssertionResult}
 */
export function runAssertion1(contract, registryKey) {
  const soulId = contract.spec.soulId;
  const passed = soulId === registryKey;
  if (passed) {
    return { passed: true, assertionId: 1, soulId, message: 'Registry key matches soulId' };
  }
  const message = `Assertion 1 FAIL (mis-registration drift): registry key "${registryKey}" ≠ spec.soulId "${soulId}"`;
  return {
    passed: false,
    assertionId: 1,
    soulId,
    field: 'spec.soulId',
    message,
    decisionSummary: `Substrate-structural-drift-detected: Soul "${soulId}" — Assertion 1 (mis-registration drift): registry key "${registryKey}" does not match spec.soulId "${soulId}". Rename the contract file to "${soulId}.json" or update spec.soulId.`,
  };
}

/**
 * Assertion 2: `soulId` ∈ runtime soul-membership set.
 *
 * Catches phantom-Soul DID registration — the §4.2 concrete catch from the
 * reference platform. A Soul DID registered with a contract but absent from
 * the tessellation souls[] causes `assertAgentInSoul()`-equivalent checks to
 * return undefined-as-passing for every agent declared to belong to it.
 *
 * When no tessellation config is present, this assertion is skipped (returns
 * passed=true) — adopters that have not declared a tessellation config cannot
 * be blocked by a config they have not created.
 *
 * @param {SubstrateContract} contract
 * @param {TessellationConfig | null} tessellationConfig
 * @returns {AssertionResult}
 */
export function runAssertion2(contract, tessellationConfig) {
  const soulId = contract.spec.soulId;
  if (!tessellationConfig) {
    return {
      passed: true,
      assertionId: 2,
      soulId,
      message: 'No tessellation config — Assertion 2 skipped',
    };
  }
  const souls = tessellationConfig.souls;
  const passed = souls.includes(soulId);
  if (passed) {
    return {
      passed: true,
      assertionId: 2,
      soulId,
      message: `soulId "${soulId}" found in soul-membership set`,
    };
  }
  const message = `Assertion 2 FAIL (phantom-Soul DID registration — §4.2 concrete catch): soulId "${soulId}" is NOT in tessellation souls[${souls.join(', ')}]`;
  return {
    passed: false,
    assertionId: 2,
    soulId,
    field: 'spec.soulId',
    message,
    decisionSummary: `Substrate-structural-drift-detected: Soul "${soulId}" — Assertion 2 (phantom-Soul DID, RFC-0028 §4.2): soulId "${soulId}" missing from runtime soul-membership set [${souls.join(', ')}]. Add "${soulId}" to tessellation.json souls[] or remove the contract file.`,
  };
}

/**
 * Assertion 3: Eρ₅ compliance locks INVIOLABLE on declared-vulnerable Soul DIDs.
 *
 * Catches categorical gate bypass at authoring time (RFC-0009 §7.1 Eρ₅).
 * When a Soul DID declares `spec.compliance.vulnerableAudience === true`,
 * the contract MUST include `spec.compliance.locks.requiresVulnerableAudienceLockout === true`.
 *
 * When `spec.compliance` is absent, the assertion is skipped (passed) — the
 * compliance sub-contract is optional per RFC-0028 §3.1.
 *
 * @param {SubstrateContract} contract
 * @returns {AssertionResult}
 */
export function runAssertion3(contract) {
  const soulId = contract.spec.soulId;
  const compliance = contract.spec.compliance;
  if (!compliance || compliance.vulnerableAudience !== true) {
    return {
      passed: true,
      assertionId: 3,
      soulId,
      message: 'Soul not declared vulnerable — Assertion 3 skipped or not applicable',
    };
  }
  // Vulnerable soul MUST have the lock
  const locks = compliance.locks;
  const lockValue =
    locks && Object.prototype.hasOwnProperty.call(locks, 'requiresVulnerableAudienceLockout')
      ? locks['requiresVulnerableAudienceLockout']
      : undefined;
  const passed = lockValue === true;
  if (passed) {
    return {
      passed: true,
      assertionId: 3,
      soulId,
      message: 'Eρ₅ compliance lock requiresVulnerableAudienceLockout=true is set',
    };
  }
  const message =
    lockValue === undefined
      ? `Assertion 3 FAIL (compliance lock missing): Soul "${soulId}" declares vulnerableAudience=true but spec.compliance.locks.requiresVulnerableAudienceLockout is absent`
      : `Assertion 3 FAIL (compliance lock disabled): Soul "${soulId}" declares vulnerableAudience=true but spec.compliance.locks.requiresVulnerableAudienceLockout=${String(lockValue)} (must be true)`;
  return {
    passed: false,
    assertionId: 3,
    soulId,
    field: 'spec.compliance.locks.requiresVulnerableAudienceLockout',
    message,
    decisionSummary: `Substrate-structural-drift-detected: Soul "${soulId}" — Assertion 3 (Eρ₅ compliance lock, RFC-0028 §5): vulnerableAudience=true but requiresVulnerableAudienceLockout lock is ${lockValue === undefined ? 'missing' : String(lockValue)}. Set spec.compliance.locks.requiresVulnerableAudienceLockout to true.`,
  };
}

/**
 * Assertion 4: Director agent ∈ council membership.
 *
 * Catches cross-soul authority leak (RFC-0009 §12 Cross-Soul Isolation).
 * If a Soul DID's contract declares a `council.director`, that agent MUST
 * be listed in `council.agentIds[]`. A director not in the council is an
 * authority-leak that bypasses soul-isolation checks.
 *
 * When `spec.council` is absent, the assertion is skipped (passed).
 *
 * @param {SubstrateContract} contract
 * @returns {AssertionResult}
 */
export function runAssertion4(contract) {
  const soulId = contract.spec.soulId;
  const council = contract.spec.council;
  if (!council || council.director === undefined) {
    return {
      passed: true,
      assertionId: 4,
      soulId,
      message: 'No council sub-contract or no director — Assertion 4 skipped',
    };
  }
  const { director, agentIds } = council;
  if (!Array.isArray(agentIds)) {
    return {
      passed: false,
      assertionId: 4,
      soulId,
      field: 'spec.council.agentIds',
      message: `Assertion 4 FAIL (council misconfiguration): Soul "${soulId}" has council.director but council.agentIds is not an array`,
      decisionSummary: `Substrate-structural-drift-detected: Soul "${soulId}" — Assertion 4 (cross-soul authority leak, RFC-0028 §4): council.director "${String(director)}" declared but council.agentIds is missing or not an array. Add an agentIds array containing the director.`,
    };
  }
  const passed = agentIds.includes(director);
  if (passed) {
    return {
      passed: true,
      assertionId: 4,
      soulId,
      message: `Director "${director}" is in council membership`,
    };
  }
  const message = `Assertion 4 FAIL (cross-soul authority leak): Soul "${soulId}" director "${director}" is NOT in council agentIds [${agentIds.join(', ')}]`;
  return {
    passed: false,
    assertionId: 4,
    soulId,
    field: 'spec.council.director',
    message,
    decisionSummary: `Substrate-structural-drift-detected: Soul "${soulId}" — Assertion 4 (cross-soul authority leak, RFC-0028 §4): director "${director}" not in council agentIds [${agentIds.join(', ')}]. Add the director to spec.council.agentIds or correct the director value.`,
  };
}

/**
 * Assertion 5: Substrate marker keys ∈ shared SSOT marker registry.
 *
 * Catches substrate contamination (RFC-0009 §3 No-Soul-Conditionals-in-Substrate).
 * When a Soul DID's contract declares `spec.markerKeys[]`, every key MUST
 * exist in the shared SSOT marker registry. Unknown marker keys indicate
 * substrate contamination — soul-specific markers that haven't been registered.
 *
 * When `spec.markerKeys` is absent, OR when the marker registry file is absent,
 * the assertion is skipped (passed).
 *
 * @param {SubstrateContract} contract
 * @param {MarkerRegistry | null} markerRegistry
 * @returns {AssertionResult}
 */
export function runAssertion5(contract, markerRegistry) {
  const soulId = contract.spec.soulId;
  const markerKeys = contract.spec.markerKeys;
  if (!markerKeys || markerKeys.length === 0) {
    return {
      passed: true,
      assertionId: 5,
      soulId,
      message: 'No markerKeys declared — Assertion 5 skipped',
    };
  }
  if (!markerRegistry) {
    return {
      passed: true,
      assertionId: 5,
      soulId,
      message: 'No marker registry present — Assertion 5 skipped',
    };
  }
  const registeredSet = new Set(markerRegistry.markers);
  const unknown = markerKeys.filter((k) => !registeredSet.has(k));
  const passed = unknown.length === 0;
  if (passed) {
    return {
      passed: true,
      assertionId: 5,
      soulId,
      message: `All ${markerKeys.length} marker key(s) found in SSOT registry`,
    };
  }
  const message = `Assertion 5 FAIL (substrate contamination): Soul "${soulId}" declares unknown marker key(s): [${unknown.join(', ')}] — not in SSOT registry [${markerRegistry.markers.join(', ')}]`;
  return {
    passed: false,
    assertionId: 5,
    soulId,
    field: 'spec.markerKeys',
    message,
    decisionSummary: `Substrate-structural-drift-detected: Soul "${soulId}" — Assertion 5 (substrate contamination, RFC-0028 §4): unknown marker key(s) [${unknown.join(', ')}] not registered in SSOT marker registry. Register these keys in marker-registry.json or remove them from spec.markerKeys.`,
  };
}

// ── Orchestration ─────────────────────────────────────────────────────────────

/**
 * Run all 5 assertions on a single contract.
 *
 * @param {SubstrateContract} contract
 * @param {string} registryKey Filename without extension (for Assertion 1)
 * @param {TessellationConfig | null} tessellationConfig
 * @param {MarkerRegistry | null} markerRegistry
 * @returns {AssertionResult[]}
 */
export function runContractAssertions(contract, registryKey, tessellationConfig, markerRegistry) {
  return [
    runAssertion1(contract, registryKey),
    runAssertion2(contract, tessellationConfig),
    runAssertion3(contract),
    runAssertion4(contract),
    runAssertion5(contract, markerRegistry),
  ];
}

/**
 * Run the full substrate contract integrity gate.
 *
 * @param {{
 *   repoRoot?: string;
 *   contractsDir?: string;
 *   tessellationPath?: string;
 *   markerRegistryPath?: string;
 * }} options
 * @returns {CheckResult}
 */
export function runGate(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const contractsDir = options.contractsDir ?? join(repoRoot, DEFAULT_CONTRACTS_SUBDIR);
  const tessellationPath = options.tessellationPath ?? join(contractsDir, TESSELLATION_FILENAME);
  const markerRegistryPath =
    options.markerRegistryPath ?? join(contractsDir, MARKER_REGISTRY_FILENAME);

  // Discover contract files
  const contractEntries = discoverContractFiles(contractsDir);

  // Cold-start: no contracts → no-op
  if (contractEntries.length === 0) {
    return { contractsFound: 0, failures: [], passed: true, coldStart: true };
  }

  // Load supporting files (tessellation + marker registry)
  // Errors in supporting files are non-fatal — the individual assertions gracefully
  // skip when the files are absent, but structural errors are reported as failures.
  const tessellationResult = loadTessellationConfig(tessellationPath);
  const markerRegistryResult = loadMarkerRegistry(markerRegistryPath);

  /** @type {AssertionResult[]} */
  const allFailures = [];

  // Report config-file parse errors as failures so they block the gate
  if (tessellationResult.error) {
    allFailures.push({
      passed: false,
      assertionId: 2,
      soulId: '<tessellation-config>',
      field: 'tessellation.json',
      message: `Tessellation config error: ${tessellationResult.error}`,
      decisionSummary: `Substrate-structural-drift-detected: tessellation.json parse error — ${tessellationResult.error}`,
    });
  }
  if (markerRegistryResult.error) {
    allFailures.push({
      passed: false,
      assertionId: 5,
      soulId: '<marker-registry>',
      field: 'marker-registry.json',
      message: `Marker registry error: ${markerRegistryResult.error}`,
      decisionSummary: `Substrate-structural-drift-detected: marker-registry.json parse error — ${markerRegistryResult.error}`,
    });
  }

  // Run assertions on each contract
  for (const { file, registryKey } of contractEntries) {
    const { contract, error } = loadContract(file);
    if (error) {
      allFailures.push({
        passed: false,
        assertionId: 1,
        soulId: registryKey,
        field: file,
        message: `Contract load error in "${file}": ${error}`,
        decisionSummary: `Substrate-structural-drift-detected: contract file "${file}" could not be loaded — ${error}`,
      });
      continue;
    }
    const results = runContractAssertions(
      contract,
      registryKey,
      tessellationResult.config,
      markerRegistryResult.registry,
    );
    for (const result of results) {
      if (!result.passed) {
        allFailures.push(result);
      }
    }
  }

  return {
    contractsFound: contractEntries.length,
    failures: allFailures,
    passed: allFailures.length === 0,
    coldStart: false,
  };
}

// ── Decision emission ─────────────────────────────────────────────────────────

/**
 * Attempt to emit a Decision via `cli-decisions.mjs add`.
 *
 * No-op when the CLI binary is absent (fresh clone, docs-only worktree).
 * Errors during emission are logged to stderr but do NOT cause the gate to
 * change its exit code — the exit-code gate is the hard mechanism.
 *
 * @param {AssertionResult} failure
 * @param {string} repoRoot
 */
export function emitDecision(failure, repoRoot) {
  const cliBin = join(repoRoot, 'pipeline-cli', 'bin', 'cli-decisions.mjs');
  if (!existsSync(cliBin)) return; // graceful skip on fresh clone
  if (process.env['AI_SDLC_SKIP_DECISION_EMIT'] === '1') return;

  const summary = failure.decisionSummary ?? failure.message;
  const soulId = failure.soulId;

  try {
    execFileSync(
      process.execPath,
      [
        cliBin,
        'add',
        '--summary',
        summary,
        '--scope',
        'substrate-enforcement',
        '--option',
        'fix:Correct the contract field causing the assertion failure',
        '--option',
        'exempt:Document an RFC-approved exemption for this soul',
      ],
      { cwd: repoRoot, stdio: 'pipe', timeout: 10_000 },
    );
  } catch (err) {
    process.stderr.write(
      `[substrate-contract] Decision emission failed for soul "${soulId}" (non-fatal): ${String(err)}\n`,
    );
  }
}

// ── CLI entry point ───────────────────────────────────────────────────────────

/**
 * Parse CLI arguments from process.argv.
 * @returns {{ repoRoot: string; contractsDir: string | undefined; tessellationPath: string | undefined; markerRegistryPath: string | undefined; }}
 */
export function parseArgs(argv = process.argv.slice(2)) {
  let repoRoot = DEFAULT_REPO_ROOT;
  let contractsDir;
  let tessellationPath;
  let markerRegistryPath;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--repo-root' && next) {
      repoRoot = resolve(next);
      i++;
    } else if (arg === '--contracts-dir' && next) {
      contractsDir = resolve(next);
      i++;
    } else if (arg === '--tessellation' && next) {
      tessellationPath = resolve(next);
      i++;
    } else if (arg === '--marker-registry' && next) {
      markerRegistryPath = resolve(next);
      i++;
    }
  }
  return { repoRoot, contractsDir, tessellationPath, markerRegistryPath };
}

/**
 * Main entry point when invoked as a CLI.
 *
 * @param {string[]} [argv]
 * @returns {Promise<void>}
 */
export async function main(argv) {
  // Honour bypass env vars
  if (process.env['AI_SDLC_BYPASS_ALL_GATES'] === '1') {
    process.stderr.write('[substrate-contract] AI_SDLC_BYPASS_ALL_GATES=1 — skipping\n');
    return;
  }
  if (process.env['AI_SDLC_SKIP_SUBSTRATE_GATE'] === '1') {
    process.stderr.write('[substrate-contract] AI_SDLC_SKIP_SUBSTRATE_GATE=1 — skipping\n');
    return;
  }

  const args = parseArgs(argv);
  const result = runGate(args);

  if (result.coldStart) {
    process.stdout.write(
      '[substrate-contract] No substrate contracts found — cold-start (no-op)\n',
    );
    return;
  }

  process.stdout.write(
    `[substrate-contract] Checked ${result.contractsFound} contract(s). Failures: ${result.failures.length}\n`,
  );

  if (result.passed) {
    process.stdout.write('[substrate-contract] All assertions passed ✓\n');
    return;
  }

  // Report failures
  for (const failure of result.failures) {
    process.stderr.write(`::error::${failure.message}\n`);
    // Emit Decision for each failure
    emitDecision(failure, args.repoRoot);
  }

  process.stderr.write(
    `\n[substrate-contract] ${result.failures.length} assertion failure(s) detected.\n` +
      'Decision: substrate-structural-drift-detected (severity HIGH)\n' +
      'Correct the listed drift(s) before pushing. See RFC-0028 §4 for assertion details.\n',
  );
  process.exitCode = 1;
}

// Run when invoked directly (not imported as a module)
const isMain =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1]?.endsWith('check-substrate-contract.mjs');
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`[substrate-contract] Unexpected error: ${String(err)}\n`);
    process.exitCode = 1;
  });
}
