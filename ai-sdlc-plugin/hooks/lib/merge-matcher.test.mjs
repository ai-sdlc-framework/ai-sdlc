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
    // Planner grammar ruling: `>&` is opaque, so quoted data that mentions the phrase over-blocks (AISDLC-605.1).
    assert.equal(m.commandRunsGhPrMerge(`echo "${phrase}" 2>&1 | cat`), true);
    assert.equal(m.commandRunsGhPrMerge(`echo "${phrase}" | cat`), false);
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
    // A bare `FOO=1` assignment word is plain under the grammar, so inert prose stays allowed.
    assert.equal(m.commandRunsGhPrMerge(`FOO=1 echo "${phrase}"`), false);
  });
  it('does not treat program-running options of allowlisted words as inert', () => {
    assert.equal(m.isInertSegment('sort --compress-program=sh f'), false);
    assert.equal(m.isInertSegment('git diff --ext-diff'), false);
    assert.equal(m.isInertSegment('git show --textconv HEAD'), false);
    assert.equal(m.isInertSegment('git diff --stat'), true);
  });
  it('refuses abbreviated long options that run programs (getopt_long prefixes)', () => {
    for (const c of [
      'sort -S 1 --compress-prog=sh',
      'sort --compress=sh',
      'sort --comp=sh',
      'sort --c=sh',
      'sort --compress-program sh',
      'git diff --ext=foo',
      'git diff --ext-d',
      'git show --textc HEAD',
      'git log --textconv',
      'rg --pre=sh x',
      'rg --pr=sh x',
      'rg --pre sh x',
      'rg --hostname-bin=sh x',
      'less +!sh f',
      'more +sh f',
      'less -k keys f',
      'less --lesskey-file=k f',
    ]) {
      assert.equal(m.isInertSegment(c), false, c);
    }
  });
  it('keeps plain read-only uses inert', () => {
    for (const c of [
      'sort -u',
      'sort -n file',
      'sort -S 1 -T /tmp f',
      'grep -rn x .',
      'rg -n foo src',
      'git log --oneline -5',
      'git diff --stat',
      'git show HEAD',
      'cat f',
      'head -n 5',
      'wc -l',
      'jq .x'.replace('jq', 'cat'),
      'echo hi',
      'printf x',
      'less f',
      'more -d f',
    ]) {
      assert.equal(m.isInertSegment(c), true, c);
    }
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
      'gh pr $A',
      'g[h] pr',
    ]) {
      assert.equal(m.isOpaqueSegment(c), true, c);
    }
    for (const c of ['echo x', 'X=1 cmd', 'gh pr view 42', 'echo "{a,b}"', 'git commit -m "x y"']) {
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
  it('treats a plain assignment prefix on inert prose as allowed but refuses it before gh', () => {
    assert.equal(m.commandRunsGhPrMerge(`FOO=1 echo "${gh} pr ${mg}"`), false);
    assert.equal(m.commandRunsGhPrMerge(`FOO=1 ${gh} pr ${mg} 5`), true);
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
  it('allows read-only gh with merge-prefixed fields; a comment mentioning the phrase over-blocks', () => {
    for (const c of [
      `${gh} pr view $PR --json mergeStateStatus`,
      `${gh} pr view $N --json mergeable`,
    ]) {
      assert.equal(m.commandRunsGhPrMerge(c), false, c);
    }
    // Planner grammar ruling: `#` is opaque, so the raw-mention rule refuses (AISDLC-605.1 tracks the over-block).
    assert.equal(m.commandRunsGhPrMerge(`${gh} pr view $N --json state # no ${mg}`), true);
  });
  it('distrusts the comment boundary around substitutions (round 9)', () => {
    for (const c of [
      `${gh} pr \`true #\` ${mg} 42`,
      `${gh} pr \${x:+ #} ${mg} 42`,
      `${gh} pr $(true #) ${mg} 42`,
    ]) {
      assert.equal(m.commandRunsGhPrMerge(c), true, c);
    }
    // Over-blocked by the grammar ruling (`#` is opaque, comment text still mentions the phrase).
    assert.equal(m.commandRunsGhPrMerge(`${gh} pr view 5 --json state # no ${mg}`), true);
    assert.equal(m.commandRunsGhPrMerge(`echo hi # ${gh} pr ${mg} 5`), true);
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

describe('round-9: pr-before-merge applies to every gh token, behind wrappers (AISDLC-605)', () => {
  const mg = ['mer', 'ge'].join('');
  const gh = ['g', 'h'].join('');
  it('refuses wrapped and absolute-path gh', () => {
    for (const c of [
      `nice -n 10 ${gh} -b x pr ${mg} 42`,
      `env -u HOME ${gh} -b x pr ${mg} 42`,
      `sudo -u me ${gh} -b x pr ${mg} 42`,
      `exec -a n ${gh} -b x pr ${mg} 42`,
      `nice -n 10 ${gh} pr -b a -b b -b c ${mg} 42`,
      `command -p ${gh} pr ${mg} 42`,
      `timeout 60 ${gh} pr ${mg} 42`,
      `/usr/bin/${gh} -b x pr ${mg} 42`,
      `nice -n 10 /usr/bin/${gh} -b x pr ${mg} 42`,
    ]) {
      assert.equal(m.commandRunsGhPrMerge(c), true, c);
    }
  });
  it('allows read-only wrapped gh', () => {
    for (const c of [
      `${gh} alias list`,
      `nice -n 10 ${gh} pr view 5 --json mergeStateStatus,mergeable`,
      `env -u HOME ${gh} -R o/r pr list --search "is:open"`,
    ]) {
      assert.equal(m.commandRunsGhPrMerge(c), false, c);
    }
  });
});

describe('round-10: redirections glued to words are opaque (AISDLC-605)', () => {
  const mg = ['mer', 'ge'].join('');
  const gh = ['g', 'h'].join('');
  const glued = [
    `${gh}>/dev/null pr ${mg} 42`,
    `${gh}>&2 pr ${mg} 42`,
    `${gh}&>/dev/null pr ${mg} 42`,
    `${gh}</dev/null pr ${mg} 42`,
    `${gh} pr>/dev/null ${mg} 42`,
    `${gh} -R o/r pr ${mg}</dev/null 42`,
    `${gh} 2>/dev/null pr ${mg} 42`,
    `${gh} pr ${mg} 42>/dev/null`,
    `${gh}<<<x pr ${mg} 42`,
    `${gh}<(true) pr ${mg} 42`,
  ];
  it('refuses every glued spelling', () => {
    for (const c of glued) assert.equal(m.commandRunsGhPrMerge(c), true, c);
  });
  it('splits gh tokens on redirection characters', () => {
    assert.equal(m.commandRunsGhPrMerge(`${gh}>/dev/null pr ${mg}`), true);
    assert.equal(m.isOpaqueSegment(`${gh}>/dev/null pr view 5`), true);
  });
  it('keeps ordinary redirections non-opaque and allowed', () => {
    for (const c of [
      `${gh} pr view 5 > out.txt`,
      `${gh} pr view 5 2>&1`,
      `${gh} pr view 5 --json mergeStateStatus,mergeable`,
      `echo hi > f`,
      `${gh} pr list --search "is:open" >out.txt`,
    ]) {
      assert.equal(m.commandRunsGhPrMerge(c), false, c);
    }
    // `>` and `&` are opaque by grammar; with no merge phrase mentioned the command stays allowed.
    assert.equal(m.isOpaqueSegment('echo hi > f'), true);
    assert.equal(m.isOpaqueSegment('cmd 2>&1'), true);
  });
});

describe('round-11: every glued shell metacharacter is a word boundary and opaque (AISDLC-605)', () => {
  const mg = ['mer', 'ge'].join('');
  const gh = ['g', 'h'].join('');
  const refused = [
    `case a in a)${gh} -R o/r pr ${mg} --squash 42;; esac`,
    `(${gh} -R o/r pr --squash 42 ${mg})`,
    `case a in a)${gh} -b x pr ${mg} 42;; esac`,
    `(${gh} -R o/r pr ${mg} --squash 42)`,
    `{ ${gh} -b x pr ${mg} 42;}`,
    `a|${gh} -b x pr ${mg} 42`,
    `x;${gh} -b x pr ${mg} 42`,
    `${gh} -b x pr ${mg} 42;`,
    `echo a&&${gh} -b x pr ${mg} 42`,
    `echo x|${gh} pr ${mg} 42`,
    `!${gh} pr ${mg} 42`,
    `${gh} pr ${mg})42`,
    `${gh}<<<x pr ${mg} 42`,
    `${gh}<(true) pr ${mg} 42`,
  ];
  it('refuses every glued-metacharacter spelling', () => {
    for (const c of refused) assert.equal(m.commandRunsGhPrMerge(c), true, c);
  });
  it('marks glued metacharacters and every group or redirection character opaque', () => {
    assert.equal(m.isOpaqueSegment('echo a)b'), true);
    assert.equal(m.isOpaqueSegment('echo 42)'), true);
    assert.equal(m.isOpaqueSegment('x;y'), true);
    assert.equal(m.isOpaqueSegment('(echo hi'), true);
    assert.equal(m.isOpaqueSegment('{ echo hi'), true);
    assert.equal(m.isOpaqueSegment('!echo hi'), true);
    assert.equal(m.isOpaqueSegment('cmd 2>&1'), true);
    assert.equal(m.isOpaqueSegment('echo hi > f'), true);
    assert.equal(m.isOpaqueSegment('echo hi'), false);
  });
  it('keeps the earlier allow-cases allowed', () => {
    for (const c of [
      `${gh} pr view 5 --json ${mg}StateStatus,${mg}able`,
      `${gh} -R o/r pr view 5`,
      `${gh} pr list --repo o/r`,
      `${gh} pr list --search "is:open"`,
      `${gh} alias list`,
      `${gh} pr view 5 > out.txt`,
      `echo hi > f`,
      `cmd 2>&1`,
      `git commit -m "fix: pr ${mg} (hook)"`,
    ]) {
      assert.equal(m.commandRunsGhPrMerge(c), false, c);
    }
  });
});

const grammarRefused = (gh, mg) => {
  const phrase = `${gh} pr ${mg} 42`;
  const GHP = `/opt/homebrew/bin/g[h]`;
  return [
    // flags between gh / pr / merge
    `${gh} -R o/r pr ${mg} 42`,
    `${gh} --repo o/r pr ${mg} 42`,
    `${gh} --repo=o/r pr ${mg} 42`,
    `${gh} -b x pr ${mg} 42`,
    `${gh} -t x pr ${mg} 42`,
    `${gh} pr -R o/r ${mg} 42`,
    `${gh} pr -F x ${mg} 5`,
    // alias set / import
    `${gh} alias set mm 'pr ${mg}'`,
    `${gh} alias import aliases.yml`,
    // ANSI-C / locale quoting, backslash-newline
    `${gh} pr $'${mg}' 42`,
    `${gh} pr $"${mg}" 42`,
    `echo $'\\''; ${phrase} #'`,
    `${gh} pr mer\\\nge 42`,
    // brace forms
    `{${gh},pr} ${mg} 42`,
    `${gh} {pr,${mg}} 42`,
    `{${gh},pr,${mg}} 42`,
    `${gh} pr {${mg},} 42`,
    `${gh} pr mer{g..g}e 42`,
    // IFS forms
    `${gh}\${IFS}pr\${IFS}${mg} 42`,
    `${gh} pr\${IFS}${mg} 42`,
    // substitutions, assignments, globs
    `${gh} pr $(echo ${mg}) 5`,
    `A=${mg}; ${gh} pr $A 5`,
    `X=1 ${phrase}`,
    `${GHP} pr ${mg} 42`,
    `g[h] pr ${mg} 42`,
    `$(echo ${gh}) pr ${mg} 42`,
    `${gh} pr ${mg.slice(0, 4)}$(:)${mg.slice(4)} 42`,
    `${gh} pr ${mg.slice(0, 4)}\`\`${mg.slice(4)} 42`,
    `${gh} pr \`echo ${mg}\` 5`,
    `${gh} pr ${mg.slice(0, 4)}\${u}${mg.slice(4)} 42`,
    `touch ${mg}; ${gh} pr m?rge 5`,
    // wrapped gh
    `nice -n 10 ${gh} -b x pr ${mg} 42`,
    `env -u HOME ${gh} -b x pr ${mg} 42`,
    `sudo -u me ${gh} -b x pr ${mg} 42`,
    `exec -a n ${gh} -b x pr ${mg} 42`,
    `command -p ${phrase}`,
    `timeout 60 ${phrase}`,
    `/usr/bin/${gh} -b x pr ${mg} 42`,
    // glued redirections
    `${gh}>/dev/null pr ${mg} 42`,
    `${gh}>&2 pr ${mg} 42`,
    `${gh}&>/dev/null pr ${mg} 42`,
    `${gh}</dev/null pr ${mg} 42`,
    `${gh} pr>/dev/null ${mg} 42`,
    `${gh} -R o/r pr ${mg}</dev/null 42`,
    `${gh}<<<x pr ${mg} 42`,
    `${gh}<(true) pr ${mg} 42`,
    // glued parens, groups, case arms
    `case a in a)${gh} -R o/r pr ${mg} --squash 42;; esac`,
    `(${gh} -R o/r pr --squash 42 ${mg})`,
    `{ ${phrase}; }`,
    `! ${phrase}`,
    `(FOO=1 ${phrase})`,
    `if true; then FOO=1 ${phrase}; fi`,
    // comment desync
    `${gh} pr \`true #\` ${mg} 42`,
    `${gh} pr \${x:+ #} ${mg} 42`,
    `${gh} pr $(true #) ${mg} 42`,
    // heredocs and arithmetic brackets
    `cat <<EOF\n${phrase}\nEOF`,
    `cat <<'EOF' | sh\n${phrase}\nEOF`,
    `echo hi \\\n<<EOF\n${phrase}\nEOF`,
    `echo $[1<<2]\n${phrase}`,
    `echo x \\>& ${phrase}`,
  ];
};

// AISDLC-605 round 12: renamed binaries, escape-decoded opaque mentions, read-only API fields.
const escapeRefused = (gh, mg) => {
  const mut = [mg, 'Pull', 'Request'].join('');
  const arm = ['enablePull', 'RequestAuto', 'Merge'].join('');
  const pct = '%6D' + 'erge';
  const u = '\\u006d' + 'erge';
  return [
    `ln -s /opt/homebrew/bin/${gh} /tmp/g && /tmp/g pr ${mg} 5`,
    `cp /usr/bin/${gh} ./x; ./x pr ${mg} 5`,
    `${gh} api -X PUT repos/o/r/pulls/5/${pct} 2>&1`,
    `printf '%s' '{"query":"mutation{${mut}(input:{pullRequestId:\\"PR_x\\"}){clientMutationId}}"}' | ${gh} api graphql --input -`,
    `printf '%s' '{"query":"mutation{${arm}(input:{pullRequestId:\\"PR_x\\"}){clientMutationId}}"}' | ${gh} api graphql --input -`,
    `printf '%s' '{"query":"mutation{${u}PullRequest(input:{})}"}' | ${gh} api graphql --input -`,
    `printf '%s' "$Q" | ${gh} api graphql --input -`,
    `${gh} api graphql -F query=@q.graphql 2>&1`,
    `${gh} api repos/o/r/pulls/5/${u} -X PUT 2>&1`,
  ];
};

const escapeAllowed = (gh, mg) => [
  `${gh} api repos/o/r/pulls/5 --jq .${mg}able 2>&1`,
  `${gh} api repos/o/r/pulls/5 2>&1 | jq .${mg}StateStatus`,
  `${gh} api repos/o/r/pulls/5/${mg}_commit_sha 2>&1`,
  `echo "${gh} pr ${mg} 5"`,
  `git commit -m "docs about pr ${mg}"`,
  `grep -r "pr ${mg}" .`,
  'git log --oneline -5',
  `${gh} pr view 5 --json ${mg}StateStatus,${mg}able`,
];

const grammarAllowed = (gh, mg) => [
  `${gh} pr view 5 --json ${mg}StateStatus,${mg}able`,
  `${gh} -R o/r pr view 5`,
  `${gh} pr list --repo o/r`,
  `${gh} pr list --search "is:open"`,
  `${gh} alias list`,
  `echo "some prose"`,
  `git commit -m "fix thing"`,
  `git log --oneline -5`,
  `ls -la`,
  `pnpm test`,
  `node --test ai-sdlc-plugin/hooks/x.test.mjs`,
  `echo "${gh} pr ${mg} is forbidden"; ls -la | wc -l`,
];

// Planner grammar ruling (AISDLC-605): every reviewer bypass shape from rounds 3-11, refused
// at matcher level. Over-blocking of opaque commands that mention the phrase is tracked by
// AISDLC-605.1 (a real tokenizer).
describe('positive plain-segment grammar (AISDLC-605)', () => {
  const mg = ['mer', 'ge'].join('');
  const gh = ['g', 'h'].join('');

  it('classifies plain vs opaque segments', () => {
    for (const c of [
      'echo "some prose"',
      "git commit -m 'fix thing'",
      'git log --oneline -5',
      'X=1 cmd',
      'a@b.c:1,2%3+4=5',
      '',
    ]) {
      assert.equal(m.isPlainSegment(c), true, c);
    }
    for (const c of [
      'echo $x',
      'echo `x`',
      'echo (x)',
      'echo {x}',
      'echo x > f',
      'echo x | y',
      'echo x & y',
      'echo x ; y',
      'echo x # c',
      'echo a\\b',
      'echo a\\\nb',
      'echo me"rge"',
      "echo a'b'",
      'echo "unbalanced',
      'echo "a$b"',
      'echo "a\\b"',
      "echo 'a`b'",
      'echo café',
      'echo "café"',
      'echo a\rb',
      'echo *.js',
      'echo ~',
      'echo a!b',
    ]) {
      assert.equal(m.isPlainSegment(c), false, JSON.stringify(c));
    }
  });

  it('refuses every reviewer bypass shape', () => {
    for (const c of grammarRefused(gh, mg)) assert.equal(m.commandRunsGhPrMerge(c), true, c);
  });

  it('refuses spliced API merge paths and mutations when any segment is opaque', () => {
    for (const c of [
      `${gh} api -X PUT repos/o/r/pulls/5/mer$(:)ge`,
      `${gh} api -X PUT repos/o/r/pulls/5/mer{g..g}e`,
      `${gh} api -X PUT repos/$R/pulls/5/${mg}`,
      `${gh} api graphql -f query=$Q enablePullRequest${['Auto', 'Merge'].join('')}`,
    ]) {
      assert.equal(
        m.commandHasUninertMatch(c, () => false, m.mentionsApiMerge),
        true,
        c,
      );
    }
  });

  it('keeps the pinned allow cases allowed', () => {
    for (const c of grammarAllowed(gh, mg)) assert.equal(m.commandRunsGhPrMerge(c), false, c);
  });

  it('allows spaced pipes, && and ; between plain non-merge segments', () => {
    for (const c of ['ls -la | wc -l', 'pnpm build && pnpm test', 'git status ; git log -1']) {
      assert.equal(m.commandRunsGhPrMerge(c), false, c);
    }
    assert.equal(m.commandRunsGhPrMerge(`ls -la && ${gh} pr ${mg} 5`), true);
    assert.equal(m.commandRunsGhPrMerge(`ls -la | ${gh} pr ${mg} 5`), true);
  });

  it('refuses any opaque segment next to a command that mentions the phrase', () => {
    assert.equal(m.commandRunsGhPrMerge(`echo $HOME; echo "${gh} pr ${mg}"`), true);
    assert.equal(m.commandRunsGhPrMerge(`echo $HOME; echo "no phrase"`), false);
  });
  it('refuses renamed binaries and escape-decoded opaque mentions (round 12)', () => {
    for (const c of escapeRefused(gh, mg)) {
      const hit =
        m.commandRunsGhPrMerge(c) || m.commandHasUninertMatch(c, () => false, m.mentionsApiMerge);
      assert.equal(hit, true, c);
    }
  });

  it('allows read-only API fields and inert prose (round 12)', () => {
    for (const c of escapeAllowed(gh, mg)) {
      assert.equal(m.commandRunsGhPrMerge(c), false, c);
      assert.equal(
        m.commandHasUninertMatch(c, () => false, m.mentionsApiMerge),
        false,
        c,
      );
    }
  });
});

describe('REST path normalisation and ANSI-quote anchoring (round 13)', () => {
  const mg = ['mer', 'ge'].join('');
  const gh = ['g', 'h'].join('');
  const hit = (c) =>
    m.commandRunsGhPrMerge(c) || m.commandHasUninertMatch(c, () => false, m.mentionsApiMerge);

  it('refuses dot-segment, double-slash and non-word endings of the path', () => {
    const base = 'https://api.github.com/repos/o/r/pulls';
    for (const c of [
      `curl -X PUT ${base}/5/./${mg}`,
      `curl -X PUT ${base}/5/../5/${mg}`,
      `${gh} api repos/o/r/pulls/5/./${mg} -X PUT`,
      `${gh} api repos/o/r/pulls/5//${mg} -X PUT`,
      `curl -X PUT ${base}/5/${mg}.json`,
      `curl -X PUT ${base}/5/${mg}/`,
      `curl -X PUT ${base}/5/${mg}?x=1`,
      `curl -X PUT ${base}/5/${mg}#x`,
    ]) {
      assert.equal(m.mentionsApiMerge(c), true, c);
    }
  });
  it('allows mergeable reads', () => {
    for (const c of [
      'curl https://api.github.com/repos/o/r/pulls/5/mergeable',
      `${gh} api repos/o/r/pulls/5 --jq .mergeable 2>&1`,
    ]) {
      assert.equal(hit(c), false, c);
    }
  });
  it('normalizePathDots reaches a fixpoint', () => {
    assert.equal(m.normalizePathDots('a//b/./c/d/../e'), 'a/b/c/e');
    assert.equal(m.normalizePathDots('a/b/c/../../d'), 'a/d');
  });
  it('does not treat an end anchor inside quotes as an ANSI quote', () => {
    for (const c of [
      `${gh} pr view 5 2>&1 | grep -v "^$"`,
      `${gh} pr checks 5 2>&1 | grep -c "pass$"`,
      `${gh} pr checks 5 2>&1 | grep -E "fail|pending$"`,
      `${gh} pr view 5 --json comments --jq '.comments[-1].body' 2>&1 | grep -v "^$"`,
    ]) {
      assert.equal(hit(c), false, c);
    }
  });
  it('still refuses ANSI-C and locale quoting that starts a word', () => {
    for (const c of [`${gh} pr $'\\x6derge' 5`, `${gh} pr $"${mg}" 5`]) {
      assert.equal(hit(c), true, c);
    }
  });
});

describe('command runners reassemble split merge phrases (AISDLC-605)', () => {
  const mg = 'mer' + 'ge';
  const refusedPr = [
    `echo ${mg} 5 --squash | xargs gh pr`,
    `printf '%s\\n' ${mg} | xargs gh pr`,
    `echo ${mg} | xargs gh pr X 5`,
    `echo pr | xargs -I X gh X ${mg} 5`,
    `echo pr ${mg} 5 | sh`,
    `echo ${mg} | parallel gh pr {} 5`,
    `echo ${mg} | xargs -I X gh pr X 5 --squash`,
  ];
  const allowed = [
    'git log --oneline -5',
    'ls -la',
    'pnpm test',
    'node --test ai-sdlc-plugin/hooks/x.test.mjs',
    `echo "gh pr ${mg} 5"`,
    `git commit -m "docs about pr ${mg}"`,
    `grep -r "pr ${mg}" .`,
    'gh pr view 5 --json mergeStateStatus,mergeable',
    'gh api repos/o/r/pulls/5 --jq .mergeable',
    "find . -name '*.md'",
  ];
  it('refuses split pr-merge phrases', () => {
    for (const c of refusedPr) assert.equal(m.commandRunsGhPrMerge(c), true, c);
  });
  it('refuses split REST merge path', () => {
    const none = () => false;
    for (const c of [`echo ${mg} | xargs -I X gh api -X PUT repos/o/r/pulls/5/X`])
      assert.equal(m.commandHasUninertMatch(c, none, m.mentionsApiMerge), true, c);
  });
  it('keeps allow cases allowed', () => {
    const none = () => false;
    for (const c of allowed) {
      assert.equal(m.commandRunsGhPrMerge(c), false, c);
      assert.equal(m.commandHasUninertMatch(c, none, m.mentionsApiMerge), false, c);
    }
  });
});
