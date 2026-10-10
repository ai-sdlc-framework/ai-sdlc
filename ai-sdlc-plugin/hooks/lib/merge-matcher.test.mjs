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
  it('refuses every heredoc whose body holds the phrase (DEC-0085, no body stripping)', () => {
    for (const opener of [
      'cat <<EOF',
      "cat <<'EOF'",
      'cat <<"EOF"',
      'cat <<EOF"X"',
      'cat <<E"O"F',
      "cat <<'EOF'X",
      'cat <<EO\\F',
      'cat <<EOF$X',
      'cat <<-EOF',
    ]) {
      const c = `${opener}\n${phrase}\nEOF`;
      assert.equal(m.commandRunsGhPrMerge(c), true, opener);
    }
  });
  it('refuses heredoc-evasion shapes that made bash and the matcher disagree (DEC-0085)', () => {
    const cases = {
      'opener inside a multi-line quoted string, then a real merge': `echo "a\ncat <<EOF\nb"\n${phrase}\nEOF`,
      'trailing pipe continuation': `cat <<EOF |\nsh\n${phrase}\nEOF`,
      'previous-line continuation': `echo hi \\\n<<EOF\n${phrase}\nEOF`,
      'quote opened on an earlier line': `echo "x\ny" ; cat <<EOF\n${phrase}\nEOF`,
      'dollar-bracket arithmetic': `echo $[1<<2]\n${phrase}`,
      'dollar-bracket arithmetic hiding an opener': `echo $[ 1 << EOF ]\n${phrase}\nEOF`,
    };
    for (const [name, c] of Object.entries(cases)) {
      assert.equal(m.commandRunsGhPrMerge(c), true, name);
    }
  });
  it('refuses env-prefix after a leading paren, brace or reserved word', () => {
    for (const c of [
      `(FOO=1 ${phrase})`,
      `{ ${phrase}; }`,
      `{ FOO=1 ${phrase}; }`,
      `if true; then ${phrase}; fi`,
      `if true; then FOO=1 ${phrase}; fi`,
      `! ${phrase}`,
      `while true; do ${phrase}; done`,
    ]) {
      assert.equal(m.commandRunsGhPrMerge(c), true, c);
    }
  });
  it('an escaped angle bracket before an ampersand is not an fd redirection', () => {
    for (const c of [`echo x \\> & ${phrase}`, `echo x \\<& ${phrase}`, `echo x \\>& ${phrase}`]) {
      assert.equal(m.commandRunsGhPrMerge(c), true, c);
    }
  });
  it('denies a merge phrase inside a leading env assignment of an inert command', () => {
    const cmds = [
      `GIT_EDITOR='${phrase} #' git commit --allow-empty`,
      `GIT_EXTERNAL_DIFF='${phrase}' git diff`,
      `LESSOPEN='|${phrase} %s' less f`,
      `GIT_EDITOR=${['gh', 'pr', 'merge'].join('\\ ')}\\ 42 git commit`,
    ];
    for (const c of cmds) assert.equal(m.commandRunsGhPrMerge(c), true, c);
    // An assignment prefix makes the segment opaque, so a mention is refused (round-5 structural rule).
    assert.equal(m.commandRunsGhPrMerge(`FOO=1 echo "${phrase}"`), true);
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

describe('round-4 security bypasses (AISDLC-605)', () => {
  const mg = ['mer', 'ge'].join('');
  const refused = [
    `gh -R owner/repo pr ${mg} 42`,
    `gh --repo owner/repo pr ${mg} 42`,
    `gh --repo=owner/repo pr ${mg} 42`,
    `gh pr -R o/r ${mg} 42`,
    `gh pr --repo o/r ${mg} 42`,
    `gh pr --repo=o/r ${mg} 42`,
    `gh.exe -R o/r pr ${mg} 42`,
    `gh "pr" '${mg}' 42`,
    `gh alias set mm 'pr ${mg}'`,
    `gh alias set mm "pr ${mg} --squash"`,
    'gh alias import aliases.yml',
    'gh alias import',
    `gh pr $'${mg}' 42`,
    `gh $'pr' ${mg} 42`,
    `gh pr $"${mg}" 42`,
    "gh pr $'\\x6derge' 42",
    "gh pr $'\\155erge' 42",
    `gh pr {${mg},} 42`,
    `gh {pr,} ${mg} 42`,
    `echo x \\\\> /dev/null; gh pr ${mg} 42`,
  ];
  it('refuses global flags, alias set/import, ANSI-C and brace spellings', () => {
    for (const c of refused) assert.equal(m.commandRunsGhPrMerge(c), true, c);
  });
  it('still allows inert prose, commit text and read-only gh', () => {
    const allowed = [
      `echo "gh pr ${mg} is forbidden"`,
      `git commit -m "docs: mention gh pr ${mg}"`,
      `echo "gh -R o/r pr ${mg} 42"`,
      'gh pr view 42',
      'gh -R o/r pr view 42',
      'gh alias list',
      'gh pr list --repo o/r',
    ];
    for (const c of allowed) assert.equal(m.commandRunsGhPrMerge(c), false, c);
  });
});

describe('round-5 structural rule: opaque segments mentioning the merge phrase are refused (AISDLC-605)', () => {
  const mg = ['mer', 'ge'].join('');
  const gh = ['g', 'h'].join('');
  const GH = `/opt/homebrew/bin/g[h]`;
  const opaqueRefused = [
    `echo $'\\''; ${gh} pr ${mg} 42 #'`,
    `${gh} pr mer\\\nge 42`,
    `{${gh},pr} ${mg} 42`,
    `${gh} {pr,${mg}} 42`,
    `{${gh},pr,${mg}} 42`,
    `${gh} pr {${mg},} 42`,
    `${gh}\${IFS}pr\${IFS}${mg} 42`,
    `${gh} pr\${IFS}${mg} 42`,
    `${gh} pr $(echo ${mg}) 5`,
    `A=${mg}; ${gh} pr $A 5`,
    `X=1 ${gh} pr ${mg} 5`,
    `${GH} pr ${mg} 42`,
    `$(echo ${gh}) pr ${mg} 42`,
    `${gh} pr -F x ${mg} 5`,
    `${gh} pr $'${mg}' 42`,
    `${gh} pr $"${mg}" 42`,
    `${gh} alias set mm 'pr ${mg}'`,
    `${gh} pr \`echo ${mg}\` 5`,
    `${gh} pr {1..3} ${mg}`,
  ];
  it('refuses every reviewer bypass shape from rounds 3 and 4', () => {
    for (const c of opaqueRefused) assert.equal(m.commandRunsGhPrMerge(c), true, c);
  });
  it('flags the opaque constructs', () => {
    for (const c of [
      "echo $'x'",
      'a\\\nb',
      '{a,b} c',
      '{1..3}',
      'a${IFS}b',
      'X=1 cmd',
      'gh pr $A',
      'g[h] pr',
    ]) {
      assert.equal(m.isOpaqueSegment(c), true, c);
    }
    for (const c of ['echo x', 'gh pr view 42', 'echo "{a,b}"', 'git commit -m "x y"']) {
      assert.equal(m.isOpaqueSegment(c), false, c);
    }
  });
  it('refuses expansions spliced inside the merge words (round 6)', () => {
    for (const c of [
      `${gh} pr ${mg.slice(0, 4)}$(:)${mg.slice(4)} 42`,
      `${gh} pr ${mg.slice(0, 4)}\`\`${mg.slice(4)} 42`,
      `${gh} p$(:)r ${mg} 42`,
      `${gh} pr mer{g..g}e 42`,
      `${gh} p{r..r} ${mg} 42`,
      `${gh} pr ${mg.slice(0, 4)}\${u}${mg.slice(4)} 42`,
      `g[h] pr ${mg} 42`,
      `${gh}\${IFS}pr\${IFS}${mg} 42`,
      `X=1 ${gh} pr ${mg} 5`,
      `${gh} pr mer\\\nge 42`,
    ]) {
      assert.equal(m.commandRunsGhPrMerge(c), true, c);
    }
  });
  it('refuses spliced API merge paths through the API mention test', () => {
    const ok = () => true;
    for (const c of [
      `${gh} api -X PUT repos/o/r/pulls/5/mer$(:)ge`,
      `${gh} api -X PUT repos/o/r/pulls/5/mer{g..g}e`,
    ]) {
      assert.equal(
        m.commandHasUninertMatch(c, () => false, m.mentionsApiMerge),
        true,
        c,
      );
    }
    assert.equal(
      m.commandHasUninertMatch(`${gh} api repos/o/r/pulls/5`, ok, m.mentionsApiMerge),
      true,
    );
  });
  it('normalizeExpansions collapses spliced spellings', () => {
    assert.ok(m.normalizeExpansions('mer{g..g}e').includes(mg));
    assert.ok(m.normalizeExpansions('merg$(:)e').includes(mg));
  });
  it('treats an assignment prefix on inert prose that mentions the phrase as opaque and refuses it', () => {
    assert.equal(m.commandRunsGhPrMerge(`FOO=1 echo "${gh} pr ${mg}"`), true);
  });
  it('still allows opaque or plain commands that do not mention the merge phrase', () => {
    for (const c of [
      `echo $'x' done`,
      `X=1 ${gh} pr view 42`,
      `echo \${IFS}`,
      `${gh} pr view $PR`,
    ]) {
      assert.equal(m.commandRunsGhPrMerge(c), false, c);
    }
  });
  it('keeps the earlier allow cases allowed', () => {
    for (const c of [
      `echo "${gh} pr ${mg} is forbidden"`,
      `git commit -m "docs: mention ${gh} pr ${mg}"`,
      `echo "${gh} -R o/r pr ${mg} 42"`,
      `${gh} pr view 42`,
      `${gh} alias list`,
      `${gh} pr list --repo o/r`,
      `echo notes about other things`,
      `git commit -m "fix: tidy docs"`,
    ]) {
      assert.equal(m.commandRunsGhPrMerge(c), false, c);
    }
  });
});

describe('round-7: globs in the subcommand slot and word-boundary gh fallback (AISDLC-605)', () => {
  const mg = ['mer', 'ge'].join('');
  const gh = ['g', 'h'].join('');
  it('refuses a glob in the subcommand slot', () => {
    for (const c of [`touch ${mg}; ${gh} pr m?rge 5`, `echo > ${mg}; ${gh} pr m[e]rge 5`]) {
      assert.equal(m.commandRunsGhPrMerge(c), true, c);
    }
    assert.equal(m.isOpaqueSegment(`${gh} pr m?rge 5`), true);
  });
  it('still refuses spliced spellings', () => {
    for (const c of [
      `${gh} pr mer$(:)ge 42`,
      `${gh} pr mer{g..g}e 42`,
      `${gh} p{r..r} ${mg} 42`,
      `${gh} pr mer\${u}ge 42`,
    ]) {
      assert.equal(m.commandRunsGhPrMerge(c), true, c);
    }
  });
  it('allows read-only gh with merge-prefixed fields and trusted comments', () => {
    for (const c of [
      `${gh} pr view $PR --json mergeStateStatus`,
      `${gh} pr view $N --json mergeable`,
      `${gh} pr view $N --json state # no ${mg}`,
    ]) {
      assert.equal(m.commandRunsGhPrMerge(c), false, c);
    }
  });
  it('keeps refusing when the quote state is untrusted', () => {
    assert.equal(m.commandRunsGhPrMerge(`${gh} pr view $N $'x' # no ${mg}`), true);
  });
});

describe('round-8: any gh segment with pr before merge is refused (AISDLC-605)', () => {
  const mg = ['mer', 'ge'].join('');
  const gh = ['g', 'h'].join('');
  const refused = [
    `${gh} -b x pr ${mg} 42`,
    `${gh} --body x pr ${mg} 42`,
    `${gh} -t x pr ${mg} 42`,
    `${gh} pr -b a -b b -b c ${mg} 42`,
    `${gh} pr -b a -t b -b c -t d ${mg} 42`,
  ];
  const allowed = [
    `${gh} pr view 5 --json mergeStateStatus,mergeable`,
    `${gh} -R o/r pr view 5`,
    `${gh} pr list --repo o/r`,
    `${gh} pr list --search "is:open"`,
    `echo "${gh} -b x pr ${mg} 42"`,
  ];
  it('refuses unknown-flag-value shifts', () => {
    for (const c of refused) assert.equal(m.commandRunsGhPrMerge(c), true, c);
  });
  it('allows read-only gh and inert prose', () => {
    for (const c of allowed) assert.equal(m.commandRunsGhPrMerge(c), false, c);
  });
});
