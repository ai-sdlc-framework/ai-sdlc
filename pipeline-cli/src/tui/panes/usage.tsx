/**
 * Usage pane (full-screen) — RFC-0050 A5.
 *
 * Shows the session and weekly windows (units used, implied allotment,
 * projected time to the limit), the top consumers of the current weekly window
 * by role and by model with their five token classes, the most recent limit
 * event and any suspected allotment change. Counts, model ids, agent roles,
 * units and timestamps only; never message text or project paths.
 *
 * The ledger is read through `loadUsagePaneData` (the existing reader and report
 * functions), refreshed on a poll interval and on the router's refresh key.
 * A failed read renders a fixed error line; it never throws into the app.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';

import { useRefreshNonce } from '../modes/router.js';
import {
  loadUsagePaneData,
  type UsagePaneData,
  type UsagePaneDeps,
} from '../../usage/pane-data.js';
import { sanitizeLabel } from '../../usage/sanitize-label.js';
import type { ReportRow } from '../../usage/report.js';
import type { WindowView } from '../../usage/windows.js';

export const USAGE_PANE_HEADING = 'USAGE';
export const USAGE_POLL_INTERVAL_MS = 15_000;
export const USAGE_EMPTY_TEXT =
  'No usage recorded yet. Calls appear here once the usage ingesters have run (see: cli-usage --help).';
export const USAGE_ERROR_TEXT = 'Usage ledger could not be read. Press r to retry.';

export interface UsagePaneProps {
  /** Inject the loader (tests). */
  load?: () => Promise<UsagePaneData>;
  /** Inject loader dependencies (tests); ignored when `load` is given. */
  deps?: UsagePaneDeps;
  intervalMs?: number;
}

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: UsagePaneData };

const INT = (n: number): string => Math.round(n).toLocaleString('en-US');

function windowLines(v: WindowView): string[] {
  const used = v.start ? `${INT(v.units)} units / ${v.calls} calls` : 'no window open';
  const allot =
    v.impliedAllotment !== undefined
      ? `allotment ${INT(v.impliedAllotment)}${
          v.percentOfAllotment !== undefined ? ` (${v.percentOfAllotment.toFixed(1)}%)` : ''
        }`
      : 'allotment unknown';
  const limit =
    v.hoursToLimit !== undefined ? `limit in ${v.hoursToLimit.toFixed(1)}h` : 'limit n/a';
  return [`${sanitizeLabel(v.window)} (${v.lengthHours}h)  ${used}`, `  ${allot}  ${limit}`];
}

function consumerLine(label: string, r: ReportRow): string {
  return (
    `${label}  in ${INT(r.input)}  w5m ${INT(r.cacheWrite5m)}  w1h ${INT(r.cacheWrite1h)}` +
    `  read ${INT(r.cacheRead)}  out ${INT(r.output)}  u ${INT(r.units)}`
  );
}

function Row({ children, ...rest }: { children: string } & React.ComponentProps<typeof Text>) {
  // Defence in depth: whatever a caller built, no control character reaches the
  // terminal and the row stays on one line.
  return (
    <Text {...rest} wrap="truncate-end">
      {sanitizeLabel(children, Infinity)}
    </Text>
  );
}

function Consumers({
  title,
  rows,
  key1,
}: {
  title: string;
  rows: ReportRow[];
  key1: 'role' | 'model';
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Row bold>{title}</Row>
      {rows.length === 0 ? (
        <Row color="gray"> none in this window</Row>
      ) : (
        rows.map((r) => (
          <Row key={r.keys[key1] ?? ''}>
            {consumerLine(`  ${sanitizeLabel(r.keys[key1] ?? '(unknown)')}`, r)}
          </Row>
        ))
      )}
    </Box>
  );
}

function Body({ data }: { data: UsagePaneData }): React.ReactElement {
  if (data.empty) return <Row color="gray">{USAGE_EMPTY_TEXT}</Row>;
  const ev = data.lastLimitEvent;
  const ch = data.allotmentChange;
  return (
    <Box flexDirection="column">
      {data.windows.flatMap((v) =>
        windowLines(v).map((l, i) => <Row key={`${v.window}-${i}`}>{l}</Row>),
      )}
      <Consumers
        title={`TOP CONSUMERS BY ROLE (${sanitizeLabel(data.consumerWindow ?? 'weekly')} window)`}
        rows={data.topByRole}
        key1="role"
      />
      <Consumers
        title={`TOP CONSUMERS BY MODEL (${sanitizeLabel(data.consumerWindow ?? 'weekly')} window)`}
        rows={data.topByModel}
        key1="model"
      />
      <Box flexDirection="column" marginTop={1}>
        <Row>
          {ev
            ? `Last limit event: ${sanitizeLabel(ev.window)} ${Number(ev.usedPercent).toFixed(1)}% at ${sanitizeLabel(ev.ts)}`
            : 'Last limit event: none recorded'}
        </Row>
        {ch ? (
          <Row color="yellow">
            {`Probable allotment change: ${sanitizeLabel(ch.window)} ${ch.previousAllotment !== undefined ? INT(ch.previousAllotment) : 'unknown'} -> ${INT(ch.impliedAllotment)} at ${sanitizeLabel(ch.ts)}`}
          </Row>
        ) : null}
      </Box>
    </Box>
  );
}

export function UsagePane({ load, deps, intervalMs }: UsagePaneProps = {}): React.ReactElement {
  const { nonce } = useRefreshNonce();
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const loadRef = useRef(load);
  loadRef.current = load;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const inFlight = useRef(false);
  const unmounted = useRef(false);

  useEffect(() => {
    unmounted.current = false;
    return (): void => {
      unmounted.current = true;
    };
  }, []);

  useEffect(() => {
    const handle = setInterval(() => setTick((n) => n + 1), intervalMs ?? USAGE_POLL_INTERVAL_MS);
    return (): void => clearInterval(handle);
  }, [intervalMs]);

  useEffect(() => {
    // A refresh that arrives while a load is still running is skipped, so slow
    // reads never stack.
    if (inFlight.current) return;
    inFlight.current = true;
    const run = async (): Promise<void> => {
      try {
        const data = await (loadRef.current ?? (() => loadUsagePaneData(depsRef.current)))();
        if (!unmounted.current) setState({ kind: 'ready', data });
      } catch {
        if (!unmounted.current) setState({ kind: 'error' });
      } finally {
        inFlight.current = false;
      }
    };
    void run();
  }, [nonce, tick]);

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} flexGrow={1}>
      <Row bold color="magenta">
        {USAGE_PANE_HEADING}
      </Row>
      {state.kind === 'loading' ? <Row color="gray">Loading usage...</Row> : null}
      {state.kind === 'error' ? <Row color="red">{USAGE_ERROR_TEXT}</Row> : null}
      {state.kind === 'ready' ? <Body data={state.data} /> : null}
    </Box>
  );
}
