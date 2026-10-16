/**
 * Shell-text matcher for merge governance (AISDLC-605), FAIL-CLOSED design.
 *
 * Used by the PreToolUse hook (`enforce-blocked-actions.js`) for both the raw
 * merge phrase and the merge-API checks so they cannot drift.
 *
 * Contract (positive grammar, planner ruling on AISDLC-605): a command is split into
 * segments, and a segment is PLAIN only when it is entirely whitespace-separated words
 * of a strict bare character set or single balanced quoted strings (see isPlainSegment).
 * The precise matcher (gh word scan, inert allowlist, pipe-stage tracking) runs ONLY on
 * plain segments: a plain segment holding dangerous text (the raw merge phrase, a merge
 * API path or mutation) is DENIED unless its effective command word is on a short
 * POSITIVE allowlist of inert commands (echo, grep, cat, git commit, ...) AND every
 * later stage of its pipeline is inert too. Any OPAQUE segment (every other character or
 * construct: `$`, backtick, parens, braces, redirections, `#`, backslash, ...) cannot be
 * judged, so the whole command is refused whenever its raw text mentions a merge phrase.
 * A tokenizer pass (canonicalizeCommand, AISDLC-605.1) runs first: it normalises ANSI-C
 * quotes, comments, IFS, backslash-newline, brace lists, literal assignments and redirections,
 * so harmless commands that merely contain those constructs are no longer opaque.
 * Heredocs get no special treatment (DEC-0085): every line of the command text,
 * heredoc bodies included, is matched, so a command containing a heredoc that
 * quotes the merge phrase is refused. Stripping "inert" bodies kept spawning
 * bypasses where this matcher and bash disagreed on where a body starts.
 * Best-effort text matching, not a sandbox: branch protection is the backstop.
 *
 * URL globbing: curl expands `[x-y]` ranges / lists and `{a,b}` in URLs, so normalizeExpansions
 * also yields `[...]`-removed and `[...]`-expanded variants, and an HTTP client given a `pulls`
 * URL with a `[` is refused outright (httpClientGlobsPulls). Tools with other URL-expansion
 * syntaxes we do not know are out of text-matching scope; branch protection is the backstop.
 *
 * Accepted limits (out of text-matching scope; branch protection and
 * cli-merge-if-eligible are the backstop): variables assembled from parts
 * (`a=mer b=ge; gh pr $a$b 5` mentions no phrase; command-substitution splices such as
 * `gh pr $(echo mer)ge 5` are in the same class), and two-step store-then-run (write the phrase to a script file, then run it).
 * Store-then-run through tee / git commit writers followed by sh in the same call is also
 * accepted for now (tracked under AISDLC-605.1, minor).
 *
 * Command runners (xargs, sh, env, find -exec, node, ...) can reassemble a phrase that is
 * split across plain segments (`echo merge 5 | xargs gh pr`): when ANY segment's command word
 * is a runner, the whole-command mention tests run even if every segment is plain.
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
      if (c === '\\' && (quote === '"' || quote === "$'") && i + 1 < command.length) {
        cur += command[++i];
      } else if (c === (quote === "$'" ? "'" : quote)) {
        quote = null;
      }
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      cur += c + command[++i];
      continue;
    }
    if (c === '$' && command[i + 1] === '$') {
      cur += c + command[++i]; // `$$` is the PID, not the start of `$'...'`
      continue;
    }
    if (c === '$' && command[i + 1] === "'") {
      quote = "$'";
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
      if (c === '\\' && (quote === '"' || quote === "$'")) i++;
      else if (c === (quote === "$'" ? "'" : quote)) quote = null;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '$' && segment[i + 1] === '$') {
      i++; // `$$` is the PID
      continue;
    }
    if (c === '$' && segment[i + 1] === "'") {
      quote = "$'";
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === '#' && (i === 0 || IS_WS(segment[i - 1]))) {
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
  // getopt_long / clap accept unambiguous long-option PREFIXES, so every check below matches
  // the prefix (`--comp`, `--c`, `--pre`, `--host`), not just the full option name.
  // rg: --pre and --hostname-bin run a program.
  if (word === 'rg') return !t.some((x) => /^--(pr|ho)/i.test(x));
  // sort: --compress-program runs a program on the spilled chunks (sh would run piped text).
  if (word === 'sort') return !t.some((x) => /^--c/i.test(x));
  // less/more: a `+cmd` argument runs a command; -k / --lesskey* load key bindings with exec.
  if (word === 'less' || word === 'more') {
    return !t.slice(1).some((x) => /^\+/.test(x) || /^-[^-]*k/.test(x) || /^--l/i.test(x));
  }
  if (INERT_WORDS.has(word)) return true;
  const rest = t.slice(1).map((x) => x.toLowerCase());
  if (word === 'git') {
    // `git -c alias.x=!cmd x` can run a command: only direct subcommands (or -C <dir>) are inert.
    const i = rest[0] === '-c' ? -1 : rest[0] === '-C' ? 1 : 0;
    if (rest.some((x) => /^--(ext|textc)/.test(x))) return false;
    return i >= 0 && INERT_GIT.has(rest[i] || '');
  }
  if (word === 'gh') {
    return (rest[0] === 'pr' || rest[0] === 'issue') && INERT_GH.has(rest[1] || '');
  }
  return false;
}

const IS_WS = (c) => c === ' ' || c === '\t' || c === '\n';
const BARE_CHAR = /^[A-Za-z0-9_./=:@+,%-]$/;

/**
 * Positive plain-segment grammar (AISDLC-605, planner ruling). A segment is PLAIN only
 * when it is made entirely of whitespace-separated words, each word being EITHER bare
 * ASCII characters from the strict set `[A-Za-z0-9_./=:@+,%-]` OR exactly one balanced
 * single- or double-quoted string whose content is ASCII with no `$`, backtick or
 * backslash (and no bare characters glued to the quotes). Anything else (any other
 * metacharacter, an unbalanced or glued quote, a non-ASCII or control character, a
 * backslash-newline) makes the WHOLE segment OPAQUE: the precise matcher never trusts
 * an opaque segment, it is refused whenever the command mentions a merge phrase.
 */
function isPlainSegment(segment) {
  const n = segment.length;
  let i = 0;
  while (i < n) {
    const c = segment[i];
    if (IS_WS(c)) {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = segment.indexOf(c, i + 1);
      if (end < 0) return false;
      const body = segment.slice(i + 1, end);
      if (!/^[\t\n\x20-\x7e]*$/.test(body) || /[$`\\]/.test(body)) return false;
      i = end + 1;
      if (i < n && !IS_WS(segment[i])) return false;
      continue;
    }
    while (i < n && !IS_WS(segment[i])) {
      if (!BARE_CHAR.test(segment[i])) return false;
      i++;
    }
  }
  return true;
}

function isOpaqueSegment(segment) {
  return !isPlainSegment(segment);
}

/** True when any segment of the command is opaque (see isPlainSegment). */
function commandIsOpaque(command, segs = splitShellSegmentsEx(command)) {
  return segs.some((s) => isOpaqueSegment(s.text));
}

/** Removes balanced `$(...)` / `<(...)` / `>(...)` substitutions (nested) from text. */
function stripParenSubstitutions(text) {
  let out = text;
  for (let i = 0; i < 64; i++) {
    const next = out.replace(/[$<>]\([^()]*\)/g, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Brace-expansion variants of a text (`{a,b}`, single-char `{x..y}`), capped. */
function expandBraces(text, budget = { n: 64 }) {
  const m = /\{([^{}]*)\}/.exec(text);
  if (!m || budget.n <= 0) return [text];
  const body = m[1];
  let alts = null;
  const seq = /^(.)\.\.(.)$/.exec(body);
  if (seq) {
    const a = seq[1].charCodeAt(0);
    const b = seq[2].charCodeAt(0);
    alts = [];
    for (let c = Math.min(a, b); c <= Math.max(a, b) && alts.length < 32; c++)
      alts.push(String.fromCharCode(c));
  } else if (body.includes(',')) alts = body.split(',');
  const pre = text.slice(0, m.index);
  const post = text.slice(m.index + m[0].length);
  if (!alts) return expandBraces(pre + '\u0001' + body + '\u0002' + post, budget).map(unmark);
  const out = [];
  for (const a of alts) {
    budget.n--;
    out.push(...expandBraces(pre + a + post, budget));
    if (budget.n <= 0) break;
  }
  return out;
}
const unmark = (t) => t.replace(/\u0001/g, '{').replace(/\u0002/g, '}');

const ANSI_SIMPLE = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  '"': '"',
  '?': '?',
};

/**
 * Decodes the body of an ANSI-C `$'...'` string. Returns null (caller keeps the raw text,
 * fail closed) when the result holds a NUL (bash truncates there) or an embedded `'`.
 */
function decodeAnsiC(body) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\' || i + 1 >= body.length) {
      out += c;
      continue;
    }
    const d = body[++i];
    let m;
    if (d in ANSI_SIMPLE) out += ANSI_SIMPLE[d];
    else if (d === "'") return null;
    else if (d === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(body.slice(i + 1)))) {
      out += String.fromCharCode(parseInt(m[0], 16));
      i += m[0].length;
    } else if (d === 'u' && (m = /^[0-9a-fA-F]{1,4}/.exec(body.slice(i + 1)))) {
      out += String.fromCharCode(parseInt(m[0], 16));
      i += m[0].length;
    } else if (d === 'U' && (m = /^[0-9a-fA-F]{1,8}/.exec(body.slice(i + 1)))) {
      const cp = parseInt(m[0], 16);
      if (cp > 0x10ffff) return null;
      out += String.fromCodePoint(cp);
      i += m[0].length;
    } else if (/[0-7]/.test(d)) {
      m = /^[0-7]{1,3}/.exec(body.slice(i));
      out += String.fromCharCode(parseInt(m[0], 8) & 0xff);
      i += m[0].length - 1;
    } else if (d === 'c' && i + 1 < body.length) {
      out += String.fromCharCode(body[++i].charCodeAt(0) & 0x1f);
    } else out += '\\' + d;
  }
  if (out.includes('\0') || out.includes("'")) return null;
  return out;
}

/** Literal value of a simple assignment (`A=merge`, `A='x y'`), or null when not literal. */
const LITERAL_ASSIGN =
  /(?:^|[;&|\n])[ \t]*([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:@+,%-]*|'[^'$`\\]*'|"[^"$`\\]*")(?=[ \t]*(?:[;&|\n]|$))/g;

/** Names the shell itself interprets; assigning them is never a plain literal binding. */
const SHELL_SET_NAMES =
  /^(?:IFS|PATH|ENV|CDPATH|SHELLOPTS|BASHOPTS|PS[1-4]|PROMPT_COMMAND|GLOBIGNORE|FIGNORE|HISTFILE|MAIL|MAILPATH|TMPDIR|SHELL|HOME|OPTIND|OPTARG|REPLY|LINENO|RANDOM|SECONDS)$/;

/**
 * Real-tokenizer normalisation (AISDLC-605.1): one quote-aware pass that removes
 * backslash-newlines, decodes ANSI-C `$'...'` strings into plain single-quoted strings and
 * cuts unquoted comments (skipped, fail closed, when the command holds a heredoc, backtick,
 * paren or `${`, where `#` may sit inside a nested construct); then `$IFS`/`${IFS}` become a
 * space and `$NAME`/`${NAME}` of a literal standalone assignment in the same command are
 * substituted. Other expansions are left alone and stay opaque.
 */
function canonicalizeCommand(command) {
  const stripComments = !/<<|[`(]|\$\{/.test(command);
  let out = '';
  let quote = null;
  let escaped = false; // last emitted char came from a backslash escape (`\ ` is not a boundary)
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const wasEscaped = escaped;
    escaped = false;
    if (quote === "'") {
      out += c;
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === '\\' && i + 1 < command.length) {
        if (command[i + 1] === '\n') i++;
        else out += c + command[++i];
        continue;
      }
      if (c === '"') quote = null;
      out += c;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      if (command[i + 1] === '\n') {
        i++;
        escaped = wasEscaped; // a removed continuation must not clear an escaped space before it
      } else {
        out += c + command[++i];
        escaped = true;
      }
      continue;
    }
    if (c === '$' && command[i + 1] === '$') {
      out += '$$'; // `$$` is the PID; a following quote is a plain quote
      i++;
      continue;
    }
    if (c === '$' && command[i + 1] === "'") {
      let j = i + 2;
      while (j < command.length && command[j] !== "'") j += command[j] === '\\' ? 2 : 1;
      if (j < command.length) {
        const decoded = decodeAnsiC(command.slice(i + 2, j));
        out += decoded === null ? command.slice(i, j + 1) : "'" + decoded + "'";
        i = j;
        continue;
      }
    }
    if (c === "'" || c === '"') quote = c;
    else if (
      c === '#' &&
      stripComments &&
      (out === '' || (!wasEscaped && IS_WS(out[out.length - 1])))
    ) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++;
      continue;
    }
    out += c;
  }
  // `$IFS` is a space only while IFS is unassigned; any mention of `IFS` as a bare name
  // (`IFS=merge`, `read IFS`, `declare IFS`) leaves it opaque.
  if (!/(?<!\$|\$\{)\bIFS\b/.test(out)) {
    out = out.replace(/\$\{IFS\}(\$[1-9])?|\$IFS(?![A-Za-z0-9_])(\$[1-9])?/g, ' ');
  }
  // Substitute only an unconditional, never-reassigned literal assignment, and only into
  // text AFTER it; anything else keeps $NAME opaque (fail closed).
  const assigns = [...out.matchAll(LITERAL_ASSIGN)];
  const refRe = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const m of assigns) {
    const name = m[1];
    const delim = m[0].trimStart()[0];
    const before = out.slice(0, m.index);
    // Any other bare mention of the name (`read A`, `for A in`, `printf -v A`, `declare -n`,
    // `A+=`, a second `A=`) may rebind it; only `$A`/`${A}` references are allowed.
    const occurrences =
      out.match(new RegExp('(?<!\\$|\\$\\{)' + name + '(?![A-Za-z0-9_])', 'g')) || [];
    const conditional =
      !(m.index === 0 || delim === ';' || delim === '\n') ||
      /\b(?:if|then|else|elif|while|until|for|case|do|select|function)\b|[{(]|&&|\|\||&|\|/.test(
        before,
      );
    if (occurrences.length !== 1 || conditional) continue;
    // Shell-managed names (word splitting, lookup paths, startup files) change shell
    // behaviour when assigned, so their text is never a faithful stand-in.
    if (SHELL_SET_NAMES.test(name) || /^(?:LC_|BASH_)/.test(name)) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/s, '$2');
    // Only a bare-word value is substituted: a quoted value with spaces or metacharacters
    // would word-split or re-parse differently in place, so it stays opaque (fail closed).
    if (!/^[A-Za-z0-9_./:@+,%-]*$/.test(value)) continue;
    const end = m.index + m[0].length;
    out =
      out.slice(0, end) +
      out.slice(end).replace(refRe, (all, a, b) => ((a || b) === name ? value : all));
  }
  return out;
}

const REDIRECTION = /[0-9]*&?(?:>>?|<)(?![<(>])(?:&(?:[0-9]+-?|-)|[ \t]*[A-Za-z0-9_./=:@+,%-]+)/g;

/**
 * Replaces file-descriptor and file redirections (`> f`, `2>&1`, `&>f`, `< f`) in the
 * UNQUOTED parts of a segment with a space. Process substitution, heredocs and here-strings
 * are not matched and keep the segment opaque. Unbalanced quotes: unchanged.
 */
function stripRedirections(segment) {
  if (!/[<>]/.test(segment)) return segment;
  let out = '';
  let chunk = '';
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      out += c;
      if (c === '\\' && quote === '"' && i + 1 < segment.length) out += segment[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\' && i + 1 < segment.length) {
      chunk += c + segment[++i];
      continue;
    }
    if (c === "'" || c === '"') {
      out += chunk.replace(REDIRECTION, ' ');
      chunk = '';
      quote = c;
      out += c;
      continue;
    }
    chunk += c;
  }
  if (quote) return segment;
  return out + chunk.replace(REDIRECTION, ' ');
}

/**
 * Brace-expanded variants of a canonical command (just the command when nothing expands).
 * The first variant expands each whitespace-delimited word into the space-joined words bash
 * would produce (a brace list of two words becomes two words); the others substitute per alternative.
 */
function braceVariants(canon) {
  if (!canon.includes('{')) return [canon];
  const words = canon
    .split(/(\s+)/)
    .map((w) => (/\$|^\s*$/.test(w) ? w : expandBraces(w).map(unmark).join(' ')))
    .join('');
  const vs = [...new Set([words, ...expandBraces(canon).map(unmark)])];
  return vs.length > 1 ? vs : [canon];
}

/**
 * Normalised copies of a command for the opaque-mention test (AISDLC-605): command,
 * process and backtick substitutions, `${...}`, `$VAR`, quotes, backslashes and
 * backslash-newlines are deleted, and brace constructs are expanded, so spliced
 * spellings (`merg$(:)e`, `mer{g..g}e`) collapse to the word bash would run. Several
 * variants are returned; a mention in any of them counts.
 */
function normalizeExpansions(text) {
  let t = text.replace(/\\\n/g, '');
  t = stripParenSubstitutions(t);
  t = t.replace(/`[^`]*`/g, '').replace(/`/g, '');
  t = t.replace(/\$\{[^}]*\}/g, '').replace(/\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9?!#@*$-]/g, '');
  t = t.replace(/\$(?=['"])/g, '').replace(/['"\\]/g, '');
  const variants = [];
  for (const base of expandBrackets(t)) {
    variants.push(...expandBraces(base).map(unmark));
    // Fallback: drop every brace-ish punctuation character outright.
    variants.push(base.replace(/[{},]|\.\./g, ''));
    variants.push(base);
  }
  return variants;
}

/** Letters of the `pulls/<n>/merge` path; a `[...]` group only matters through these. */
const GLOB_RELEVANT = new Set('mergepuls'.split(''));
const GLOB_VARIANT_CAP = 256;

/**
 * Characters a curl-style `[...]` group (list `[me]` or range `[a-z]`) can expand to, reduced to
 * the letters that can spell the merge path plus one placeholder for "any other character", so a
 * range of any size yields at most six alternatives. Empty / negated groups yield null.
 */
function globGroupAlternatives(body) {
  if (!body || body[0] === '!' || body[0] === '^') return null;
  const alts = new Set();
  let other = false;
  const add = (ch) => {
    if (GLOB_RELEVANT.has(ch.toLowerCase())) alts.add(ch);
    else other = true;
  };
  for (let i = 0; i < body.length; i++) {
    if (body[i + 1] === '-' && i + 2 < body.length) {
      const lo = body.charCodeAt(i);
      const hi = body.charCodeAt(i + 2);
      if (hi - lo > 4096) return null;
      for (let c = Math.min(lo, hi); c <= Math.max(lo, hi); c++) add(String.fromCharCode(c));
      i += 2;
    } else add(body[i]);
  }
  if (other) alts.add('\u0003');
  return [...alts];
}

/**
 * Variants of a text with curl URL-glob `[...]` groups (`pulls/5/[m-m]erge`) removed and
 * expanded. Always includes the text itself and the groups-removed form; expansion variants are
 * capped (past the cap only the removal form is added, and the HTTP-client rule in the hook
 * refuses such commands outright).
 */
function expandBrackets(text) {
  const re = /\[([^[\]]*)\]/g;
  if (!re.test(text)) return [text];
  const out = [text, text.replace(/\[[^[\]]*\]/g, '')];
  const parts = [];
  let last = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    parts.push(text.slice(last, m.index));
    parts.push(globGroupAlternatives(m[1]) || ['']);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  let acc = [''];
  for (let i = 0; i < parts.length; i++) {
    const opts = i % 2 === 0 ? [parts[i]] : parts[i];
    if (acc.length * opts.length > GLOB_VARIANT_CAP) {
      out.capped = true;
      return out;
    }
    acc = acc.flatMap((a) => opts.map((o) => a + o));
  }
  out.push(...acc.map((v) => v.replace(/\u0003/g, 'x')));
  return out;
}

const HTTP_CLIENT_WORDS = new Set([
  'curl',
  'wget',
  'http',
  'https',
  'xh',
  'xhs',
  'httpie',
  'hurl',
  'ab',
  'fetch',
]);

/** Text that targets the GitHub API (host, repos path, or a GHES-style host option). */
const GITHUB_TARGET = /github|\/repos\/|\brepos\b|GH_HOST/i;
/** A curl `{a,b}` / `{1..3}` list (not `${VAR}`, not JSON). */
const BRACE_LIST = /(?<!\$)\{[^{}\s"':]*(?:,|\.\.)[^{}\s"':]*\}/;

/**
 * True when an HTTP client (curl, wget, httpie, ...) is given a URL glob group (`[...]` or a
 * `{a,b}` list) in a command that targets the GitHub API: curl URL globbing can spell the merge
 * endpoint without it appearing in the text (`pu[l-l]ls/5/[m-m]erge`), so such a command is
 * refused whatever the path looks like. Also refused when the bracket expansion exceeds the cap
 * (the matcher cannot enumerate it). Globs in URLs elsewhere (`https://example.com/[1-5].txt`)
 * are fine.
 */
function httpClientGlobsPulls(command) {
  return splitShellSegmentsEx(command).some((s) => {
    if (!HTTP_CLIENT_WORDS.has(commandWord(s.text))) return false;
    const hasBracket = s.text.includes('[');
    if (!hasBracket && !BRACE_LIST.test(s.text)) return false;
    if (GITHUB_TARGET.test(s.text)) return true;
    return hasBracket && expandBrackets(s.text).capped === true;
  });
}

/**
 * Loose mention of the raw merge command: the pr and merge words appear anywhere (gh
 * optional, any order, so `A=merge; gh pr $A 5` counts), or `pr` plus ANSI-C / locale
 * quoting (`$'\x6derge'` hides the word, so the quoting itself counts).
 */
function mentionsGhPrMerge(text) {
  // `pr` is case-sensitive (gh subcommands are), so `$PR/merge` in an API path does not count.
  // The ANSI-C / locale quote must START a word (`gh pr $'\x6derge'`); a `$"` / `$'` that merely
  // follows other text is a regex end anchor inside a quoted string (`grep -v "^$"`).
  return /\bpr\b/.test(text) && (/\bmerge\b/i.test(text) || ANSI_QUOTE_WORD_START.test(text));
}

const ANSI_QUOTE_WORD_START = /(^|[\s;|&(<>])\$['"]/;

/**
 * Collapses `//`, `/./` and `/x/../` path segments to a fixpoint (detection only), so
 * `pulls/5/./merge`, `pulls/5//merge` and `pulls/5/../5/merge` read as `pulls/5/merge`.
 */
function normalizePathDots(text) {
  let prev;
  let out = text;
  do {
    prev = out;
    out = out
      .replace(/\/{2,}/g, '/')
      .replace(/\/\.(?=\/|$)/g, '')
      .replace(/\/[^/\s]+\/\.\.(?=\/|$)/g, '');
  } while (out !== prev);
  return out;
}

/** REST merge path: pulls/<number-or-expansion>/merge, not merge_ / mergeable / mergeStateStatus. */
const API_MERGE_PATH = /pulls\/[^\s/]*\/merge(?![A-Za-z0-9_])/i;

/**
 * Loose mention of the merge API (the REST merge path, the merge / auto-merge mutations,
 * or `graphql` fed from stdin / a file, which can carry either mutation unseen).
 */
function mentionsApiMerge(text) {
  return (
    API_MERGE_PATH.test(text) ||
    API_MERGE_PATH.test(normalizePathDots(text)) ||
    /mergePullRequest|enablePullRequestAutoMerge/i.test(text) ||
    (/graphql/i.test(text) && (/--input\b/.test(text) || /query=@/.test(text)))
  );
}

/** Decodes `%XX`, `\uXXXX` and `\xXX` escapes (JSON / C style, any backslash count) for detection only. */
function decodeEscapes(text) {
  return text
    .replace(/\\+u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\+x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Raw, escape-decoded, normalised and decoded-normalised variants for the mention tests. */
function mentionVariants(command) {
  const bases = [command, decodeEscapes(command)];
  const out = new Set(bases);
  for (const b of bases) {
    for (const v of normalizeExpansions(b)) {
      out.add(v);
      out.add(decodeEscapes(v));
    }
  }
  return [...out];
}

const RUNNER_WORDS = new Set([
  'xargs',
  'parallel',
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'eval',
  'env',
  'nohup',
  'nice',
  'timeout',
  'sudo',
  'doas',
  'exec',
  'command',
  'builtin',
  'time',
  'watch',
  'node',
  'nodejs',
  'deno',
  'bun',
  'python',
  'perl',
  'ruby',
  'php',
  'lua',
  'awk',
  'gawk',
  'busybox',
  'ssh',
  'script',
]);

/** True when any segment's command word is a command-runner (see module header). */
function commandHasRunner(segs) {
  return segs.some((s) => {
    const w = commandWord(s.text);
    if (RUNNER_WORDS.has(w) || /^python[0-9.]+$/.test(w)) return true;
    if (w === 'find')
      return effectiveTokens(s.text).some((t) => /^-(exec|execdir|ok|okdir)$/.test(t));
    return false;
  });
}

/** REST / GraphQL merge pieces that a runner can reassemble from stdin (`pulls/5/X` + `merge`). */
function mentionsApiMergePieces(text) {
  const t = normalizePathDots(text);
  return (
    (/\bmerge\b/i.test(t) && /pulls\//.test(t)) || (/\bmerge\b/i.test(t) && /graphql/i.test(t))
  );
}

/**
 * True when `matches(text)` hits a PLAIN segment that is NOT inert, or an inert plain
 * segment whose pipeline feeds a non-inert later stage. Opaque segments are never
 * judged precisely: if ANY segment is opaque and `mentions(rawCommand)` (or a
 * normalised copy of it) holds, the whole command is refused. Comments get no
 * special trust: `#` is opaque by grammar, so a comment that mentions the phrase
 * over-blocks (tracked by AISDLC-605.1).
 */
/** `gh api graphql` fed from stdin / a file: the mutation is unseen, so a non-inert segment is refused. */
const GRAPHQL_UNSEEN = /graphql/i;

function commandHasUninertMatch(command, matches, mentions) {
  const canonical = canonicalizeCommand(command);
  // Defense in depth: when an ANSI-C / PID quote form is still present and the canonical
  // text is opaque, the tokenizer may have mis-read quote state and cut executed text, so
  // the raw command is mention-checked too.
  if (
    mentions &&
    command !== canonical &&
    /\$\$'|\$'/.test(canonical) &&
    commandIsOpaque(canonical) &&
    mentionVariants(command).some((v) => mentions(v))
  )
    return true;
  return braceVariants(canonical).some((v) => variantHasUninertMatch(v, matches, mentions));
}

function variantHasUninertMatch(command, matches, mentions) {
  const segs = splitShellSegmentsEx(command).map((s) => ({
    ...s,
    text: stripRedirections(s.text),
  }));
  if (mentions && commandIsOpaque(command, segs)) {
    if (mentionVariants(command).some((v) => mentions(v))) return true;
  }
  if (mentions && commandHasRunner(segs)) {
    const apiMode = mentions === mentionsApiMerge;
    // The sanctioned helper's own name contains `merge`; it is not a merge phrase.
    const stripped = command.replace(/cli-merge-if-eligible(\.mjs)?/g, '');
    if (
      mentionVariants(stripped).some((v) => mentions(v) || (apiMode && mentionsApiMergePieces(v)))
    )
      return true;
  }
  for (let i = 0; i < segs.length; i++) {
    if (!isPlainSegment(segs[i].text)) continue;
    const clean = segs[i].text;
    const unseen =
      mentions === mentionsApiMerge &&
      GRAPHQL_UNSEEN.test(clean) &&
      (/--input\b/.test(clean) || /query=@/.test(clean));
    if (
      !unseen &&
      !matches(clean) &&
      !matches(clean.replace(/['"]/g, '')) &&
      !matches(decodeEscapes(clean))
    )
      continue;
    if (!isInertSegment(segs[i].text)) return true;
    for (let j = i + 1; j < segs.length && segs[j].pipe; j++) {
      if (!isInertSegment(segs[j].text)) return true;
    }
  }
  return false;
}

/**
 * Precise check, run on PLAIN segments only. gh's parser skips unknown flags and
 * their values before resolving the subcommand, so guessing which flags take a value
 * is unsound. For EVERY `gh` / `gh.exe` word of the segment, at any position (behind
 * `nice -n 10`, `env -u X`, `sudo -u me`, `exec -a n`, `command -p`, `timeout 60`, or
 * as an absolute path), the word `pr` followed anywhere later by the word `merge` is
 * refused, whatever flags sit between. `gh alias` followed later by `set` / `import`
 * is refused too (an alias can expand to the merge command). Quotes and punctuation bound words.
 * `mergeStateStatus` / `mergeable` are not the word `merge`.
 */
function ghSegmentHasPrBeforeMerge(text) {
  // Quoted content may hold any punctuation (`'alias.m=!<gh> pr ...'`, `"echo;<gh> pr ..."`):
  // every character outside the bare set bounds a word, so gh is found inside quotes too.
  const tokens = text.split(/[^A-Za-z0-9_./=:@+,%-]+/).filter(Boolean);
  const isGh = (t) =>
    t
      .split('/')
      .pop()
      .toLowerCase()
      .replace(/\.exe$/, '') === 'gh';
  for (let g = 0; g < tokens.length; g++) {
    if (!isGh(tokens[g])) continue;
    let seenPr = false;
    let seenAlias = false;
    for (const t of tokens.slice(g + 1)) {
      const w = t.toLowerCase();
      if (seenPr && w === 'merge') return true;
      if (seenAlias && (w === 'set' || w === 'import')) return true;
      if (w === 'pr') seenPr = true;
      if (w === 'alias') seenAlias = true;
    }
  }
  return false;
}

/**
 * Binary-agnostic check on a plain, non-inert segment: the exact tokens `pr` then later
 * `merge` (case-insensitive, quotes and punctuation bound words) are refused whatever word
 * is the program, so a renamed or symlinked gh binary does not escape. Inert prose segments
 * never reach a verdict from this (commandHasUninertMatch trusts them).
 */
function segmentHasPrThenMergeToken(text) {
  const tokens = text.split(/[^A-Za-z0-9_./=:@+,%-]+/).filter(Boolean);
  let seenPr = false;
  for (const t of tokens) {
    const w = t.toLowerCase();
    if (seenPr && w === 'merge') return true;
    if (w === 'pr') seenPr = true;
  }
  return false;
}

/** True when the command runs (or could run) the raw merge command (see module contract). */
function commandRunsGhPrMerge(command) {
  const matches = (text) => ghSegmentHasPrBeforeMerge(text) || segmentHasPrThenMergeToken(text);
  return commandHasUninertMatch(command, matches, mentionsGhPrMerge);
}

module.exports = {
  splitShellSegments,
  splitShellSegmentsEx,
  stripComment,
  stripCommentAndQuotes,
  tokenizeShellish,
  commandWord,
  isInertSegment,
  isPlainSegment,
  isOpaqueSegment,
  commandIsOpaque,
  mentionsApiMerge,
  normalizePathDots,
  decodeEscapes,
  segmentHasPrThenMergeToken,
  normalizeExpansions,
  expandBrackets,
  httpClientGlobsPulls,
  commandHasUninertMatch,
  canonicalizeCommand,
  commandRunsGhPrMerge,
};
