import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, validateDesignIntentDocumentReferences } from './config.js';
import type { DesignIntentDocument, DesignSystemBinding } from '@ai-sdlc/reference';

// Minimal DSB YAML matching the schema
const validDsbYaml = `apiVersion: ai-sdlc.io/v1alpha1
kind: DesignSystemBinding
metadata:
  name: acme-design-system
  namespace: team-frontend
spec:
  stewardship:
    designAuthority:
      principals: ["design-lead"]
      scope: ["tokenSchema"]
    engineeringAuthority:
      principals: ["engineering-lead"]
      scope: ["catalog"]
  designToolAuthority: collaborative
  tokens:
    provider: figma-tokens-studio
    format: w3c-dtcg
    source:
      repository: acme-org/tokens
    versionPolicy: minor
  catalog:
    provider: storybook-mcp
  compliance:
    coverage:
      minimum: 85
`;

function validDidYaml(name: string, dsbName: string, dsbNamespace?: string): string {
  const nsLine = dsbNamespace ? `    namespace: ${dsbNamespace}\n` : '';
  return `apiVersion: ai-sdlc.io/v1alpha1
kind: DesignIntentDocument
metadata:
  name: ${name}
spec:
  stewardship:
    productAuthority:
      owner: product-lead
      approvalRequired: [product-lead, design-lead]
      scope: [soulPurpose.mission]
    designAuthority:
      owner: design-lead
      approvalRequired: [design-lead, product-lead]
      scope: [soulPurpose.designPrinciples]
  soulPurpose:
    mission:
      value: Acme helps small businesses.
    designPrinciples:
      - id: approachable
        name: Approachable
        description: Easy to use.
        measurableSignals:
          - id: usability
            metric: task-completion
            threshold: 0.85
            operator: gte
  designSystemRef:
    name: ${dsbName}
${nsLine}`;
}

describe('loadConfig() with DesignIntentDocument', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'did-config-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it('collects multiple DID resources into designIntentDocuments array', () => {
    writeFileSync(join(dir, 'dsb.yaml'), validDsbYaml);
    writeFileSync(join(dir, 'did-1.yaml'), validDidYaml('did-one', 'acme-design-system'));
    writeFileSync(join(dir, 'did-2.yaml'), validDidYaml('did-two', 'acme-design-system'));

    const config = loadConfig(dir);

    expect(config.designIntentDocuments).toHaveLength(2);
    expect(config.designIntentDocuments!.map((d) => d.metadata.name).sort()).toEqual([
      'did-one',
      'did-two',
    ]);
  });

  it('allows two DIDs to reference the same DSB', () => {
    writeFileSync(join(dir, 'dsb.yaml'), validDsbYaml);
    writeFileSync(join(dir, 'did-1.yaml'), validDidYaml('did-a', 'acme-design-system'));
    writeFileSync(join(dir, 'did-2.yaml'), validDidYaml('did-b', 'acme-design-system'));

    expect(() => loadConfig(dir)).not.toThrow();
  });

  it('throws when DID references an unresolved DSB', () => {
    writeFileSync(join(dir, 'did-1.yaml'), validDidYaml('orphan', 'nonexistent-dsb'));

    expect(() => loadConfig(dir)).toThrow(/nonexistent-dsb/);
  });

  it('matches DSB by name when DID has no namespace', () => {
    writeFileSync(join(dir, 'dsb.yaml'), validDsbYaml);
    writeFileSync(join(dir, 'did.yaml'), validDidYaml('did-no-ns', 'acme-design-system'));

    const config = loadConfig(dir);
    expect(config.designIntentDocuments).toHaveLength(1);
  });

  it('matches DSB by name and namespace when DID specifies both', () => {
    writeFileSync(join(dir, 'dsb.yaml'), validDsbYaml);
    writeFileSync(
      join(dir, 'did.yaml'),
      validDidYaml('did-with-ns', 'acme-design-system', 'team-frontend'),
    );

    const config = loadConfig(dir);
    expect(config.designIntentDocuments).toHaveLength(1);
  });

  it('rejects DID with namespace mismatch when DSB has a different namespace', () => {
    writeFileSync(join(dir, 'dsb.yaml'), validDsbYaml);
    writeFileSync(
      join(dir, 'did.yaml'),
      validDidYaml('did-mismatch', 'acme-design-system', 'wrong-namespace'),
    );

    expect(() => loadConfig(dir)).toThrow(/wrong-namespace/);
  });
});

describe('validateDesignIntentDocumentReferences()', () => {
  const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

  function makeDsb(name: string, namespace?: string): DesignSystemBinding {
    return {
      apiVersion: API_VERSION,
      kind: 'DesignSystemBinding',
      metadata: { name, namespace },
      spec: {
        stewardship: {
          designAuthority: { principals: ['d'], scope: [] },
          engineeringAuthority: { principals: ['e'], scope: [] },
        },
        designToolAuthority: 'collaborative',
        tokens: {
          provider: 'p',
          format: 'w3c-dtcg',
          source: { repository: 'r' },
          versionPolicy: 'minor',
        },
        catalog: { provider: 'c' },
        compliance: { coverage: { minimum: 85 } },
      },
    };
  }

  function makeDid(name: string, refName: string, refNamespace?: string): DesignIntentDocument {
    return {
      apiVersion: API_VERSION,
      kind: 'DesignIntentDocument',
      metadata: { name },
      spec: {
        stewardship: {
          productAuthority: { owner: 'p', approvalRequired: ['p'], scope: ['m'] },
          designAuthority: { owner: 'd', approvalRequired: ['d'], scope: ['dp'] },
        },
        soulPurpose: {
          mission: { value: 'test' },
          designPrinciples: [
            {
              id: 'x',
              name: 'X',
              description: 'x',
              measurableSignals: [{ id: 'm', metric: 'q', threshold: 1, operator: 'gte' }],
            },
          ],
        },
        designSystemRef: { name: refName, namespace: refNamespace },
      },
    };
  }

  it('no-op when no DIDs present', () => {
    expect(() => validateDesignIntentDocumentReferences({})).not.toThrow();
    expect(() =>
      validateDesignIntentDocumentReferences({ designIntentDocuments: [] }),
    ).not.toThrow();
  });

  it('passes when DID resolves to loaded DSB', () => {
    expect(() =>
      validateDesignIntentDocumentReferences({
        designSystemBindings: [makeDsb('ds')],
        designIntentDocuments: [makeDid('did', 'ds')],
      }),
    ).not.toThrow();
  });

  it('throws when DID references nonexistent DSB', () => {
    expect(() =>
      validateDesignIntentDocumentReferences({
        designSystemBindings: [makeDsb('other')],
        designIntentDocuments: [makeDid('did', 'missing')],
      }),
    ).toThrow(/missing/);
  });

  it('matches DSB by name when DID has no namespace declared', () => {
    expect(() =>
      validateDesignIntentDocumentReferences({
        designSystemBindings: [makeDsb('ds', 'team-a')],
        designIntentDocuments: [makeDid('did', 'ds')],
      }),
    ).not.toThrow();
  });

  it('requires namespace match when both resources declare one', () => {
    expect(() =>
      validateDesignIntentDocumentReferences({
        designSystemBindings: [makeDsb('ds', 'team-a')],
        designIntentDocuments: [makeDid('did', 'ds', 'team-b')],
      }),
    ).toThrow(/team-b/);
  });

  it('collects multiple unresolved refs in a single error', () => {
    try {
      validateDesignIntentDocumentReferences({
        designSystemBindings: [],
        designIntentDocuments: [makeDid('did-a', 'missing-a'), makeDid('did-b', 'missing-b')],
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('missing-a');
      expect((err as Error).message).toContain('missing-b');
    }
  });
});
