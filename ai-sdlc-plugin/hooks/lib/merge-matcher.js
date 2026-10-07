/**
 * Shared shell-text matcher for merge governance (AISDLC-605).
 *
 * Both PreToolUse (`enforce-blocked-actions.js`) and PermissionRequest
 * (`permission-check.js`) hooks use this so the two cannot drift.
 *
 * Contract: the merge ban applies only when `gh pr merge` (or a merge API call)
 * is the command BEING RUN, not when the phrase is text inside an argument, a
 * heredoc body, a grep pattern or an echo. Wrappers that execute their text
 * (`sh -c`, `eval`, `xargs`, interpreters, `sudo`/`env` prefixes) and command
 * substitution FAIL CLOSED: the phrase anywhere in such a segment blocks.
 * Best-effort text matching, not a sandbox: branch protection is the backstop.
 */

// Commands that execute (part of) their arguments or stdin as another command.
const EXEC_WRAPPERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'eval',
  'xargs',
  'source',
  '.',
  'exec',
  'env',
  'sudo',
  'doas',
  'su',
  'nohup',
  'time',
  'command',
  'builtin',
  'nice',
  'ionice',
  'timeout',
  'watch',
  'ssh',
  'parallel',
  'find',
  'script',
  'node',
  'nodejs',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
  'awk',
  'gawk',
  'busybox',
  'cmd',
  'powershell',
  'pwsh',
]);

function isWrapperWord(word) {
  // A variable/substitution as the command word (`${SHELL} <<EOF`) cannot be resolved: fail closed.
  return EXEC_WRAPPERS.has(word) || /^python[0-9.]*$/.test(word) || /^[$`]/.test(word);
}

/**
 * Quote- and escape-aware split on shell control operators (`&&`, `||`, `;`,
 * `|`, `&`, newline). Unbalanced quotes fall back to a naive split (fail
 * closed: more, smaller segments).
 */
function splitShellSegments(command) {
  const naive = () =>
    command
      .split(/(?:&&|\|\||;|\||&|\n)/)
      .map((s) => s.trim())
      .filter(Boolean);
  const out = [];
  let cur = '';
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
      if ((c === '&' || c === '|') && command[i + 1] === c) i++;
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (quote) return naive();
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Cuts an unquoted shell comment: `#` only counts at start-of-string or after whitespace. */
function stripComment(segment) {
  return segment.replace(/(^|\s)#.*$/, '$1').trimEnd();
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
 * Command word of a segment: skips leading `VAR=value` assignments and
 * grouping characters, returns the lowercase basename. `''` when none.
 */
function commandWord(segment) {
  const tokens = tokenizeShellish(segment);
  for (let tok of tokens) {
    tok = tok.replace(/^[({!\\]+/, '');
    if (!tok) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
    const base = tok
      .split('/')
      .pop()
      .toLowerCase()
      .replace(/\.exe$/, '');
    return base;
  }
  return '';
}

/**
 * Removes heredoc bodies EXCEPT where the opener line feeds an executing
 * wrapper (`bash <<EOF`, `cat <<EOF | sh`, `xargs`, ...): those bodies stay
 * so the matcher still sees them (fail closed).
 */
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
    const executes = splitShellSegments(line).some((s) => isWrapperWord(commandWord(s)));
    while (i < lines.length) {
      const body = dashed ? lines[i].replace(/^\t+/, '') : lines[i];
      if (executes) kept.push(lines[i]);
      i++;
      if (body === marker) break;
    }
  }
  return kept.join('\n');
}

const GH_PR_MERGE = /\bgh(?:\.exe)?\s+pr\s+merge\b/i;

function hasSubstitution(segment) {
  return /\$\(|`|<\(|>\(/.test(segment);
}

/** True when this segment RUNS `gh pr merge` (see module contract). */
function segmentRunsGhPrMerge(segment) {
  const text = stripCommentAndQuotes(segment);
  if (!GH_PR_MERGE.test(text)) return false;
  if (hasSubstitution(segment)) return true; // $(gh pr merge) runs even inside echo
  const word = commandWord(segment);
  if (word === 'gh') {
    const t = tokenizeShellish(segment).map((x) => x.toLowerCase());
    for (let i = 0; i + 1 < t.length; i++) if (t[i] === 'pr' && t[i + 1] === 'merge') return true;
    return false;
  }
  return isWrapperWord(word);
}

/** True when any segment of the command runs `gh pr merge`. */
function commandRunsGhPrMerge(command) {
  const segments = splitShellSegments(stripInertHeredocBodies(command));
  if (segments.some(segmentRunsGhPrMerge)) return true;
  // `echo 'gh pr merge 5' | sh`: an earlier pipe stage feeds code to a stdin executor.
  return (
    segments.length > 1 &&
    segments.some(segmentConsumesStdinAsCode) &&
    segments.some((s) => GH_PR_MERGE.test(stripCommentAndQuotes(s)))
  );
}

const API_TOOLS = new Set([
  'gh',
  'curl',
  'wget',
  'http',
  'https',
  'xh',
  'httpie',
  'nodejs',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
  'bash',
  'sh',
  'zsh',
  'eval',
  'xargs',
  'env',
  'sudo',
  'exec',
  'nohup',
  'time',
]);

/** True when the command word reads executable text from stdin (so an earlier pipe stage can feed it). */
function segmentConsumesStdinAsCode(segment) {
  return /^(xargs|sh|bash|zsh|dash|ksh|eval|source|\.)$/.test(commandWord(segment));
}

/** True when the segment's command word can send an API request (or wraps something that can). */
function segmentIsApiCapable(segment) {
  if (hasSubstitution(segment)) return true;
  const word = commandWord(segment);
  return API_TOOLS.has(word) || isWrapperWord(word);
}

module.exports = {
  EXEC_WRAPPERS,
  isWrapperWord,
  splitShellSegments,
  stripComment,
  stripCommentAndQuotes,
  tokenizeShellish,
  commandWord,
  stripInertHeredocBodies,
  segmentRunsGhPrMerge,
  commandRunsGhPrMerge,
  segmentIsApiCapable,
  segmentConsumesStdinAsCode,
};
