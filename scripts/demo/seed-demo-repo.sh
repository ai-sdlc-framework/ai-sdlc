#!/usr/bin/env bash
# Seed the hierarchy walkthrough demo repo (AISDLC-772).
#
# Creates a tiny self-contained repo with three tasks whose implementations are
# 10 to 30 lines each and pass review on the first round. Idempotent: the target
# directory is rebuilt from scratch with fixed identity and dates, so two runs
# yield the same commit SHA.
#
# Usage: scripts/demo/seed-demo-repo.sh [target-dir]   (default: $DEMO_REPO_DIR or ~/ai-sdlc-demo)
set -euo pipefail

TARGET="${1:-${DEMO_REPO_DIR:-$HOME/ai-sdlc-demo}}"
MARKER=".ai-sdlc-demo-repo"

if [ -e "$TARGET" ]; then
  if [ ! -f "$TARGET/$MARKER" ]; then
    echo "refusing to overwrite $TARGET: not a demo repo (no $MARKER marker)" >&2
    exit 1
  fi
  # Guarded: only a directory carrying the marker is ever removed.
  rm -rf -- "$TARGET"
fi

mkdir -p "$TARGET/src" "$TARGET/test" "$TARGET/backlog/tasks"
cd "$TARGET"
printf 'ai-sdlc hierarchy walkthrough demo repo\n' > "$MARKER"

cat > package.json <<'JSON'
{
  "name": "ai-sdlc-demo",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test test/*.test.mjs" }
}
JSON

cat > README.md <<'MD'
# ai-sdlc demo repo

Three small tasks for the hierarchy walkthrough. Each is a single function in
`src/` with a stub that throws and a test in `test/` that fails until the
function is implemented.
MD

cat > src/slugify.mjs <<'JS'
/** Lowercase, hyphen-separated slug of `text`. */
export function slugify(text) {
  throw new Error('not implemented');
}
JS
cat > test/slugify.test.mjs <<'JS'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.mjs';

test('slugify lowercases and hyphenates', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  A  b--c '), 'a-b-c');
});
JS

cat > src/clamp.mjs <<'JS'
/** Constrain `n` to the inclusive range [min, max]. */
export function clamp(n, min, max) {
  throw new Error('not implemented');
}
JS
cat > test/clamp.test.mjs <<'JS'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/clamp.mjs';

test('clamp constrains to range', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(2, 0, 3), 2);
  assert.throws(() => clamp(1, 3, 0), RangeError);
});
JS

cat > src/chunk.mjs <<'JS'
/** Split `items` into arrays of at most `size` elements. */
export function chunk(items, size) {
  throw new Error('not implemented');
}
JS
cat > test/chunk.test.mjs <<'JS'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk } from '../src/chunk.mjs';

test('chunk splits into groups', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
  assert.throws(() => chunk([1], 0), RangeError);
});
JS

mk_task() { # id slug title description
  cat > "backlog/tasks/DEMO-$1 - $2.md" <<MD
---
id: DEMO-$1
title: $3
status: To Do
priority: medium
---

## Description

$4

## Acceptance criteria

- [ ] #1 The failing test in \`test/$2.test.mjs\` passes.
- [ ] #2 Implementation stays under 30 lines, no new dependencies.
MD
}
mk_task 1 slugify "Implement slugify" "Implement \`slugify\` in \`src/slugify.mjs\`: lowercase, strip punctuation, collapse whitespace and hyphens."
mk_task 2 clamp "Implement clamp" "Implement \`clamp\` in \`src/clamp.mjs\`; throw RangeError when min is greater than max."
mk_task 3 chunk "Implement chunk" "Implement \`chunk\` in \`src/chunk.mjs\`; throw RangeError when size is below 1."

export GIT_AUTHOR_NAME="Demo" GIT_AUTHOR_EMAIL="demo@example.invalid"
export GIT_COMMITTER_NAME="Demo" GIT_COMMITTER_EMAIL="demo@example.invalid"
export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"
git init -q -b main .
git config commit.gpgsign false
git add -- .
git commit -q -m "chore: seed demo repo with three tasks"
git tag -f demo-start >/dev/null
echo "seeded $TARGET at $(git rev-parse --short HEAD)"
