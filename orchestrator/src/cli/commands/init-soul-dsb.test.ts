/**
 * RFC-0009 Phase 2.2 — per-soul DSB scaffolding tests (AC #1).
 *
 * Covers acceptance criteria:
 *   AC #1: `init` scaffolds `.ai-sdlc/souls/<slug>/design-system-binding.yaml`
 *          template per soul
 *   AC #5: backwards-compat — single-DSB layout (no souls) is unaffected
 *   AC #6: test coverage for DSB template content and init scaffolding edge cases
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { validate } from '@ai-sdlc/reference';
import { scaffoldSoulDsbs } from './init.js';
import { buildSoulDsbTemplate } from './init-templates.js';

// ── Test utilities ─────────────────────────────────────────────────────

let tmpDir: string;
let aiSdlcDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aisdlc-soul-dsb-test-'));
  aiSdlcDir = join(tmpDir, '.ai-sdlc');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── buildSoulDsbTemplate — template content tests ─────────────────────

describe('buildSoulDsbTemplate', () => {
  it('generates a YAML document that parses cleanly', () => {
    const template = buildSoulDsbTemplate('soul-a');
    const doc = parseYaml(template);
    expect(doc).toBeDefined();
    expect(doc.kind).toBe('DesignSystemBinding');
    expect(doc.apiVersion).toBe('ai-sdlc.io/v1alpha1');
  });

  it('sets metadata.name to <slug>-dsb', () => {
    const doc = parseYaml(buildSoulDsbTemplate('soul-b'));
    expect(doc.metadata.name).toBe('soul-b-dsb');
  });

  it('sets the soul slug label', () => {
    const doc = parseYaml(buildSoulDsbTemplate('soul-a'));
    expect(doc.metadata.labels?.['ai-sdlc/soul']).toBe('soul-a');
  });

  it('sets spec.extends to the platform DSB name', () => {
    const doc = parseYaml(buildSoulDsbTemplate('soul-a', 'acme-platform-dsb'));
    expect(doc.spec.extends).toBe('acme-platform-dsb');
  });

  it('defaults spec.extends to platform-dsb when no name provided', () => {
    const doc = parseYaml(buildSoulDsbTemplate('soul-x'));
    expect(doc.spec.extends).toBe('platform-dsb');
  });

  it('uses the soul slug in the token branch path', () => {
    const doc = parseYaml(buildSoulDsbTemplate('payments'));
    expect(doc.spec.tokens.source.branch).toBe('soul/payments');
    expect(doc.spec.tokens.source.path).toContain('payments');
  });

  it('uses the soul slug in the catalog storybookUrl', () => {
    const doc = parseYaml(buildSoulDsbTemplate('checkout'));
    expect(doc.spec.catalog.source?.storybookUrl).toContain('checkout');
  });

  it('validates against the DesignSystemBinding schema', () => {
    const doc = parseYaml(buildSoulDsbTemplate('soul-a'));
    const result = validate('DesignSystemBinding', doc);
    if (!result.valid) {
      throw new Error(
        `soul DSB template failed schema validation:\n` +
          (result.errors ?? []).map((e) => `  ${e.path}: ${e.message}`).join('\n'),
      );
    }
    expect(result.valid).toBe(true);
  });

  it('each slug produces a unique template (no cross-slug contamination)', () => {
    const docA = parseYaml(buildSoulDsbTemplate('soul-a'));
    const docB = parseYaml(buildSoulDsbTemplate('soul-b'));

    expect(docA.metadata.name).not.toBe(docB.metadata.name);
    expect(docA.spec.catalog.source?.storybookUrl).not.toBe(docB.spec.catalog.source?.storybookUrl);
  });
});

// ── scaffoldSoulDsbs — file scaffolding tests (AC #1) ─────────────────

describe('scaffoldSoulDsbs', () => {
  it('AC #1: creates .ai-sdlc/souls/<slug>/design-system-binding.yaml per soul', () => {
    scaffoldSoulDsbs(['soul-a', 'soul-b'], aiSdlcDir);

    expect(existsSync(join(aiSdlcDir, 'souls', 'soul-a', 'design-system-binding.yaml'))).toBe(true);
    expect(existsSync(join(aiSdlcDir, 'souls', 'soul-b', 'design-system-binding.yaml'))).toBe(true);
  });

  it('AC #1: each created file contains valid YAML', () => {
    scaffoldSoulDsbs(['soul-a'], aiSdlcDir);

    const content = readFileSync(
      join(aiSdlcDir, 'souls', 'soul-a', 'design-system-binding.yaml'),
      'utf-8',
    );
    const doc = parseYaml(content);
    expect(doc).toBeDefined();
    expect(doc.kind).toBe('DesignSystemBinding');
  });

  it('AC #1: created file has the correct soul slug embedded', () => {
    scaffoldSoulDsbs(['payments-soul'], aiSdlcDir);

    const content = readFileSync(
      join(aiSdlcDir, 'souls', 'payments-soul', 'design-system-binding.yaml'),
      'utf-8',
    );
    const doc = parseYaml(content);
    expect(doc.metadata.name).toBe('payments-soul-dsb');
    expect(doc.metadata.labels?.['ai-sdlc/soul']).toBe('payments-soul');
  });

  it('AC #1: created file spec.extends references the platform DSB name', () => {
    scaffoldSoulDsbs(['soul-a'], aiSdlcDir, { platformDsbName: 'acme-platform-dsb' });

    const content = readFileSync(
      join(aiSdlcDir, 'souls', 'soul-a', 'design-system-binding.yaml'),
      'utf-8',
    );
    const doc = parseYaml(content);
    expect(doc.spec.extends).toBe('acme-platform-dsb');
  });

  it('AC #5: does nothing when soulSlugs is empty', () => {
    scaffoldSoulDsbs([], aiSdlcDir);

    // No souls/ directory should be created
    expect(existsSync(join(aiSdlcDir, 'souls'))).toBe(false);
  });

  it('AC #5: idempotent — existing files are skipped (not overwritten)', () => {
    // First scaffold
    scaffoldSoulDsbs(['soul-a'], aiSdlcDir);
    const filePath = join(aiSdlcDir, 'souls', 'soul-a', 'design-system-binding.yaml');
    const firstContent = readFileSync(filePath, 'utf-8');

    // Modify the file manually (simulate user edits)
    const modifiedContent = firstContent + '\n# user-added comment\n';
    writeFileSync(filePath, modifiedContent, 'utf-8');

    // Second scaffold — should skip the file
    scaffoldSoulDsbs(['soul-a'], aiSdlcDir);

    // File should still contain the user-modified content
    const afterContent = readFileSync(filePath, 'utf-8');
    expect(afterContent).toBe(modifiedContent);
  });

  it('dry-run does not write any files', () => {
    scaffoldSoulDsbs(['soul-a', 'soul-b'], aiSdlcDir, { dryRun: true });

    expect(existsSync(join(aiSdlcDir, 'souls'))).toBe(false);
  });

  it('creates the souls/<slug> directory when it does not exist', () => {
    scaffoldSoulDsbs(['soul-new'], aiSdlcDir);

    expect(existsSync(join(aiSdlcDir, 'souls', 'soul-new'))).toBe(true);
  });

  it('AC #6: handles multiple souls independently', () => {
    scaffoldSoulDsbs(['soul-a', 'soul-b', 'soul-c'], aiSdlcDir);

    for (const slug of ['soul-a', 'soul-b', 'soul-c']) {
      const dsbPath = join(aiSdlcDir, 'souls', slug, 'design-system-binding.yaml');
      expect(existsSync(dsbPath)).toBe(true);

      const doc = parseYaml(readFileSync(dsbPath, 'utf-8'));
      expect(doc.metadata.labels?.['ai-sdlc/soul']).toBe(slug);
    }
  });
});
