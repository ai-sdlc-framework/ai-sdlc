/**
 * Unit tests for lib/merge-matcher.js (AISDLC-605). Run: node --test lib/merge-matcher.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const m = require('./merge-matcher.js');

describe('stripComment', () => {
  it('keeps a #N positional (# not at a word boundary)', () => {
    assert.equal(m.stripComment('gh pr merge acme/w#42 --auto'), 'gh pr merge acme/w#42 --auto');
  });
  it('cuts a comment at a word boundary or at the start', () => {
    assert.equal(m.stripComment('gh pr merge 42 # --auto'), 'gh pr merge 42');
    assert.equal(m.stripComment('# whole line'), '');
  });
});

describe('stripComment (quote-aware)', () => {
  it('does not cut at a quoted # and keeps the rest of the segment', () => {
    assert.equal(m.stripComment(`bash -c 'echo " #"; x'`), `bash -c 'echo " #"; x'`);
    assert.equal(m.stripComment('echo "a #b" # real'), 'echo "a #b"');
  });
});

describe('isInertSegment / pipelines', () => {
  it('classifies inert vs unknown command words', () => {
    for (const c of [
      'echo x',
      'then echo x',
      'grep -r y .',
      'git commit -m z',
      'gh pr comment 1',
    ]) {
      assert.equal(m.isInertSegment(c), true, c);
    }
    for (const c of [
      'env bash',
      'sudo sh',
      'then bash',
      'git -c a=b c',
      'tee >(sh)',
      'pnpm exec x',
    ]) {
      assert.equal(m.isInertSegment(c), false, c);
    }
  });
  it('marks pipe-fed stages', () => {
    const segs = m.splitShellSegmentsEx('a | b |& c && d');
    assert.deepEqual(
      segs.map((s) => s.pipe),
      [false, true, true, false],
    );
  });
});

describe('splitShellSegments', () => {
  it('splits on unquoted operators only', () => {
    assert.deepEqual(m.splitShellSegments('a && b; c | d\ne'), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(m.splitShellSegments('echo "a; b" && c'), ['echo "a; b"', 'c']);
  });
  it('falls back to a naive split on unbalanced quotes (fail closed)', () => {
    assert.deepEqual(m.splitShellSegments('echo "a; gh pr merge 1'), ['echo "a', 'gh pr merge 1']);
  });
});

describe('commandRunsGhPrMerge', () => {
  it('detects the command being run', () => {
    for (const c of [
      'gh pr merge 42',
      'GH_TOKEN=x gh pr merge 42',
      'gh "pr" merge 42',
      'cd r && gh pr merge 42 --auto',
      'sh -c "gh pr merge 42"',
      'echo $(gh pr merge 42)',
      'echo "gh pr merge 42" | sh',
      'cat <<EOF | bash\ngh pr merge 1\nEOF',
    ]) {
      assert.equal(m.commandRunsGhPrMerge(c), true, c);
    }
  });
  it('ignores the phrase as data', () => {
    for (const c of [
      'echo gh pr merge 42',
      'grep "gh pr merge" f',
      'git commit -m "gh pr merge"',
      "cat <<'EOF'\ngh pr merge 42\nEOF",
      'gh pr view 42',
    ]) {
      assert.equal(m.commandRunsGhPrMerge(c), false, c);
    }
  });
  it('keeps pipe tracking across fd redirections containing & (AISDLC-605)', () => {
    const phrase = ['gh', 'pr', 'merge', '42'].join(' ');
    for (const redir of ['2>&1', '>&2', '&>', '&>/dev/null', '2>&1 1>&2', '<&3']) {
      for (const sink of ['sh', 'bash']) {
        const c = `echo "${phrase}" ${redir} | ${sink}`;
        assert.equal(m.commandRunsGhPrMerge(c), true, c);
      }
    }
    // data-only use stays allowed
    assert.equal(m.commandRunsGhPrMerge(`echo "${phrase}" 2>&1 | cat`), false);
  });
  it('still treats && , & and background & as operators (AISDLC-605)', () => {
    assert.deepEqual(m.splitShellSegments('a && b'), ['a', 'b']);
    assert.deepEqual(m.splitShellSegments('a & b'), ['a', 'b']);
    assert.deepEqual(m.splitShellSegments('a &'), ['a']);
    assert.deepEqual(m.splitShellSegments('a 2>&1 | b'), ['a 2>&1', 'b']);
    assert.deepEqual(
      m.splitShellSegmentsEx('a 2>&1 | b').map((s) => s.pipe),
      [false, true],
    );
    assert.equal(m.commandRunsGhPrMerge(`sleep 1 & ${['gh', 'pr', 'merge', '1'].join(' ')}`), true);
  });
  it('does not let a fake heredoc opener hide a real command', () => {
    assert.equal(m.commandRunsGhPrMerge('echo "<<X"\ngh pr merge 1'), true);
    assert.equal(m.commandRunsGhPrMerge('echo $((1<<X))\ngh pr merge 1'), true);
  });
});

describe('round-2 security bypasses (AISDLC-605)', () => {
  const phrase = ['gh', 'pr', 'merge'].join(' ') + ' 42 --auto';
  it('fails closed on a partly quoted heredoc delimiter word', () => {
    for (const opener of [
      'cat <<EOF"X"',
      'cat <<E"O"F',
      "cat <<'EOF'X",
      'cat <<EO\\F',
      'cat <<EOF$X',
    ]) {
      const c = `${opener}\nEOFX\n${phrase}\nEOF`;
      assert.equal(m.commandRunsGhPrMerge(c), true, opener);
    }
  });
  it('still strips bodies for plain and fully quoted delimiters', () => {
    assert.equal(m.commandRunsGhPrMerge(`cat <<EOF\n${phrase}\nEOF`), false);
    assert.equal(m.commandRunsGhPrMerge(`cat <<'EOF'\n${phrase}\nEOF`), false);
    assert.equal(m.commandRunsGhPrMerge(`cat <<"EOF"\n${phrase}\nEOF`), false);
  });
  it('keeps the body when the heredoc opener line continues with a backslash-newline', () => {
    assert.equal(m.commandRunsGhPrMerge(`cat <<EOF \\\n| sh\n${phrase}\nEOF`), true);
  });
  it('denies a merge phrase inside a leading env assignment of an inert command', () => {
    const cmds = [
      `GIT_EDITOR='${phrase} #' git commit --allow-empty`,
      `GIT_EXTERNAL_DIFF='${phrase}' git diff`,
      `LESSOPEN='|${phrase} %s' less f`,
      `GIT_EDITOR=${['gh', 'pr', 'merge'].join('\\ ')}\\ 42 git commit`,
    ];
    for (const c of cmds) assert.equal(m.commandRunsGhPrMerge(c), true, c);
    assert.equal(m.commandRunsGhPrMerge(`FOO=1 echo "${phrase}"`), false);
  });
  it('does not treat program-running options of allowlisted words as inert', () => {
    assert.equal(m.isInertSegment('sort --compress-program=sh f'), false);
    assert.equal(m.isInertSegment('git diff --ext-diff'), false);
    assert.equal(m.isInertSegment('git show --textconv HEAD'), false);
    assert.equal(m.isInertSegment('git diff --stat'), true);
  });
});

describe('read-stdin module', () => {
  it('exports a reader that never references /dev/stdin', () => {
    const src = readFileSync(new URL('./read-stdin.js', import.meta.url), 'utf-8');
    assert.doesNotMatch(src, /\/dev\/stdin/);
    assert.equal(typeof require('./read-stdin.js').readStdinSync, 'function');
  });
});
