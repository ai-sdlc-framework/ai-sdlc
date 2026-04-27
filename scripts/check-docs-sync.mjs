#!/usr/bin/env node

/**
 * Documentation sync validation script
 *
 * Verifies that ai-sdlc-io/content/docs/ matches ai-sdlc/docs/
 * Fails CI if:
 * - Source .md file exists without corresponding .mdx in target
 * - Content differs (ignoring frontmatter)
 * - Orphaned .mdx files exist in target
 *
 * Usage: node scripts/check-docs-sync.mjs
 * Exit code: 0 = in sync, 1 = diverged
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SOURCE_DOCS = path.join(PROJECT_ROOT, 'docs');
const TARGET_DOCS = path.join(PROJECT_ROOT, '..', 'ai-sdlc-io', 'content', 'docs');

// Known orphaned files (exist in target but not in source)
// These should be backfilled to source over time
const KNOWN_ORPHANS = new Set([
  'api-reference/design-intent.mdx',
  'api-reference/governance.mdx',
  'api-reference/priority.mdx',
  'api-reference/review-calibration.mdx',
  'api-reference/sdk-runner.mdx',
  'tutorials/07-workflow-patterns.mdx',
  'tutorials/08-claude-code-plugin.mdx',
  'tutorials/09-review-calibration.mdx',
]);

let hasErrors = false;

/**
 * Strip YAML frontmatter from content
 * @param {string} content - File content
 * @returns {string} - Content without frontmatter
 */
function stripFrontmatter(content) {
  const frontmatterRegex = /^---\n[\s\S]*?\n---\n/;
  return content.replace(frontmatterRegex, '').trim();
}

/**
 * Get all markdown files in a directory recursively
 * @param {string} dir - Directory to scan
 * @param {string} base - Base directory for relative paths
 * @returns {string[]} - Array of relative file paths
 */
function getMarkdownFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...getMarkdownFiles(fullPath, base));
    } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.mdx'))) {
      files.push(path.relative(base, fullPath));
    }
  }

  return files;
}

/**
 * Convert source path to target path
 * @param {string} sourcePath - Relative path from source docs
 * @returns {string} - Corresponding path in target docs
 */
function sourceToTargetPath(sourcePath) {
  // README.md → index.mdx, other.md → other.mdx
  const converted = sourcePath.replace(/README\.md$/, 'index.mdx').replace(/\.md$/, '.mdx');
  return converted;
}

/**
 * Convert target path to source path
 * @param {string} targetPath - Relative path from target docs
 * @returns {string} - Corresponding path in source docs
 */
function targetToSourcePath(targetPath) {
  // index.mdx → README.md, other.mdx → other.md
  const converted = targetPath.replace(/index\.mdx$/, 'README.md').replace(/\.mdx$/, '.md');
  return converted;
}

/**
 * Check if source and target content match (ignoring frontmatter)
 * @param {string} sourceContent - Source markdown content
 * @param {string} targetContent - Target MDX content
 * @returns {boolean} - True if content matches
 */
function contentMatches(sourceContent, targetContent) {
  const strippedSource = stripFrontmatter(sourceContent);
  const strippedTarget = stripFrontmatter(targetContent);
  return strippedSource === strippedTarget;
}

/**
 * Main validation function
 */
function main() {
  console.log('Checking documentation sync...');
  console.log(`Source: ${SOURCE_DOCS}`);
  console.log(`Target: ${TARGET_DOCS}`);
  console.log('');

  if (!fs.existsSync(SOURCE_DOCS)) {
    console.error(`Error: Source docs directory not found: ${SOURCE_DOCS}`);
    process.exit(1);
  }

  if (!fs.existsSync(TARGET_DOCS)) {
    console.error(`Error: Target docs directory not found: ${TARGET_DOCS}`);
    console.error('Make sure ai-sdlc-io is cloned as a sibling directory to ai-sdlc');
    process.exit(1);
  }

  // Get all source files
  const sourceFiles = getMarkdownFiles(SOURCE_DOCS);
  console.log(`Found ${sourceFiles.length} source files`);

  // Check each source file has a corresponding target
  for (const sourceFile of sourceFiles) {
    const targetFile = sourceToTargetPath(sourceFile);
    const sourcePath = path.join(SOURCE_DOCS, sourceFile);
    const targetPath = path.join(TARGET_DOCS, targetFile);

    if (!fs.existsSync(targetPath)) {
      console.error(`✗ Missing target file: ${targetFile} (source: ${sourceFile})`);
      hasErrors = true;
      continue;
    }

    // Compare content
    const sourceContent = fs.readFileSync(sourcePath, 'utf-8');
    const targetContent = fs.readFileSync(targetPath, 'utf-8');

    if (!contentMatches(sourceContent, targetContent)) {
      console.error(`✗ Content mismatch: ${sourceFile} ↔ ${targetFile}`);
      hasErrors = true;
    } else {
      console.log(`✓ ${sourceFile} ↔ ${targetFile}`);
    }
  }

  // Check for orphaned target files
  const targetFiles = getMarkdownFiles(TARGET_DOCS);
  console.log(`\nFound ${targetFiles.length} target files`);

  for (const targetFile of targetFiles) {
    const sourceFile = targetToSourcePath(targetFile);
    const sourcePath = path.join(SOURCE_DOCS, sourceFile);

    if (!fs.existsSync(sourcePath)) {
      if (KNOWN_ORPHANS.has(targetFile)) {
        console.log(`⚠ Known orphan: ${targetFile} (TODO: backfill to source)`);
      } else {
        console.error(`✗ Orphaned target file: ${targetFile} (no source: ${sourceFile})`);
        hasErrors = true;
      }
    }
  }

  console.log('');
  if (hasErrors) {
    console.error('Documentation sync check failed!');
    console.error('Run: node scripts/docs-sync.mjs to regenerate target files');
    process.exit(1);
  }

  console.log('✓ Documentation is in sync!');
  process.exit(0);
}

main();
