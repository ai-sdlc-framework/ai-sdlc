/**
 * Shell-text matcher for merge governance (AISDLC-605), FAIL-CLOSED design.
 *
 * Used by the PreToolUse hook (`enforce-blocked-actions.js`) for both the raw
 * merge phrase and the merge-API checks so they cannot drift.
 *
 * Contract: when the dangerous text (the raw merge phrase, a merge API path or
 * mutation) appears in a segment, the command is DENIED unless that segment's
 * effective command word is on a short POSITIVE allowlist of inert commands
 * (echo, grep, cat, git commit, ...) AND every later stage of its pipeline is
 * inert too. Anything unknown (shells, interpreters, `env`, `pnpm exec`, `sudo`,
 * `xargs`, substitutions, unclassifiable words) therefore denies.
 * Heredocs get no special treatment (DEC-0085): every line of the command text,
 * heredoc bodies included, is matched, so a command containing a heredoc that
 * quotes the merge phrase is refused. Stripping "inert" bodies kept spawning
 * bypasses where this matcher and bash disagreed on where a body starts.
 * Best-effort text matching, not a sandbox: branch protection is the backstop.
 */

const INERT_WORDS = new Set([
  'echo',
  'printf',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'cat',
  'tee',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'sort',
  'uniq',
  'true',
  'false',
  ':',
]);
const INERT_GIT = new Set(['commit', 'log', 'show', 'diff', 'tag', 'status', 'add']);
const INERT_GH = new Set(['create', 'comment', 'edit', 'view', 'list', 'review', 'checks', 'diff']);
// Reserved words that merely introduce another command (skipped when finding the command word).
const RESERVED = new Set([
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '{',
  '}',
  '(',
  '!',
]);

/**
 * Quote- and escape-aware split on shell control operators (`&&`, `||`, `;`,
 * `|`, `|&`, `&`, newline). Returns `{ text, pipe }` where `pipe` is true when
 * the segment is fed by the previous one through a pipe. Unbalanced quotes fall
 * back to a naive split (fail closed: more, smaller segments).
 */
function splitShellSegmentsEx(command) {
  const out = [];
  let cur = '';
  let gapPipe = false;
  const flush = (isPipe) => {
    const text = cur.trim();
    cur = '';
    if (text) {
      out.push({ text, pipe: out.length > 0 && gapPipe });
      gapPipe = false;
    }
    if (isPipe) gapPipe = true;
  };
  const naive = () => {
    out.length = 0;
    cur = '';
    gapPipe = false;
    for (const part of command.split(/(&&|\|\||;|\||&|\n)/)) {
      if (/^(&&|\|\||;|\||&|\n)$/.test(part)) flush(part === '|');
      else cur = part;
    }
    flush(false);
    return out;
  };
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"' && i + 1 < command.length) {
        cur += command[++i];
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      cur += c + command[++i];
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    // fd redirections (`2>&1`, `>&2`, `<&3`, `&>`, `&>>`) are not control
    // operators; splitting on their `&` would orphan the pipe flag so that the
    // real downstream consumer (`... 2>&1 | sh`) is never checked.
    if (
      c === '&' &&
      command[i + 1] !== '&' &&
      // An escaped `\>` / `\<` is a literal word, not a redirection: stay an operator (fail closed).
      ((cur.endsWith('>') && !cur.endsWith('\\>')) ||
        (cur.endsWith('<') && !cur.endsWith('\\<')) ||
        command[i + 1] === '>')
    ) {
      cur += c;
      continue;
    }
    if (c === '&' || c === '|' || c === ';' || c === '\n') {
      let isPipe = c === '|';
      if ((c === '&' || c === '|') && command[i + 1] === c) {
        i++;
        isPipe = false;
      } else if (c === '|' && command[i + 1] === '&') {
        i++; // `|&`
      }
      flush(isPipe);
      continue;
    }
    cur += c;
  }
  if (quote) return naive();
  flush(false);
  return out;
}

function splitShellSegments(command) {
  return splitShellSegmentsEx(command).map((s) => s.text);
}

/**
 * Cuts an unquoted shell comment: `#` only counts outside quotes AND at
 * start-of-string or after whitespace. An unbalanced quote means no cut (fail closed).
 */
function stripComment(segment) {
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || /\s/.test(segment[i - 1]))) {
      return segment.slice(0, i).trimEnd();
    }
  }
  return segment.trimEnd();
}

/** Removes an unquoted trailing shell comment and all quote characters. */
function stripCommentAndQuotes(segment) {
  return stripComment(segment).replace(/['"]/g, '');
}

/** Whitespace tokens with quotes removed (`gh "pr" merge` becomes gh, pr, merge). */
function tokenizeShellish(segment) {
  return stripCommentAndQuotes(segment).split(/\s+/).filter(Boolean);
}

/**
 * Effective command tokens of a segment: leading `VAR=value` assignments,
 * reserved words (`then`, `do`, `{`, ...), `name()` function headers and
 * grouping characters are skipped.
 */
function effectiveTokens(segment) {
  const tokens = tokenizeShellish(segment);
  let i = 0;
  for (; i < tokens.length; i++) {
    const tok = tokens[i].replace(/^[({!]+/, '');
    if (!tok || RESERVED.has(tok)) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
    if (/^[A-Za-z_][A-Za-z0-9_-]*\(\)$/.test(tok)) continue;
    break;
  }
  return tokens.slice(i).map((t, idx) => (idx === 0 ? t.replace(/^[({!]+/, '') : t));
}

function commandWord(segment) {
  const t = effectiveTokens(segment);
  if (!t.length) return '';
  return t[0]
    .split('/')
    .pop()
    .toLowerCase()
    .replace(/\.exe$/, '');
}

function hasSubstitution(segment) {
  return /\$\(|`|<\(|>\(|\$\{/.test(segment);
}

/**
 * True when a leading `VAR=value` assignment word contains whitespace or a backslash
 * (`GIT_EDITOR='<cmd> #' git commit`, `LESSOPEN='|<cmd> %s' less f`): such a value is a
 * program/option string that the inert command word may run, so the segment is NOT inert.
 */
function leadingAssignmentIsOpaque(segment) {
  let i = 0;
  const n = segment.length;
  for (;;) {
    while (i < n && /\s/.test(segment[i])) i++;
    const start = i;
    let quote = null;
    while (i < n) {
      const c = segment[i];
      if (quote) {
        if (c === '\\' && quote === '"') i++;
        else if (c === quote) quote = null;
      } else if (c === '\\') i++;
      else if (c === "'" || c === '"') quote = c;
      else if (/\s/.test(c)) break;
      i++;
    }
    const word = segment.slice(start, i);
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) return false;
    if (/[\s\\]/.test(word)) return true;
    if (i >= n) return false;
  }
}

/** True when the segment is a known-inert command (positive allowlist). */
function isInertSegment(segment) {
  if (hasSubstitution(segment)) return false;
  if (leadingAssignmentIsOpaque(segment)) return false;
  const t = effectiveTokens(segment);
  if (!t.length) return false;
  const word = commandWord(segment);
  if (word === 'rg') return !t.some((x) => /^--pre(=|$)/.test(x));
  if (word === 'sort') return !t.some((x) => /^--compress-program(=|$)/.test(x));
  if (INERT_WORDS.has(word)) return true;
  const rest = t.slice(1).map((x) => x.toLowerCase());
  if (word === 'git') {
    // `git -c alias.x=!cmd x` can run a command: only direct subcommands (or -C <dir>) are inert.
    const i = rest[0] === '-c' ? -1 : rest[0] === '-C' ? 1 : 0;
    if (rest.some((x) => /^--(ext-diff|textconv)\b/.test(x))) return false;
    return i >= 0 && INERT_GIT.has(rest[i] || '');
  }
  if (word === 'gh') {
    return (rest[0] === 'pr' || rest[0] === 'issue') && INERT_GH.has(rest[1] || '');
  }
  return false;
}

/** Text with quoted and backslash-escaped characters blanked, so structural checks see only live shell syntax. */
function unquotedView(segment) {
  let out = '';
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === '\\' && quote === '"') {
        i++;
        out += 'xx';
      } else if (c === quote) {
        quote = null;
        out += 'x';
      } else out += 'x';
      continue;
    }
    if (c === '\\') {
      i++;
      out += 'xx';
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += 'x';
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * True when the segment holds a construct this tokenizer does not fully understand
 * (AISDLC-605 structural rule): ANSI-C / locale quoting, backslash-newline, brace
 * expansion, IFS, a variable-assignment prefix, a variable / command / process
 * substitution in the command or subcommand slots, or a glob or backslash in the
 * command word. An opaque segment cannot be judged by the precise matcher.
 */
function isOpaqueSegment(segment) {
  if (/\$['"]/.test(segment)) return true;
  if (/\\\n/.test(segment)) return true;
  if (/\bIFS\b/.test(segment)) return true;
  if (/\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/.test(unquotedView(segment))) return true;
  for (const t of tokenizeShellish(segment)) {
    const tok = t.replace(/^[({!]+/, '');
    if (!tok || RESERVED.has(tok)) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) return true;
    break;
  }
  const eff = effectiveTokens(segment);
  if (eff.slice(0, 6).some((t) => /\$|`|<\(|>\(/.test(t))) return true;
  if (eff.length && /[*?[\]\\]/.test(eff[0])) return true;
  return false;
}

/** True when the command text cannot be trusted segment by segment (see isOpaqueSegment). */
function commandIsOpaque(command, segs) {
  if (/\$['"]/.test(command)) return true; // quote/comment state may be desynced
  return segs.some((s) => isOpaqueSegment(s.text));
}

/** Loose mention of the raw merge command: the pr and merge words appear anywhere (gh optional). */
function mentionsGhPrMerge(text) {
  // `pr` is case-sensitive (gh subcommands are), so `$PR/merge` in an API path does not count.
  return /\bpr\b/.test(text) && /\bmerge\b/i.test(text);
}

/** Loose mention of the merge API (pulls path or the merge / auto-merge mutations). */
function mentionsApiMerge(text) {
  return /pulls[\s\S]*merge|mergePullRequest|enablePullRequestAutoMerge/i.test(text);
}

/**
 * True when `matches(text)` hits a segment that is NOT inert, or an inert
 * segment whose pipeline feeds a non-inert later stage. The matcher sees the
 * comment-stripped segment both with quotes retained and with quotes removed.
 * When `mentions` is given and the command is opaque (see isOpaqueSegment) the
 * command is refused whenever `mentions(rawCommand)` holds: deny-everything-that-
 * mentions-it for text the tokenizer cannot fully understand.
 */
function commandHasUninertMatch(command, matches, mentions) {
  const segs = splitShellSegmentsEx(command);
  if (mentions && commandIsOpaque(command, segs) && mentions(command.replace(/\\\n/g, '')))
    return true;
  for (let i = 0; i < segs.length; i++) {
    const clean = stripComment(segs[i].text);
    if (!matches(clean) && !matches(clean.replace(/['"]/g, ''))) continue;
    if (!isInertSegment(segs[i].text)) return true;
    for (let j = i + 1; j < segs.length && segs[j].pipe; j++) {
      if (!isInertSegment(segs[j].text)) return true;
    }
  }
  return false;
}

const GH_PR_MERGE = /\bgh(?:\.exe)?\s+pr\s+merge\b/i;

// gh flags that take a separate value token (`-R owner/repo`, `--hostname host`).
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '-h', '--hostname']);

/** Brace-expansion alternatives of one word (`{merge,}` gives merge and the empty word). */
function wordAlternatives(word) {
  const m = /^(.*?)\{([^{}]*)\}(.*)$/.exec(word);
  if (!m) return [word];
  const alts = m[2].split(',').flatMap((a) => wordAlternatives(m[1] + a + m[3]));
  return alts.length ? alts : [word];
}

/**
 * Token-level check for gh invocations the plain regex misses (AISDLC-605 round 4):
 * global flags between `gh` and `pr` or between `pr` and `merge`, `gh alias set|import`
 * (an alias can expand to the merge command, so it is refused outright), ANSI-C /
 * locale quoting (`$'..'`, `$".."`) after gh, and brace expansion. Fail closed.
 */
function ghTokensRunMerge(text) {
  const tokens = text
    .replace(/['"\\]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const base = tokens[i]
      .replace(/^[({!]+/, '')
      .split('/')
      .pop()
      .toLowerCase()
      .replace(/\.exe$/, '');
    if (base !== 'gh') continue;
    // Drop flags (and the value token of value-taking flags) after gh.
    const words = [];
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.startsWith('-')) {
        if (GH_VALUE_FLAGS.has(t)) j++;
        continue;
      }
      words.push(wordAlternatives(t.toLowerCase()));
      if (words.length >= 4) break;
    }
    const is = (k, w) => !!words[k] && words[k].includes(w);
    // Any later word may be the subcommand: an unlisted value-taking flag (`pr -F x merge`) shifts it.
    if (is(0, 'pr') && [1, 2, 3].some((k) => is(k, 'merge'))) return true;
    if (is(0, 'alias') && (is(1, 'set') || is(1, 'import'))) return true;
  }
  return false;
}

/** True when a gh word is followed (anywhere later in the text) by `$'` or `$"` quoting. */
function ghAnsiQuoted(text) {
  const m = /(^|[\s;&|({!/])gh(?:\.exe)?(?=[\s'"$\\])/i.exec(text);
  return !!m && /\$['"]/.test(text.slice(m.index));
}

function matchesGhPrMerge(text) {
  return (
    GH_PR_MERGE.test(text) ||
    GH_PR_MERGE.test(text.replace(/\\/g, '')) ||
    ghTokensRunMerge(text) ||
    ghAnsiQuoted(text)
  );
}

/** True when the command runs (or could run) the raw merge command (see module contract). */
function commandRunsGhPrMerge(command) {
  return commandHasUninertMatch(command, matchesGhPrMerge, mentionsGhPrMerge);
}

module.exports = {
  splitShellSegments,
  splitShellSegmentsEx,
  stripComment,
  stripCommentAndQuotes,
  tokenizeShellish,
  commandWord,
  isInertSegment,
  isOpaqueSegment,
  commandIsOpaque,
  mentionsApiMerge,
  commandHasUninertMatch,
  commandRunsGhPrMerge,
};
