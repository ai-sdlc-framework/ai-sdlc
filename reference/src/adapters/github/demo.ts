#!/usr/bin/env tsx
/**
 * Live demo of the GitHub adapter against the ai-sdlc repo.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_... pnpm tsx reference/src/adapters/github/demo.ts
 *
 * All operations are read-only.
 */

import { createGitHubIssueTracker, createGitHubSourceControl } from './index.js';

const config = {
  org: 'ai-sdlc-framework',
  repo: 'ai-sdlc',
  token: { secretRef: 'github-token' },
};

async function main() {
  if (!process.env.GITHUB_TOKEN) {
    console.error('Error: GITHUB_TOKEN environment variable is required.');
    console.error('  export GITHUB_TOKEN=ghp_your_token_here');
    process.exit(1);
  }

  console.log('=== GitHub Adapter Demo ===\n');
  console.log(`Target: ${config.org}/${config.repo}\n`);

  // ── IssueTracker ────────────────────────────────────────────────
  console.log('--- IssueTracker ---\n');
  const tracker = createGitHubIssueTracker(config);

  const issues = await tracker.listIssues({});
  console.log(`Found ${issues.length} open issues`);
  if (issues.length > 0) {
    const first = issues[0];
    console.log(`  #${first.id}: ${first.title}`);
    console.log(`  Status: ${first.status} | Labels: ${first.labels?.join(', ') || 'none'}`);
    console.log(`  URL: ${first.url}\n`);

    const fetched = await tracker.getIssue(first.id);
    console.log(`getIssue(${first.id}) returned: "${fetched.title}"\n`);
  } else {
    console.log('  (no open issues found)\n');
  }

  // ── SourceControl ───────────────────────────────────────────────
  console.log('--- SourceControl ---\n');
  const sc = createGitHubSourceControl(config);

  const readme = await sc.getFileContents('README.md', 'main');
  const firstLine = readme.content.split('\n')[0];
  console.log(`README.md first line: ${firstLine}`);
  console.log(`  Encoding: ${readme.encoding}`);
  console.log(`  Length: ${readme.content.length} chars\n`);

  const pkg = await sc.getFileContents('package.json', 'main');
  const parsed = JSON.parse(pkg.content);
  console.log(`package.json name: ${parsed.name}`);
  console.log(`  Version: ${parsed.version}\n`);

  console.log('=== Demo complete ===');
}

main().catch((err) => {
  console.error('Demo failed:', err.message);
  process.exit(1);
});
