/**
 * useTerminalDimensions — subscribes to stdout `resize` events so React
 * components re-render whenever the terminal is resized (AISDLC-235).
 *
 * Without this hook, Ink's internal yoga-layout recalculation happens (width
 * is updated) but no React state changes, so components that rely on
 * `process.stdout.columns` / `.rows` in their render path serve stale values
 * and the frame output can corrupt.
 *
 * The hook returns the current `{ columns, rows }` as React state. Consuming
 * it in the root App component forces a top-down re-render on every resize
 * event, which is the minimal surface needed to keep the whole tree fresh.
 */

import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalDimensions {
  columns: number;
  rows: number;
}

/**
 * Returns the current terminal dimensions as reactive state.
 * Subscribes to the `resize` event on the Ink stdout stream so any
 * component tree that consumes this hook re-renders automatically when
 * the terminal is resized.
 */
export function useTerminalDimensions(): TerminalDimensions {
  const { stdout } = useStdout();

  const [dimensions, setDimensions] = useState<TerminalDimensions>(() => ({
    columns: (stdout as NodeJS.WriteStream).columns ?? 80,
    rows: (stdout as NodeJS.WriteStream).rows ?? 24,
  }));

  useEffect(() => {
    function onResize(): void {
      setDimensions({
        columns: (stdout as NodeJS.WriteStream).columns ?? 80,
        rows: (stdout as NodeJS.WriteStream).rows ?? 24,
      });
    }

    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return dimensions;
}
