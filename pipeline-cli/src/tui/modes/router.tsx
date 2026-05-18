/**
 * Mode router — RFC-0023 §7.6 / AISDLC-178.5 AC#1-3, #9, #10.
 *
 * Owns the active-mode state, the search-input string, and the
 * refresh-nonce that invalidates source caches. Dispatches mode-switch
 * keystrokes per the shared keymap; mode-specific keystrokes belong to
 * the panes themselves.
 *
 * Design:
 *   - The pure dispatcher `routeKey` is exported so unit tests can
 *     exercise routing without driving Ink raw-mode (mirrors the
 *     `handleAppKey` extraction in `app.tsx`).
 *   - The router renders the appropriate full-screen view for the active
 *     mode; when the mode is `overview` it renders nothing (the App
 *     keeps the existing 5-pane Overview Mode layout). Tests that want
 *     to assert routing render the router directly with a fake App
 *     wrapper.
 */

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';

import { isModeKey, modeForKey, type ModeId } from '../keymap.js';
import { BlockersPane } from '../panes/blockers.js';
import { PrsPane } from '../panes/prs.js';
import { AnalyticsPane } from '../panes/analytics.js';
import { HelpScreen } from './help.js';
import { DepsFullScreen } from './deps-full.js';
import { ConfigBrowserPane } from '../config-browser/pane.js';
import { DecisionsPendingPane } from '../decisions-pending/pane.js';
import { writeInteraction, type WriteInteractionOpts } from '../analytics/interactions-writer.js';

// ── Refresh context (AC#10) ──────────────────────────────────────────────────

export interface RefreshContextValue {
  /** Monotonically increasing — bumped on every `r` keystroke. */
  nonce: number;
  /** Imperative trigger (e.g. from a child action button). */
  refresh: () => void;
}

const RefreshContext = createContext<RefreshContextValue>({ nonce: 0, refresh: () => {} });

export function useRefreshNonce(): RefreshContextValue {
  return useContext(RefreshContext);
}

// ── Full-screen context — lets panes know whether the router has zoomed
// them in. AC#8 (`b` opens kanban on a task row) only fires when the pane
// is in full-screen mode; otherwise `b` is consumed by the router for a
// mode transition.

const FullScreenContext = createContext<boolean>(false);

export function useIsFullScreen(): boolean {
  return useContext(FullScreenContext);
}

// ── Search context (AC#9) ────────────────────────────────────────────────────

export interface SearchContextValue {
  /** Current filter query, or null when not searching. */
  query: string | null;
  /** Whether the input bar is open + accepting keystrokes. */
  active: boolean;
  /** Imperative setters used by the search overlay. */
  setQuery: (q: string | null) => void;
  setActive: (a: boolean) => void;
}

const SearchContext = createContext<SearchContextValue>({
  query: null,
  active: false,
  setQuery: () => {},
  setActive: () => {},
});

export function useSearch(): SearchContextValue {
  return useContext(SearchContext);
}

// ── Pure routing dispatch — exported for unit tests ──────────────────────────

export interface RouteState {
  mode: ModeId;
  searchQuery: string | null;
  searchActive: boolean;
  refreshNonce: number;
}

export interface RouteActions {
  setMode: (m: ModeId) => void;
  setSearchQuery: (q: string | null) => void;
  setSearchActive: (a: boolean) => void;
  bumpRefresh: () => void;
  exit: () => void;
}

export interface InkKey {
  escape?: boolean;
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
}

/**
 * Pure routing dispatcher. Returns `true` when the keystroke is consumed
 * (caller should NOT propagate it to the active pane).
 */
export function routeKey(
  input: string,
  key: InkKey,
  state: RouteState,
  actions: RouteActions,
): boolean {
  // Search-input mode: most printable keys append; Esc closes; Enter commits.
  if (state.searchActive) {
    if (key.escape) {
      actions.setSearchActive(false);
      actions.setSearchQuery(null);
      return true;
    }
    if (key.return) {
      actions.setSearchActive(false); // commit; query persists for filtering
      return true;
    }
    if (key.backspace || key.delete) {
      actions.setSearchQuery(state.searchQuery ? state.searchQuery.slice(0, -1) : null);
      return true;
    }
    if (input && input.length === 1) {
      actions.setSearchQuery((state.searchQuery ?? '') + input);
      return true;
    }
    return true; // swallow everything while typing
  }

  // Esc returns to overview from any non-overview mode (AC#2).
  if (key.escape && state.mode !== 'overview') {
    actions.setMode('overview');
    return true;
  }

  // Mode-switch keys: always switch when target differs from current mode.
  // When state.mode === target the router does NOT consume the key — the
  // active pane can re-use the mode key for a row-scoped action (e.g. `b`
  // on a focused task row opens backlog.md per AC#8 / OQ-5). The operator
  // returns to overview via Esc.
  if (isModeKey(input)) {
    const target = modeForKey(input);
    if (target && state.mode !== target) {
      actions.setMode(target);
      return true;
    }
  }

  // `/` opens the search input.
  if (input === '/') {
    actions.setSearchActive(true);
    actions.setSearchQuery('');
    return true;
  }

  // `r` bumps the refresh nonce.
  if (input === 'r') {
    actions.bumpRefresh();
    return true;
  }

  // `q` exits — but only when we're in overview. In other modes we let
  // the pane handle it (e.g. detail-view close).
  if (input === 'q' && state.mode === 'overview') {
    actions.exit();
    return true;
  }

  return false;
}

// ── Router component ────────────────────────────────────────────────────────

export interface ModeRouterProps {
  /** What to render when mode === 'overview'. The App passes the 5-pane layout. */
  overviewSlot: React.ReactNode;
  /**
   * Inject the interactions writer (tests). Defaults `writeInteraction` —
   * the production path that respects `AI_SDLC_TUI_TELEMETRY=off`.
   */
  interactionsWriter?: (
    record: Parameters<typeof writeInteraction>[0],
    opts?: WriteInteractionOpts,
  ) => boolean;
}

/**
 * Renders the right pane for the active mode and wires the keymap.
 *
 * Wrapping the Overview Mode allows the App to keep its existing 5-pane
 * layout intact while the mode keys hand off to full-screen views.
 */
export function ModeRouter({
  overviewSlot,
  interactionsWriter = writeInteraction,
}: ModeRouterProps): React.ReactElement {
  const { exit } = useApp();
  const [mode, setMode] = useState<ModeId>('overview');
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [searchActive, setSearchActive] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const bumpRefresh = useCallback((): void => {
    setRefreshNonce((n) => n + 1);
  }, []);

  // RFC-0023 §10 AC#3 — log every mode transition + refresh / search edge
  // to `_operator/interactions.jsonl`. Default ON; the writer self-gates
  // on `AI_SDLC_TUI_TELEMETRY=off`. The first mount records the initial
  // overview pane so the corpus has the entry-point event.
  const writerRef = useRef(interactionsWriter);
  writerRef.current = interactionsWriter;

  const lastModeRef = useRef<ModeId | null>(null);
  useEffect(() => {
    if (lastModeRef.current === mode) return;
    lastModeRef.current = mode;
    writerRef.current({ kind: 'pane-opened', pane: mode });
  }, [mode]);

  const lastRefreshRef = useRef(refreshNonce);
  useEffect(() => {
    if (lastRefreshRef.current === refreshNonce) return;
    lastRefreshRef.current = refreshNonce;
    if (refreshNonce > 0) writerRef.current({ kind: 'refresh', pane: mode });
  }, [refreshNonce, mode]);

  const lastSearchActiveRef = useRef(false);
  useEffect(() => {
    if (lastSearchActiveRef.current === searchActive) return;
    lastSearchActiveRef.current = searchActive;
    writerRef.current({
      kind: searchActive ? 'search-opened' : 'search-committed',
      pane: mode,
      detail: searchQuery ?? undefined,
    });
  }, [searchActive, mode, searchQuery]);

  useInput((input, key) => {
    routeKey(
      input,
      key as InkKey,
      { mode, searchQuery, searchActive, refreshNonce },
      {
        setMode,
        setSearchQuery,
        setSearchActive,
        bumpRefresh,
        exit,
      },
    );
  });

  const refreshCtx: RefreshContextValue = { nonce: refreshNonce, refresh: bumpRefresh };
  const searchCtx: SearchContextValue = {
    query: searchQuery,
    active: searchActive,
    setQuery: setSearchQuery,
    setActive: setSearchActive,
  };

  return (
    <RefreshContext.Provider value={refreshCtx}>
      <SearchContext.Provider value={searchCtx}>
        <FullScreenContext.Provider value={mode !== 'overview'}>
          <Box flexDirection="column" width="100%" height="100%">
            <ModeContent mode={mode} overviewSlot={overviewSlot} searchQuery={searchQuery} />
            {searchActive && <SearchOverlay query={searchQuery ?? ''} />}
          </Box>
        </FullScreenContext.Provider>
      </SearchContext.Provider>
    </RefreshContext.Provider>
  );
}

function ModeContent({
  mode,
  overviewSlot,
  searchQuery,
}: {
  mode: ModeId;
  overviewSlot: React.ReactNode;
  searchQuery: string | null;
}): React.ReactElement {
  switch (mode) {
    case 'blockers':
      return <BlockersPane />;
    case 'prs':
      return <PrsPane />;
    case 'deps':
      return <DepsFullScreen filterQuery={searchQuery} />;
    case 'config':
      return <ConfigBrowserPane filterQuery={searchQuery} />;
    case 'analytics':
      return <AnalyticsPane />;
    case 'decisions':
      return <DecisionsPendingPane />;
    case 'help':
      return <HelpScreen />;
    case 'overview':
    default:
      return <>{overviewSlot}</>;
  }
}

function SearchOverlay({ query }: { query: string }): React.ReactElement {
  return (
    <Box borderStyle="single" paddingX={1}>
      <Text color="cyan">/ </Text>
      <Text>{query}</Text>
      <Text color="gray" dimColor>
        {' '}
        — type to filter, Enter to commit, Esc to clear
      </Text>
    </Box>
  );
}
