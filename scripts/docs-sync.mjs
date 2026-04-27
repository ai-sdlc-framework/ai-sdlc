#!/usr/bin/env node

/**
 * Documentation synchronization script
 *
 * Converts source markdown files from ai-sdlc/docs/ to MDX format
 * and copies them to ai-sdlc-io/content/docs/
 *
 * Source of truth: /ai-sdlc/docs/*.md
 * Published tree: /ai-sdlc-io/content/docs/*.mdx
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SOURCE_DOCS = path.join(PROJECT_ROOT, 'docs');
const TARGET_DOCS = path.join(PROJECT_ROOT, '..', 'ai-sdlc-io', 'content', 'docs');

/**
 * Extract title from markdown content (first H1 heading)
 * @param {string} content - Markdown content
 * @returns {string|null} - Extracted title or null
 */
function extractTitle(content) {
  const h1Match = content.match(/^#\s+(.+)$/m);
  return h1Match ? h1Match[1].trim() : null;
}

/**
 * Convert markdown to MDX with frontmatter
 * @param {string} content - Source markdown content
 * @param {string} relativePath - Relative path from docs root
 * @returns {string} - MDX content with frontmatter
 */
function convertToMdx(content, relativePath) {
  const title = extractTitle(content);

  if (!title) {
    console.warn(`Warning: No H1 heading found in ${relativePath}`);
  }

  // Build frontmatter
  const frontmatter = [
    '---',
    `title: "${title || path.basename(relativePath, '.md')}"`,
    '---',
    '',
  ].join('\n');

  return frontmatter + content;
}

/**
 * Recursively sync directory
 * @param {string} sourceDir - Source directory
 * @param {string} targetDir - Target directory
 * @param {string} relativeBase - Relative path from docs root
 */
function syncDirectory(sourceDir, targetDir, relativeBase = '') {
  if (!fs.existsSync(sourceDir)) {
    console.error(`Source directory not found: ${sourceDir}`);
    return;
  }

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const relativePath = path.join(relativeBase, entry.name);

    if (entry.isDirectory()) {
      const targetSubdir = path.join(targetDir, entry.name);
      syncDirectory(sourcePath, targetSubdir, relativePath);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const content = fs.readFileSync(sourcePath, 'utf-8');
      const mdxContent = convertToMdx(content, relativePath);

      // Convert filename: README.md → index.mdx, other.md → other.mdx
      const targetFilename =
        entry.name === 'README.md' ? 'index.mdx' : entry.name.replace(/\.md$/, '.mdx');

      const targetPath = path.join(targetDir, targetFilename);

      fs.writeFileSync(targetPath, mdxContent, 'utf-8');
      console.log(`Converted: ${relativePath} → ${path.relative(TARGET_DOCS, targetPath)}`);
    }
  }
}

/**
 * Main sync function
 */
function main() {
  console.log('Starting documentation sync...');
  console.log(`Source: ${SOURCE_DOCS}`);
  console.log(`Target: ${TARGET_DOCS}`);
  console.log('');

  if (!fs.existsSync(SOURCE_DOCS)) {
    console.error(`Error: Source docs directory not found: ${SOURCE_DOCS}`);
    process.exit(1);
  }

  if (!fs.existsSync(path.dirname(TARGET_DOCS))) {
    console.error(`Error: ai-sdlc-io directory not found: ${path.dirname(TARGET_DOCS)}`);
    console.error('Make sure ai-sdlc-io is cloned as a sibling directory to ai-sdlc');
    process.exit(1);
  }

  syncDirectory(SOURCE_DOCS, TARGET_DOCS);

  console.log('');
  console.log('Documentation sync complete!');
  console.log('Review the changes in ai-sdlc-io and commit if everything looks correct.');
}

main();
