/**
 * Tests for the /ai-sdlc memory-dream slash command definition (AISDLC-729).
 *
 * Run with: node --test ai-sdlc-plugin/commands/memory-dream.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cmdFile = join(dirname(fileURLToPath(import.meta.url)), 'memory-dream.md');
let frontmatter;
let body;

before(() => {
  const match = readFileSync(cmdFile, 'utf-8').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('No frontmatter in memory-dream.md');
  frontmatter = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.+)$/);
    if (kv) frontmatter[kv[1]] = kv[2].trim();
  }
  body = match[2];
});

describe('/ai-sdlc memory-dream', () => {
  it('declares name, a pinned haiku model and Bash + Read only', () => {
    assert.equal(frontmatter.name, 'memory-dream');
    assert.equal(frontmatter.model, 'haiku');
    assert.equal(frontmatter['allowed-tools'], 'Bash, Read');
  });

  it('resolves the CLI via resolve-pipeline-cli.sh, not a bare path', () => {
    assert.match(body, /resolve-pipeline-cli\.sh/);
    assert.match(body, /\$PIPELINE_CLI_BIN\/cli-memory-dream\.mjs/);
  });

  it('documents run, apply and undo and keeps notes private', () => {
    for (const s of ['`run`', '`apply <output-folder>`', '`undo`', 'private', 'dry-run']) {
      assert.ok(body.includes(s), `missing ${s}`);
    }
  });

  it('never applies on its own', () => {
    assert.match(body, /Do not apply it unless the user asks/);
  });
});
