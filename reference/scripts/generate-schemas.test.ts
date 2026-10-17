import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generate, toCamelCase } from './generate-schemas.js';

describe('generate-schemas', () => {
  let dir: string;
  let schemas: string;
  let out: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gen-schemas-'));
    schemas = join(dir, 'schemas');
    mkdirSync(schemas);
    writeFileSync(join(schemas, 'a-b.schema.json'), '{"type":"object"}\n');
    out = join(dir, 'generated.ts');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('camel-cases schema filenames', () => {
    expect(toCamelCase('dor-config.v1.schema.json')).toBe('dorConfigV1Schema');
  });

  it('writes formatted output and leaves no temp files', async () => {
    expect(await generate(schemas, out)).toBe(true);
    expect(readFileSync(out, 'utf-8')).toContain('export const aBSchema');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('does not touch the file when content is unchanged', async () => {
    await generate(schemas, out);
    const before = statSync(out).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    expect(await generate(schemas, out)).toBe(false);
    expect(statSync(out).mtimeMs).toBe(before);
  });

  it('rewrites when schemas change', async () => {
    await generate(schemas, out);
    writeFileSync(join(schemas, 'c.schema.json'), '{"type":"string"}\n');
    expect(await generate(schemas, out)).toBe(true);
    expect(readFileSync(out, 'utf-8')).toContain('export const cSchema');
  });
});

describe('dogfood script contract (AISDLC-920)', () => {
  const pkg = JSON.parse(
    readFileSync(resolve(__dirname, '../../dogfood/package.json'), 'utf-8'),
  ) as { scripts: Record<string, string> };

  it('keeps pretest and has no workspace build in a coverage pre-hook', () => {
    expect(pkg.scripts.pretest).toBe('pnpm build');
    expect(pkg.scripts['pretest:coverage']).toBeUndefined();
  });
});
