/**
 * Minimal YAML syntax tokenizer for the config browser
 * (RFC-0023 §9 / AISDLC-178.5 AC#5).
 *
 * Generates a per-line token list the Ink renderer maps to colored Text
 * spans. We deliberately stick to a small ruleset (key, scalar, comment,
 * delimiter) instead of pulling in a full highlighter — Ink's rendering
 * cost scales linearly with span count and the file sizes in `.ai-sdlc/`
 * are small (KB range).
 */

export type TokenKind = 'key' | 'value' | 'comment' | 'punct' | 'plain' | 'string' | 'number';

export interface Token {
  text: string;
  kind: TokenKind;
}

export interface HighlightedLine {
  /** 1-based line number for display. */
  lineNumber: number;
  /** Token spans rendered left-to-right. */
  tokens: Token[];
}

const COMMENT_RE = /(\s*#.*$)/;
const KEY_RE = /^(\s*-?\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)(\s*)(.*)$/;
const QUOTED_RE = /^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/;
const NUMBER_RE = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

/** Tokenize one YAML line. */
export function tokenizeYamlLine(line: string): Token[] {
  const tokens: Token[] = [];

  // Split off trailing comment first (#... but not inside a quoted string).
  let body = line;
  let comment: string | null = null;
  const cmtIdx = findCommentStart(line);
  if (cmtIdx !== -1) {
    body = line.slice(0, cmtIdx);
    comment = line.slice(cmtIdx);
  }

  // Recognize "<indent>(- )?key: value" style; otherwise emit as plain.
  const keyMatch = KEY_RE.exec(body);
  if (keyMatch) {
    const [, lead, key, colon, ws, rest] = keyMatch;
    if (lead) tokens.push({ text: lead, kind: 'plain' });
    tokens.push({ text: key, kind: 'key' });
    tokens.push({ text: colon, kind: 'punct' });
    if (ws) tokens.push({ text: ws, kind: 'plain' });
    if (rest) tokens.push(...tokenizeValue(rest));
  } else if (body.length > 0) {
    tokens.push(...tokenizeValue(body));
  }

  if (comment !== null) tokens.push({ text: comment, kind: 'comment' });
  return tokens;
}

function tokenizeValue(value: string): Token[] {
  const tokens: Token[] = [];
  let rest = value;

  while (rest.length > 0) {
    const quoted = QUOTED_RE.exec(rest);
    if (quoted) {
      tokens.push({ text: quoted[1], kind: 'string' });
      rest = rest.slice(quoted[1].length);
      continue;
    }
    const num = NUMBER_RE.exec(rest);
    if (num && /^[\d.eE+-]/.test(rest)) {
      tokens.push({ text: num[1], kind: 'number' });
      rest = rest.slice(num[1].length);
      continue;
    }
    // Bool-ish keywords (boolean / null) treated as values for color.
    if (/^(true|false|null|yes|no|on|off)\b/i.test(rest)) {
      const m = /^(true|false|null|yes|no|on|off)/i.exec(rest)!;
      tokens.push({ text: m[1], kind: 'value' });
      rest = rest.slice(m[1].length);
      continue;
    }
    // Otherwise consume to next whitespace boundary as a value.
    const m = /^\S+/.exec(rest);
    if (m) {
      tokens.push({ text: m[0], kind: 'value' });
      rest = rest.slice(m[0].length);
      continue;
    }
    // Whitespace.
    const ws = /^\s+/.exec(rest);
    if (ws) {
      tokens.push({ text: ws[0], kind: 'plain' });
      rest = rest.slice(ws[0].length);
      continue;
    }
    // Should not happen, but a single-char fallthrough avoids a hang.
    tokens.push({ text: rest[0], kind: 'plain' });
    rest = rest.slice(1);
  }

  return tokens;
}

/**
 * Find the index of an unquoted `#` (start of comment), ignoring `#` chars
 * inside quoted strings.
 */
function findCommentStart(line: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && (inSingle || inDouble)) {
      i += 1; // skip escaped char
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === '#' && !inSingle && !inDouble) {
      // Must be at start-of-line or preceded by whitespace.
      if (i === 0 || /\s/.test(line[i - 1])) return i;
    }
  }
  // Use the function so the linter accepts it as referenced.
  void COMMENT_RE;
  return -1;
}

/** Tokenize the entire file. */
export function highlightYaml(text: string): HighlightedLine[] {
  return text.split('\n').map((line, idx) => ({
    lineNumber: idx + 1,
    tokens: tokenizeYamlLine(line),
  }));
}
