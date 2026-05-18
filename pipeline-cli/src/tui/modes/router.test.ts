/**
 * Mode-router routing-table tests — RFC-0023 §7.6 / AISDLC-178.5 AC#1-2, #9-10.
 *
 * The router exports `routeKey` as a pure function so we can drive every
 * branch without the Ink raw-mode pipeline (mirroring the `handleAppKey`
 * extraction in `app.tsx`).
 */

import { describe, expect, it, vi } from 'vitest';

import { routeKey, type InkKey, type RouteActions, type RouteState } from './router.js';

function makeActions(): RouteActions {
  return {
    setMode: vi.fn(),
    setSearchQuery: vi.fn(),
    setSearchActive: vi.fn(),
    bumpRefresh: vi.fn(),
    exit: vi.fn(),
  };
}

const overview: RouteState = {
  mode: 'overview',
  searchQuery: null,
  searchActive: false,
  refreshNonce: 0,
};

describe('routeKey — mode-switch keys', () => {
  it.each([
    ['b', 'blockers'],
    ['p', 'prs'],
    ['d', 'deps'],
    ['c', 'config'],
    ['a', 'analytics'],
    ['n', 'decisions'],
    ['?', 'help'],
  ] as const)('%s switches to %s mode (consumed)', (key, mode) => {
    const actions = makeActions();
    expect(routeKey(key, {}, overview, actions)).toBe(true);
    expect(actions.setMode).toHaveBeenCalledWith(mode);
  });

  it('mode key targeting current mode is NOT consumed (pane handles it)', () => {
    const actions = makeActions();
    const state: RouteState = { ...overview, mode: 'blockers' };
    expect(routeKey('b', {}, state, actions)).toBe(false);
    expect(actions.setMode).not.toHaveBeenCalled();
  });

  it('Esc returns to overview from any non-overview mode', () => {
    const actions = makeActions();
    const state: RouteState = { ...overview, mode: 'config' };
    expect(routeKey('', { escape: true } as InkKey, state, actions)).toBe(true);
    expect(actions.setMode).toHaveBeenCalledWith('overview');
  });

  it('Esc in overview is NOT consumed (no setMode called)', () => {
    const actions = makeActions();
    expect(routeKey('', { escape: true } as InkKey, overview, actions)).toBe(false);
    expect(actions.setMode).not.toHaveBeenCalled();
  });
});

describe('routeKey — search (/)', () => {
  it('opens the search input on /', () => {
    const actions = makeActions();
    expect(routeKey('/', {}, overview, actions)).toBe(true);
    expect(actions.setSearchActive).toHaveBeenCalledWith(true);
    expect(actions.setSearchQuery).toHaveBeenCalledWith('');
  });

  it('appends typed characters while search-active', () => {
    const actions = makeActions();
    const state: RouteState = { ...overview, searchActive: true, searchQuery: 'foo' };
    expect(routeKey('b', {}, state, actions)).toBe(true);
    expect(actions.setSearchQuery).toHaveBeenCalledWith('foob');
  });

  it('backspace pops the last char', () => {
    const actions = makeActions();
    const state: RouteState = { ...overview, searchActive: true, searchQuery: 'foo' };
    expect(routeKey('', { backspace: true } as InkKey, state, actions)).toBe(true);
    expect(actions.setSearchQuery).toHaveBeenCalledWith('fo');
  });

  it('Enter commits the search (closes input, query persists)', () => {
    const actions = makeActions();
    const state: RouteState = { ...overview, searchActive: true, searchQuery: 'foo' };
    expect(routeKey('', { return: true } as InkKey, state, actions)).toBe(true);
    expect(actions.setSearchActive).toHaveBeenCalledWith(false);
    expect(actions.setSearchQuery).not.toHaveBeenCalled();
  });

  it('Esc clears the search', () => {
    const actions = makeActions();
    const state: RouteState = { ...overview, searchActive: true, searchQuery: 'foo' };
    expect(routeKey('', { escape: true } as InkKey, state, actions)).toBe(true);
    expect(actions.setSearchActive).toHaveBeenCalledWith(false);
    expect(actions.setSearchQuery).toHaveBeenCalledWith(null);
  });

  it('mode keys do not switch modes while search-active', () => {
    const actions = makeActions();
    const state: RouteState = { ...overview, searchActive: true, searchQuery: '' };
    expect(routeKey('b', {}, state, actions)).toBe(true);
    expect(actions.setMode).not.toHaveBeenCalled();
    expect(actions.setSearchQuery).toHaveBeenCalledWith('b');
  });
});

describe('routeKey — refresh (r)', () => {
  it('bumps the refresh nonce on r in overview', () => {
    const actions = makeActions();
    expect(routeKey('r', {}, overview, actions)).toBe(true);
    expect(actions.bumpRefresh).toHaveBeenCalledTimes(1);
  });

  it('bumps the refresh nonce on r from any non-overview mode', () => {
    const actions = makeActions();
    const state: RouteState = { ...overview, mode: 'prs' };
    expect(routeKey('r', {}, state, actions)).toBe(true);
    expect(actions.bumpRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('routeKey — quit (q)', () => {
  it('q exits when in overview', () => {
    const actions = makeActions();
    expect(routeKey('q', {}, overview, actions)).toBe(true);
    expect(actions.exit).toHaveBeenCalledTimes(1);
  });

  it('q does NOT exit from non-overview mode (panes can use q)', () => {
    const actions = makeActions();
    const state: RouteState = { ...overview, mode: 'blockers' };
    expect(routeKey('q', {}, state, actions)).toBe(false);
    expect(actions.exit).not.toHaveBeenCalled();
  });
});

describe('routeKey — unknown keys fall through', () => {
  it('returns false for keys not in the keymap', () => {
    const actions = makeActions();
    expect(routeKey('z', {}, overview, actions)).toBe(false);
    expect(routeKey('1', {}, overview, actions)).toBe(false);
  });
});
