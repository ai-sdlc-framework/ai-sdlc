# Testing convention: fix the clock (AISDLC-769)

**Rule.** A test that writes a fixed timestamp must also fix the clock, either with `vi.useFakeTimers({ now })` or through the module's `now` seam.

**Why.** On 2026-10-08 a usage-pane test wrote a ledger record stamped 2026-09-10 and rendered through code that read the real clock. It passed for 28 days, then failed on every run with no code change and turned `main` red. See [the RCA](../audits/2026-10-09-clock-dependent-test-red-main-rca.md).

## In tests

- Pipeline-cli: `withFixedClock(iso, fn)` from `pipeline-cli/src/__test-helpers/with-fixed-clock.ts` fixes both the `clock.ts` seam and `Date` (via `vi.useFakeTimers({ now, toFake: ['Date'] })`), and restores both afterwards. Only `Date` is faked, so real file I/O and timers keep working.
- Elsewhere: `vi.useFakeTimers({ now: new Date(iso) })`, or pass the code's `now` dependency (for example `loadUsagePaneData({ now: () => NOW })`).
- Worked example: `pipeline-cli/src/tui/panes/usage.test.tsx` (bad-ledger-line test) and `pipeline-cli/src/usage/pane-data.test.ts`.

## In source

Read the time through the package `clock.ts` seam (`now(): Date`, replaceable with `setClock()`), not `new Date()` (no arguments) or `Date.now()`. `pipeline-cli/src/clock.ts` is the first seam; add one per package as you touch its call sites.

## Enforcement

- `node scripts/check-clock-discipline.mjs` runs as part of `pnpm lint` and `pnpm test`. It counts direct clock reads per non-test `src/**` file (files named `clock.ts` are the seam and exempt) and compares them to `scripts/clock-baseline.json`.
- Same ratchet as the dark-code gate: a new call site, or a new file with one, fails; a baseline entry above the current count also fails (run `--update-baseline` to record the shrink). `--update-baseline` refuses to grow the baseline. `scripts/check-clock-discipline.test.mjs` asserts all of this.
- The test-reviewer agent treats "a test that fixes a timestamp and does not fix the clock" as a major finding.
