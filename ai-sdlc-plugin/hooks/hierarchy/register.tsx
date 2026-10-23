// RFC-0058 phase 1 (AISDLC-1034): the hierarchy hooks module, executor role only.
// Registered through hooks/hooks.json `modules`. It registers one `session.start` gate; the role hooks are
// registered from inside it, so a session with no hierarchy role (or a host below the floor) gets none.
// `$` is only ever spelled `$.noun.verb(...)` here (the validator refuses anything else).
import {
  ROTATION_KEY,
  exists,
  guard,
  log,
  pickRole,
  registerExecutor,
  resumeAfterClear,
  safe,
} from './executor.ts';
import type { ExecutorState, Ports } from './executor.ts';
import {
  DEFAULT_TICK_MS,
  DISPATCH_PRIMITIVES,
  BOARD_KEY,
  newDispatchState,
  refreshPane,
  registerDispatch,
  tick,
} from './dispatch.ts';
import type { DispatchPorts } from './dispatch.ts';

type Any = any;

export const register = (on: Any, options?: Any): void => {
  let armed = false;
  const state: ExecutorState = { active: false, pendingRotate: false, lastReply: '' };
  const dispatch = newDispatchState(options);
  let dispatchArmed = false;

  on('session.start', async ($: Any, e: Any, next: Any) => {
    const p: Ports = {
      storeGet: (k) => $.store.get(k),
      storeSet: (k, v) => $.store.set(k, v),
      runCommand: (a) => $.command.run(a),
      compact: (a) => $.session.compact(a),
      submit: (a) => $.prompt.submit(a),
    };
    // A record carried by a rotation whose new session never reached a hook is stale: clear it here so it
    // cannot start an executor in an unrelated session. A live post-clear resume runs from the turn hooks.
    if (!state.resumePending) await safe(() => p.storeSet(ROTATION_KEY, null));
    const role = pickRole([
      (await safe(() => $.env.get('HIERARCHY_ROLE'))).value,
      (await safe(() => $.env.get('AI_SDLC_HIERARCHY_ROLE'))).value,
      options?.role,
    ]);
    if (!role) return next(e);

    const version = (await safe(() => $.session.version())).value;
    // OQ-5: the validator refuses `typeof $.noun.verb`, so each primitive is probed by one call whose
    // argument is a bare string, never an object with fields: a typed boundary rejects it before any
    // action (no compaction, no blank turn), and only an absent primitive counts as missing. A host that
    // does not validate would see no `text` / `instructions` field to act on. `session.measure` is an
    // event; its read-only pull-side twin `$.session.usage` stands in for it.
    const present: Record<string, boolean> =
      role === 'operator-dispatch'
        ? {
            'clock.every': await exists(() => $.clock.every('probe'), 'every'),
            'process.run': await exists(() => $.process.run('probe'), 'run'),
            'session.send': await exists(() => $.session.send('probe'), 'send'),
            'ui.open': await exists(() => $.ui.open('probe'), 'open'),
            'session.measure': await exists(() => $.session.usage(), 'usage'),
          }
        : {
            'prompt.submit': await exists(() => $.prompt.submit('probe'), 'submit'),
            'command.run': await exists(() => $.command.run('probe'), 'run'),
            'session.compact': await exists(() => $.session.compact('probe'), 'compact'),
            'session.measure': await exists(() => $.session.usage(), 'usage'),
            'session.send': await exists(() => $.session.send('probe'), 'send'),
          };
    const miss = guard(
      version,
      present,
      role === 'operator-dispatch' ? DISPATCH_PRIMITIVES : undefined,
    );
    if (miss) {
      await log(p, miss);
      return next(e);
    }

    // OQ-4: informational only, never authority.
    const identity = (await safe(() => $.session.identity())).value;
    await log(
      p,
      `role=${role} tier=${identity ? 'managed' : 'user'} identity=${identity ? JSON.stringify(identity) : 'none'}`,
    );
    if (role === 'operator-dispatch') {
      // AISDLC-1035: a model-less host. No prompt.submit port exists in the dispatch module.
      if (!dispatchArmed) {
        dispatchArmed = true;
        registerDispatch(on, dispatch);
      }
      dispatch.enabled = true;
      const tickMs = Number(options?.tickMs) > 0 ? Number(options.tickMs) : DEFAULT_TICK_MS;
      await safe(() => $.ui.open({ id: 'board', title: 'Dispatch board' }));
      await safe(() =>
        $.clock.every({
          ms: tickMs,
          run: async () => {
            const dp: DispatchPorts = {
              storeGet: (k) => $.store.get(k),
              storeSet: (k, v) => $.store.set(k, v),
              runCommand: (a) => $.command.run(a),
              runProcess: (a) => $.process.run(a),
              send: (a) => $.session.send(a),
              uiOpen: (a) => $.ui.open(a),
            };
            await tick(dp, dispatch);
          },
        }),
      );
      const dp: DispatchPorts = {
        storeGet: (k) => $.store.get(k),
        storeSet: (k, v) => $.store.set(k, v),
        runCommand: (a) => $.command.run(a),
        runProcess: (a) => $.process.run(a),
        send: (a) => $.session.send(a),
        uiOpen: (a) => $.ui.open(a),
      };
      // A rotation keeps the last pane in $.store; show it until the first tick replaces it.
      const kept = (await safe(() => dp.storeGet(BOARD_KEY))).value as string[] | undefined;
      if (Array.isArray(kept)) dispatch.pane = kept;
      await refreshPane(dp, dispatch);
      return next(e);
    }
    if (role !== 'executor') return next(e);
    if (!armed) {
      armed = true;
      registerExecutor(on, state);
    }
    state.enabled = true;
    // INTERIM: if a host fires session.start after a mod-run clear, resume from here as well.
    if (state.resumePending) await resumeAfterClear(p, state);
    return next(e);
  });
};
