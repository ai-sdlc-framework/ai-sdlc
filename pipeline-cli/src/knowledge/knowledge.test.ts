import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyEntry } from './classify.js';
import { loadKnowledgeConfig } from './config.js';
import { hashValue } from './entry.js';
import { DEFAULT_ONTOLOGY, parseOntology } from './ontology.js';
import { findProtectedCitations, validateKnowledge } from './store.js';

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

function project(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'knowledge-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}

type Fields = Record<string, unknown>;
function entryText(over: Fields = {}, drop: string[] = []): string {
  const value = (over.value as string) ?? 'The gateway retries 3 times';
  const f: Fields = {
    id: 'k-1',
    trunk: 'systems',
    type: 'fact',
    value,
    confidence: 0.7,
    authority: 'inferred',
    scope: 'internal',
    source: 'src/gateway.ts',
    observed: '2026-10-09',
    decay: 'durable',
    relations: [],
    contentHash: hashValue(value),
    ...over,
  };
  for (const d of drop) delete f[d];
  return `---\n${JSON.stringify(f)}\n---\nnotes\n`;
}
const at = (trunk: string, name: string) => `.ai-sdlc/knowledge/${trunk}/${name}.md`;
const errs = (r: ReturnType<typeof validateKnowledge>) => r.errors.map((e) => e.message).join('\n');

describe('validateKnowledge', () => {
  it('accepts a valid entry', () => {
    const r = validateKnowledge(project({ [at('systems', 'a')]: entryText() }));
    expect(r.errors).toEqual([]);
    expect(r.entries).toBe(1);
  });

  it('rejects a missing required field', () => {
    const r = validateKnowledge(project({ [at('systems', 'a')]: entryText({}, ['source']) }));
    expect(errs(r)).toContain("missing required field 'source'");
  });

  it.each([1.5, -0.1, 'high'])('rejects out-of-range confidence %s', (c) => {
    const r = validateKnowledge(project({ [at('systems', 'a')]: entryText({ confidence: c }) }));
    expect(errs(r)).toContain('confidence must be a number between 0 and 1');
  });

  it('rejects an unknown relation type', () => {
    const rel = [{ type: 'likes', target: 'k-2' }];
    const r = validateKnowledge(project({ [at('systems', 'a')]: entryText({ relations: rel }) }));
    expect(errs(r)).toContain("unknown relation type 'likes'");
  });

  it('rejects an unknown trunk', () => {
    const r = validateKnowledge(project({ [at('weather', 'a')]: entryText({ trunk: 'weather' }) }));
    expect(errs(r)).toContain("unknown trunk 'weather'");
  });

  it('rejects agent-written authority above inferred', () => {
    const r = validateKnowledge(
      project({
        [at('systems', 'a')]: entryText({
          writtenBy: 'agent',
          authority: 'specialist',
          reverify: 'x',
        }),
      }),
    );
    expect(errs(r)).toContain("must have authority 'inferred'");
  });

  it('rejects agent-written confidence above 0.85 and a missing reverify note', () => {
    const r = validateKnowledge(
      project({ [at('systems', 'a')]: entryText({ writtenBy: 'agent', confidence: 0.9 }) }),
    );
    expect(errs(r)).toContain('must not exceed 0.85');
    expect(errs(r)).toContain("requires a 'reverify' note");
  });

  it('accepts a compliant agent-written entry', () => {
    const r = validateKnowledge(
      project({
        [at('systems', 'a')]: entryText({
          writtenBy: 'agent',
          confidence: 0.85,
          reverify: 'rerun',
        }),
      }),
    );
    expect(r.errors).toEqual([]);
  });

  it('rejects an entry using a value the ontology does not declare', () => {
    const r = validateKnowledge(
      project({
        '.ai-sdlc/knowledge/ontology.yaml':
          'trunks: [systems]\nentryTypes: [decision]\nrelations: [supports]\nproofKinds: [path-exists]\n',
        [at('systems', 'a')]: entryText(),
      }),
    );
    expect(errs(r)).toContain("unknown entry type 'fact'");
  });

  it('flags an incomplete ontology', () => {
    const r = validateKnowledge(
      project({ '.ai-sdlc/knowledge/ontology.yaml': 'trunks: [systems]\n' }),
    );
    expect(errs(r)).toContain("ontology: 'proofKinds' must be a non-empty list");
  });

  it('rejects a protected entry in the tracked root and a trunk/path mismatch', () => {
    const r = validateKnowledge(
      project({ [at('process', 'a')]: entryText({ scope: 'protected' }) }),
    );
    expect(errs(r)).toContain('protected entry found in the tracked root');
    expect(errs(r)).toContain('trunk directory mismatch');
  });

  it('rejects a non-protected entry in the protected root; accepts protected there', () => {
    const bad = validateKnowledge(
      project({ '.ai-sdlc/knowledge-protected/systems/a.md': entryText() }),
    );
    expect(errs(bad)).toContain("must have scope 'protected'");
    const ok = validateKnowledge(
      project({ '.ai-sdlc/knowledge-protected/systems/a.md': entryText({ scope: 'protected' }) }),
    );
    expect(ok.errors).toEqual([]);
  });

  it('detects content hash mismatch and duplicate ids', () => {
    const r = validateKnowledge(
      project({
        [at('systems', 'a')]: entryText({ contentHash: 'nope' }),
        [at('systems', 'b')]: entryText(),
      }),
    );
    expect(errs(r)).toContain('contentHash does not match');
    expect(errs(r)).toContain("duplicate id 'k-1'");
  });

  it('reports files without frontmatter', () => {
    const r = validateKnowledge(project({ [at('systems', 'a')]: 'no frontmatter' }));
    expect(errs(r)).toContain('missing YAML frontmatter');
  });

  it('warns on likely mis-scoped entries using context.yaml classification', () => {
    const r = validateKnowledge(
      project({
        '.ai-sdlc/context.yaml':
          'knowledge:\n  classification:\n    dataRoomRoots: [client-data]\n    clientIdentifiers: [Acme]\n',
        [at('systems', 'a')]: entryText({ source: 'client-data/spec.pdf' }),
        [at('systems', 'b')]: entryText({ id: 'k-2', value: 'Acme pays net 60' }),
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.message).join('\n')).toContain('data-room root');
    expect(r.warnings.map((w) => w.message).join('\n')).toContain("client identifier 'Acme'");
  });
});

describe('classifyEntry', () => {
  const cfg = { dataRoomRoots: ['data-room/'], clientIdentifiers: ['Globex'] };
  const base = { scope: 'internal', source: 'x', value: 'v', body: '' };
  it('flags source under a data-room root', () => {
    expect(classifyEntry({ ...base, source: 'data-room/a.pdf' }, cfg)).toHaveLength(1);
  });
  it('flags a client identifier case-insensitively', () => {
    expect(classifyEntry({ ...base, body: 'about globex' }, cfg)).toHaveLength(1);
  });
  it('does not flag clean or protected entries', () => {
    expect(classifyEntry(base, cfg)).toEqual([]);
    expect(classifyEntry({ ...base, scope: 'protected', source: 'data-room/a' }, cfg)).toEqual([]);
  });
});

describe('loadKnowledgeConfig', () => {
  it('uses the stated defaults', () => {
    const c = loadKnowledgeConfig(project({ 'x.txt': '' }));
    expect(c.trackedRoot).toBe('.ai-sdlc/knowledge');
    expect(c.protectedRoot).toBe('.ai-sdlc/knowledge-protected');
  });
  it('reads overrides', () => {
    const c = loadKnowledgeConfig(
      project({
        '.ai-sdlc/context.yaml': 'knowledge:\n  trackedRoot: kb\n  protectedRoot: ../kb-private\n',
      }),
    );
    expect(c.trackedRoot).toBe('kb');
    expect(c.protectedRoot).toBe('../kb-private');
  });
});

describe('ontology', () => {
  it('default ontology parses cleanly', () => {
    const { ontology, errors } = parseOntology(
      'trunks: [a]\nentryTypes: [b]\nrelations: [c]\nproofKinds: [d]\n',
    );
    expect(errors).toEqual([]);
    expect(ontology.proofKinds).toEqual(['d']);
    expect(DEFAULT_ONTOLOGY.proofKinds).toContain('path-exists');
  });
  it('reports invalid YAML', () => {
    expect(parseOntology('a: [').errors[0]).toContain('invalid YAML');
  });
});

describe('findProtectedCitations', () => {
  const files = {
    '.ai-sdlc/knowledge-protected/customers/c.md': entryText({
      id: 'acme-pricing',
      trunk: 'customers',
      scope: 'protected',
    }),
  };
  it('finds a cited id and the root path', () => {
    const p = project(files);
    expect(findProtectedCitations(p, 'uses acme-pricing here')).toEqual(['acme-pricing']);
    expect(findProtectedCitations(p, 'see .ai-sdlc/knowledge-protected/x')).toEqual([
      '.ai-sdlc/knowledge-protected/',
    ]);
  });
  it('passes a clean body', () => {
    expect(findProtectedCitations(project(files), 'nothing here, acme-pricing-2 neither')).toEqual(
      [],
    );
  });
});
