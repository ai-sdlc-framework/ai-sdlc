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

/** True when the segment is a known-inert command (positive allowlist). */
function isInertSegment(segment) {
  if (hasSubstitution(segment)) return false;
  const t = effectiveTokens(segment);
  if (!t.length) return false;
  const word = commandWord(segment);
  if (word === 'rg') return !t.some((x) => /^--pre(=|$)/.test(x));
  if (INERT_WORDS.has(word)) return true;
  const rest = t.slice(1).map((x) => x.toLowerCase());
  if (word === 'git') {
    // `git -c alias.x=!cmd x` can run a command: only direct subcommands (or -C <dir>) are inert.
    const i = rest[0] === '-c' ? -1 : rest[0] === '-C' ? 1 : 0;
    return i >= 0 && INERT_GIT.has(rest[i] || '');
  }
  if (word === 'gh') {
    return (rest[0] === 'pr' || rest[0] === 'issue') && INERT_GH.has(rest[1] || '');
  }
  return false;
}

/** Finds an unquoted `<<MARKER` heredoc opener on a line, or null. */
function findHeredocOpener(line) {
  // Fail closed: arithmetic `$((` may hide `<<` as a shift, so never treat as heredoc.
  if (line.includes('$((')) return null;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
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
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return null;
    if (c === '<' && line[i + 1] === '<') {
      if (line[i + 2] === '<') {
        i += 2; // here-string
        continue;
      }
      const m = line.slice(i).match(/^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
      return m ? { marker: m[2], dashed: line[i + 2] === '-' } : null;
    }
  }
  return null;
}

/**
 * Removes heredoc bodies ONLY where the opener line is made solely of inert
 * commands (`cat <<EOF`, `git commit -F - <<EOF`, `gh pr create --body-file - <<EOF`).
 * Any other opener (shells, interpreters, wrappers, unknown tools) keeps its
 * body so the matcher still sees it.
 */
function stripInertHeredocBodies(command) {
  const lines = command.split('\n');
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const opener = findHeredocOpener(line);
    kept.push(line);
    i++;
    if (!opener) continue;
    const { marker, dashed } = opener;
    const segs = splitShellSegments(line);
    const inert = segs.length > 0 && segs.every(isInertSegment);
    while (i < lines.length) {
      const body = dashed ? lines[i].replace(/^\t+/, '') : lines[i];
      if (!inert) kept.push(lines[i]);
      i++;
      if (body === marker) break;
    }
  }
  return kept.join('\n');
}

/**
 * True when `matches(text)` hits a segment that is NOT inert, or an inert
 * segment whose pipeline feeds a non-inert later stage. The matcher sees the
 * comment-stripped segment both with quotes retained and with quotes removed.
 */
function commandHasUninertMatch(command, matches) {
  const segs = splitShellSegmentsEx(stripInertHeredocBodies(command));
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

function matchesGhPrMerge(text) {
  return GH_PR_MERGE.test(text) || GH_PR_MERGE.test(text.replace(/\\/g, ''));
}

/** True when the command runs (or could run) the raw merge command (see module contract). */
function commandRunsGhPrMerge(command) {
  return commandHasUninertMatch(command, matchesGhPrMerge);
}

module.exports = {
  splitShellSegments,
  splitShellSegmentsEx,
  stripComment,
  stripCommentAndQuotes,
  tokenizeShellish,
  commandWord,
  isInertSegment,
  stripInertHeredocBodies,
  commandHasUninertMatch,
  commandRunsGhPrMerge,
};
