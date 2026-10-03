/**
 * Deterministic failure-text corpus for the AISDLC-682 classifier snapshot.
 * Built from the heuristic vocabulary in `quality-classifier.ts` (no prior
 * fixture corpus existed): every phrase, in bridged and unbridged forms,
 * across case, line-terminator, wrong-order and partial variants.
 */

/** Each phrase is the ordered literal segments of one heuristic. */
const PHRASES: string[][] = [
  ['github', 'api', 'error'],
  ['github', 'api', 'outage'],
  ['anthropic', 'claude', 'rate-limit'],
  ['anthropic', 'api', 'overloaded'],
  ['rate limited'],
  ['ratelimit'],
  ['npm', 'registry'],
  ['npm', 'ERR'],
  ['ECONNRESET'],
  ['ETIMEDOUT'],
  ['network', 'partition'],
  ['503', 'service', 'unavailable'],
  ['502', 'bad', 'gateway'],
  ['developer', 'returned', 'prose'],
  ['JSON', 'envelope', 'required'],
  ['parse', 'developer', 'return'],
  ['invalid', 'json', 'response'],
  ['SyntaxError', 'JSON'],
  ['worktree', 'left', 'after', 'fail'],
  ['sentinel', 'not', 'removed'],
  ['cleanup', 'fail'],
  ['active-task', 'stale'],
  ['filter', 'throw'],
  ['pre-dispatch', 'fail'],
  ['swallowed', 'error'],
  ['silently', 'dispatch'],
  ['3x', 'baseline'],
  ['took', 'dramatically', 'longer'],
  ['performance', 'regression'],
  ['timeout', 'baseline'],
  ['AC', 'list', 'missing'],
  ['open', 'question', 'unanswered'],
  ['needs-clarification'],
  ['missing', 'acceptance', 'criteria'],
  ['DoR', 'failed'],
  ['definition-of-ready', 'fail'],
];

const JOINERS = [' ', '  ', '\t', '\n', '\r\n', ' ', ' x '.repeat(3), ' ... ', '-', '_', ''];

function join(parts: string[], sep: string): string {
  return parts.join(sep);
}

export function buildCorpus(): string[] {
  const out = new Set<string>(['', ' ', '\n', 'all good', 'exit 1']);
  for (const phrase of PHRASES) {
    for (const sep of JOINERS) {
      const text = join(phrase, sep);
      out.add(text);
      out.add(text.toUpperCase());
      out.add(`prefix ${text} suffix`);
      out.add(`line one\n${text}\nline three`);
    }
    out.add(join([...phrase].reverse(), ' '));
    out.add(join(phrase.slice(0, -1), ' '));
    out.add(join(phrase.slice(1), ' '));
    out.add(join(phrase, ' ').replace(/ /g, '\n'));
    out.add(join(phrase, ' ').replace(/ /g, '   \n  '));
    out.add(`${join(phrase, ' ')}\n${join(phrase, ' ')}`);
    out.add(`${phrase[0]}\n${phrase.slice(1).join(' ')}`);
    out.add(`${phrase[0]} ${phrase.slice(1).join('\n')}`);
    out.add(`${phrase.join(' ')} ${phrase.join(' ')} ${phrase.join(' ')}`);
  }
  // Cross-family combinations (stacking bonus + class-selection paths).
  for (let i = 0; i < PHRASES.length; i += 5) {
    for (let j = i + 1; j < PHRASES.length; j += 7) {
      out.add(`${join(PHRASES[i]!, ' ')}\n${join(PHRASES[j]!, ' ')}`);
      out.add(`${join(PHRASES[i]!, ' ')} ${join(PHRASES[j]!, ' ')}`);
    }
  }
  // Same-line repeated head with the tail on a later line (bridge must not cross lines).
  out.add('developer a\ndeveloper b\nreturned c\nprose');
  out.add('developer returned\nprose');
  out.add('developer a returned b\nprose c developer d returned e prose');
  out.add('timeout a\nbaseline\ntimeout b baseline');
  out.add('DoR failed DoR ok failed');
  return [...out].sort();
}

export const EXIT_CODES: (number | null)[] = [null, 0, 1];
