/**
 * Control-sentence linter (RFC-0053 OQ-4, AISDLC-782).
 *
 * A control-shaped sentence (never, must, refuse, only) is a rule an agent has to
 * obey. A control that depends on retrieval is not a control, so such a sentence
 * may live only in the fixed prefix, in a path-bound `.claude/rules/*.md` file
 * (the harness loads it deterministically), or elsewhere only when it is ALSO
 * rendered from configuration (the fixed prefix text).
 */

const CONTROL_RE = /\b(never|must|refuse[sd]?|only)\b/i;

/** Strip markdown noise so the same sentence compares equal across files. */
function normalizeSentence(s) {
  return s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Drop YAML frontmatter and fenced code blocks. */
function stripNonProse(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/^```[\s\S]*?^```/gm, '');
}

/**
 * Split prose into sentences (bullets, lines and `. ` boundaries) and keep the
 * control-shaped ones, normalized.
 * @param {string} text
 * @returns {string[]}
 */
function findControlSentences(text) {
  const out = [];
  for (const line of stripNonProse(text).split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    // Split on sentence ends; a period inside backticks or a path is not an end.
    for (const part of line.split(/(?<=[.;!?])\s+(?=[A-Z*`])/)) {
      const norm = normalizeSentence(part);
      if (norm && CONTROL_RE.test(norm)) out.push(norm);
    }
  }
  return out;
}

/** True when frontmatter carries a non-empty `paths:` key. */
function hasPathsFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return !!m && /^paths:/m.test(m[1]);
}

/**
 * @param {{ files: Array<{ path: string, text: string }>, prefixText: string }} input
 *   `prefixText` is the rendered fixed prefix (controls rendered from configuration).
 * @returns {Array<{ path: string, sentence: string }>} findings
 */
function lintControls({ files, prefixText }) {
  const rendered = normalizeSentence(prefixText);
  const findings = [];
  for (const f of files) {
    if (hasPathsFrontmatter(f.text)) continue; // path-bound rule: loaded deterministically
    for (const sentence of findControlSentences(f.text)) {
      if (!rendered.includes(sentence)) findings.push({ path: f.path, sentence });
    }
  }
  return findings;
}

module.exports = {
  CONTROL_RE,
  normalizeSentence,
  findControlSentences,
  hasPathsFrontmatter,
  lintControls,
};
