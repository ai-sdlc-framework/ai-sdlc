import { atom, read, update } from 'claude-code';
import type { Register } from 'claude-code';

import type { MeterAction, Totals } from '../types';
import {
  EMPTY_TOTALS,
  IDLE_HANDOFF,
  LEVEL_COLOR,
  addUsage,
  bar,
  costWeight,
  formatTokens,
  handoffStep,
  levelFor,
  percentOfWindow,
  resolveThresholds,
} from './meter.ts';

const totalsAtom = atom({ plugin: 'context-meter', key: 'totals' } as const, EMPTY_TOTALS);
const confirmAtom = atom({ plugin: 'context-meter', key: 'confirm' } as const, null);
const handoffAtom = atom({ plugin: 'context-meter', key: 'handoff' } as const, IDLE_HANDOFF);
const noteAtom = atom({ plugin: 'context-meter', key: 'note' } as const, null);

const HANDOFF_PROMPT =
  'Write your dated handoff memory file now (state, open work, next steps; index it in MEMORY.md), ' +
  'then reply "handoff written". Do no other work; the session will be cleared after this reply.';

const LABELS: Record<MeterAction, string> = {
  compact: '/compact',
  clear: '/clear',
  handoff: 'hand off, then /clear',
};

export const register: Register = (on, options) => {
  const thresholds = resolveThresholds(options as Record<string, unknown>);

  on('turn.complete', async ($, e, next) => {
    if (e.usage) {
      await update($, totalsAtom, (t: Totals) => addUsage(t, e.usage!));
    }

    // A pending confirmation does not outlive the turn it was asked in.
    await update($, confirmAtom, () => null);

    const step = handoffStep(
      await read($, handoffAtom),
      { kind: 'turn.complete', turnId: e.turnId, reason: e.reason, agentId: e.agentId },
      HANDOFF_PROMPT,
    );
    await update($, handoffAtom, () => step.state);
    if (step.clear) {
      void $.command.run({ command: 'clear' });
    }

    return next(e);
  });

  // Only the handoff prompt's own turn arms the clear; match it by its text.
  on('turn.start', async ($, e, next) => {
    const step = handoffStep(
      await read($, handoffAtom),
      { kind: 'turn.start', turnId: e.turnId, text: e.text },
      HANDOFF_PROMPT,
    );
    await update($, handoffAtom, () => step.state);
    return next(e);
  });

  // /clear starts a fresh session: totals count from there.
  on('session.end', async ($, e, next) => {
    await update($, confirmAtom, () => null);
    await update($, handoffAtom, () => IDLE_HANDOFF);
    await update($, noteAtom, () => null);
    if (e.reason === 'clear') {
      await update($, totalsAtom, () => EMPTY_TOTALS);
    }

    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e);
    }

    // Degrade to no output, never an error, when the host exposes no metrics.
    let tokens: number | undefined;
    let window: number | undefined;
    let usd: number | undefined;
    try {
      const usage = await $.session.usage();
      tokens = usage.context.tokens;
      window = usage.context.window;
      usd = usage.cost?.usd;
    } catch {
      return next(e);
    }

    const percent = percentOfWindow(tokens, window);
    const totals = await read($, totalsAtom);
    if (percent === null || tokens === undefined) {
      return next(e);
    }

    const confirm = await read($, confirmAtom);
    const note = await read($, noteAtom);
    const level = levelFor(percent, thresholds);
    const color = LEVEL_COLOR[level];
    const { Box, Button, Text } = $.ui.resolve(e);
    const weight = costWeight(totals);

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={color}>
            ctx {formatTokens(tokens)} / {formatTokens(window ?? 0)} ({percent.toFixed(1)}%){' '}
            {bar(percent, thresholds)}
            {level === 'hot' ? ' hand off soon' : ''}
            {level === 'red' ? ' clear now' : ''}
          </Text>
        </Box>
        <Box>
          <Text dimColor>
            session in {formatTokens(totals.input)} / cache-write {formatTokens(totals.cacheWrite)}{' '}
            / cache-read {formatTokens(totals.cacheRead)} / out {formatTokens(totals.output)} ·
            weight ~{formatTokens(weight)} input-eq
            {usd === undefined ? '' : ` · $${usd.toFixed(2)}`}{' '}
          </Text>
        </Box>
        {note === null ? null : (
          <Box>
            <Text color="red">{note}</Text>
          </Box>
        )}
        {confirm === null ? (
          <Box>
            <Button
              key="compact"
              label="Compact"
              onPress={() => update($, confirmAtom, () => 'compact')}
            />
            <Button
              key="clear"
              label="Clear"
              onPress={() => update($, confirmAtom, () => 'clear')}
            />
            <Button
              key="handoff"
              label="Hand off + clear"
              onPress={() => update($, confirmAtom, () => 'handoff')}
            />
          </Box>
        ) : (
          <Box>
            <Text color="yellow">Run {LABELS[confirm]}? </Text>
            <Button
              key="yes"
              label="Yes"
              onPress={async () => {
                await update($, confirmAtom, () => null);
                await update($, noteAtom, () => null);
                try {
                  if (confirm === 'compact') {
                    await $.session.compact();
                  } else if (confirm === 'clear') {
                    await $.command.run({ command: 'clear' });
                  } else {
                    const armed = handoffStep(IDLE_HANDOFF, { kind: 'submit' }, HANDOFF_PROMPT);
                    await update($, handoffAtom, () => armed.state);
                    try {
                      await $.prompt.submit({ text: HANDOFF_PROMPT });
                    } catch (err) {
                      await update($, handoffAtom, () => IDLE_HANDOFF);
                      throw err;
                    }
                  }
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  await update($, noteAtom, () => `${LABELS[confirm]} failed: ${msg}`);
                }
              }}
            />
            <Button key="no" label="Cancel" onPress={() => update($, confirmAtom, () => null)} />
          </Box>
        )}
      </Box>
    );
  });
};
