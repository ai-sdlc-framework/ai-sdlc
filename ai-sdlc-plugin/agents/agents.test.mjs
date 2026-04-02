/**
 * Tests for AI-SDLC agent definition files.
 *
 * Parses the YAML frontmatter from each agent .md file and verifies
 * tool restrictions are correctly defined.
 *
 * Run with: node --test ai-sdlc-plugin/agents/agents.test.mjs
 * Uses Node.js built-in test runner (no Vitest needed).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Parse YAML frontmatter from a markdown file.
 * Extracts the content between --- delimiters and parses simple YAML
 * (scalar fields and list fields).
 */
function parseFrontmatter(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error(`No frontmatter found in ${filePath}`);

  const yaml = match[1];
  const result = {};
  const lines = yaml.split('\n');

  let currentKey = null;

  for (const line of lines) {
    // List item
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentKey) {
      if (!Array.isArray(result[currentKey])) {
        result[currentKey] = [];
      }
      result[currentKey].push(listMatch[1].trim());
      continue;
    }

    // Key-value pair
    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const value = kvMatch[2].trim();
      if (value) {
        result[key] = value;
      }
      currentKey = key;
      continue;
    }
  }

  return result;
}

const agentFiles = ['code-reviewer.md', 'security-reviewer.md', 'test-reviewer.md'];
const agents = {};

before(() => {
  for (const file of agentFiles) {
    const filePath = join(__dirname, file);
    agents[file] = parseFrontmatter(filePath);
  }
});

describe('agent definition tool restrictions', () => {
  it('code-reviewer.md has Edit in disallowedTools', () => {
    assert.ok(
      agents['code-reviewer.md'].disallowedTools.includes('Edit'),
      'code-reviewer should disallow Edit',
    );
  });

  it('code-reviewer.md has Write in disallowedTools', () => {
    assert.ok(
      agents['code-reviewer.md'].disallowedTools.includes('Write'),
      'code-reviewer should disallow Write',
    );
  });

  it('security-reviewer.md has Bash in disallowedTools', () => {
    assert.ok(
      agents['security-reviewer.md'].disallowedTools.includes('Bash'),
      'security-reviewer should disallow Bash',
    );
  });

  it('test-reviewer.md has Edit in disallowedTools', () => {
    assert.ok(
      agents['test-reviewer.md'].disallowedTools.includes('Edit'),
      'test-reviewer should disallow Edit',
    );
  });

  it('test-reviewer.md has Write in disallowedTools', () => {
    assert.ok(
      agents['test-reviewer.md'].disallowedTools.includes('Write'),
      'test-reviewer should disallow Write',
    );
  });

  it('all agents have AgentTool in disallowedTools', () => {
    for (const file of agentFiles) {
      assert.ok(
        agents[file].disallowedTools.includes('AgentTool'),
        `${file} should disallow AgentTool`,
      );
    }
  });

  it('all agents have Read in tools', () => {
    for (const file of agentFiles) {
      assert.ok(agents[file].tools.includes('Read'), `${file} should have Read in allowed tools`);
    }
  });

  it('all agents have a name field', () => {
    for (const file of agentFiles) {
      assert.ok(agents[file].name, `${file} should have a name`);
    }
  });

  it('all agents have a description field', () => {
    for (const file of agentFiles) {
      assert.ok(agents[file].description, `${file} should have a description`);
    }
  });

  it('all agents specify sonnet as the model', () => {
    for (const file of agentFiles) {
      assert.equal(agents[file].model, 'sonnet', `${file} should use sonnet model`);
    }
  });
});
