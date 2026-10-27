// RFC-0058 phase 1 (AISDLC-1034): the hierarchy hooks module, executor role only.
// Registered through hooks/hooks.json `modules`. All hooks register from register() (the host refuses on() later);
// the session.start gate arms a role, and without one the forwarders pass events through.
// `$` is only ever spelled `$.noun.verb(...)` here (the validator refuses anything else).
import {
  ROTATION_KEY,
  exists,
  guard,
  log,
  pickRole,
  executorSessionMeasure,
  executorSessionReceive,
  executorTurnComplete,
  executorTurnStart,
  resumeAfterClear,
  safe,
  setSwallowSink,
} from './executor.ts';
import type { ExecutorState, Ports } from './executor.ts';
import {
  DEFAULT_TICK_MS,
  DISPATCH_PRIMITIVES,
  BOARD_KEY,
  newDispatchState,
  attempt,
  refreshPaneBounded,
  dispatchSessionMeasure,
  dispatchSessionReceive,
  dispatchUiRender,
  tick,
  writeModuleHealth,
} from './dispatch.ts';
import type { DispatchPorts, DispatchState } from './dispatch.ts';
import {
  plannerSessionMeasure,
  plannerSessionReceive,
  plannerTurnComplete,
  plannerTurnStart,
} from './planner.ts';
import type { PlannerState } from './planner.ts';

type Any = any;

interface Router {
  current: string;
  executor: ExecutorState;
  dispatch: DispatchState;
  planner: PlannerState;
}

// The validator follows `$` only into functions declared at the top of the file or imported from the
// module's own files, so the forwarders are plain top-level functions that call each role's handler
// by name. They are the one place that decides which role receives an event.
function onReceive(r: Router, $: Any, e: Any, next: Any): Any {
  if (r.current === 'operator-dispatch') return dispatchSessionReceive(r.dispatch, $, e, next);
  if (r.current === 'planner') return plannerSessionReceive(r.planner, $, e, next);
  if (r.current === 'executor') return executorSessionReceive(r.executor, $, e, next);
  return next(e);
}
function onTurnStart(r: Router, $: Any, e: Any, next: Any): Any {
  if (r.current === 'planner') return plannerTurnStart(r.planner, $, e, next);
  if (r.current === 'executor') return executorTurnStart(r.executor, $, e, next);
  return next(e);
}
function onTurnComplete(r: Router, $: Any, e: Any, next: Any): Any {
  if (r.current === 'planner') return plannerTurnComplete(r.planner, $, e, next);
  if (r.current === 'executor') return executorTurnComplete(r.executor, $, e, next);
  return next(e);
}
function onRender(r: Router, $: Any, e: Any, next: Any): Any {
  return r.dispatch.enabled ? dispatchUiRender(r.dispatch, $, e, next) : next(e);
}
function onMeasure(r: Router, $: Any, e: Any, next: Any): Any {
  if (r.current === 'operator-dispatch') return dispatchSessionMeasure(r.dispatch, $, e, next);
  if (r.current === 'planner') return plannerSessionMeasure(r.planner, $, e, next);
  if (r.current === 'executor') return executorSessionMeasure(r.executor, $, e, next);
  return next(e);
}

export const register = (on: Any, options?: Any): void => {
  // Each event is registered once per module (the validator is static and refuses a duplicate).
  const router: Router = {
    current: '',
    executor: { active: false, pendingRotate: false, lastReply: '' },
    dispatch: newDispatchState(options),
    planner: {
      active: false,
      pendingRotate: false,
      lastReply: '',
      name: 'planner',
      inTurn: false,
    },
  };
  const state = router.executor;
  const dispatch = router.dispatch;
  const planner = router.planner;
  // The host refuses any on() after register() returned (AISDLC-1081), so every hook is registered here,
  // once. The forwarders pass the event through while router.current is empty (no role armed).
  on('session.receive', ($: Any, e: Any, next: Any) => onReceive(router, $, e, next));
  on('turn.start', ($: Any, e: Any, next: Any) => onTurnStart(router, $, e, next));
  on('turn.complete', ($: Any, e: Any, next: Any) => onTurnComplete(router, $, e, next));
  on('session.measure', ($: Any, e: Any, next: Any) => onMeasure(router, $, e, next));
  on('ui.render', ($: Any, e: Any, next: Any) => onRender(router, $, e, next));
  on('session.start', async ($: Any, e: Any, next: Any) => {
    const p: Ports = {
      storeGet: (k) => $.store.get(k),
      storeSet: (k, v) => $.store.set(k, v),
      runCommand: (a) => $.command.run(a),
      compact: (a) => $.session.compact(a),
      submit: (a) => $.prompt.submit(a),
    };
    // AISDLC-1082: every failure `safe()` swallows lands in `hierarchy/log` with the primitive and the text.
    setSwallowSink((line) => log(p, line));
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
    // AISDLC-1061: the name keys the heartbeat file `cli-hierarchy status`, `up` and `doctor` read.
    const named = (await safe(() => $.env.get('AI_SDLC_HIERARCHY_SESSION'))).value;
    const sessionName = typeof named === 'string' && named ? named : role;
    const versionText = typeof version === 'string' ? version : '';
    const health = (h: { state: 'loaded' | 'refused'; reason?: string }): Promise<void> =>
      writeModuleHealth(
        (a) => $.process.run([a.command, ...a.args]),
        options?.boardDir,
        sessionName,
        { ...h, ...(versionText ? { version: versionText } : {}) },
        (k, v) => $.store.set(k, v),
      );
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
            // AISDLC-1082: the heartbeat write depends on it; the host takes an argv list, not { command, args }.
            'process.run': await exists(() => $.process.run('probe'), 'run'),
          };
    const miss = guard(
      version,
      present,
      role === 'operator-dispatch' ? DISPATCH_PRIMITIVES : undefined,
    );
    if (miss) {
      await log(p, miss);
      await health({ state: 'refused', reason: miss });
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
      router.current = 'operator-dispatch';
      dispatch.enabled = true;
      dispatch.sessionName = sessionName;
      if (versionText) dispatch.hostVersion = versionText;
      await health({ state: 'loaded' });
      const tickMs = Number(options?.tickMs) > 0 ? Number(options.tickMs) : DEFAULT_TICK_MS;
      const dp: DispatchPorts = {
        storeGet: (k) => $.store.get(k),
        storeSet: (k, v) => $.store.set(k, v),
        runCommand: (a) => $.command.run(a),
        runProcess: (a) => $.process.run([a.command, ...a.args]),
        send: (a) => $.session.send(a),
        uiOpen: (a) => $.ui.open(a),
      };
      // AISDLC-1064: the tick is the function, the pane is a view. Register the timer before any UI or
      // status call, log every step, and never await a primitive that can hang on the registration path.
      let firstTick = true;
      const run = async (): Promise<void> => {
        if (firstTick) {
          firstTick = false;
          await log(p, `first tick ran at ${new Date().toISOString()}`);
        }
        await tick(dp, dispatch);
      };
      // Host signature (the engine's `every: (ms, fn)`, which throws "takes a function" for a non-function
      // second argument): `$.clock.every(ms, fn)`. The old `{ ms, run }` object was rejected.
      const timer = await attempt(() => $.clock.every(tickMs, run));
      await log(
        p,
        timer === 'ok' ? `tick registered every ${tickMs}` : `tick registration failed ${timer}`,
      );
      // A rotation keeps the last pane in $.store; show it until the first tick replaces it.
      const kept = (await safe(() => dp.storeGet(BOARD_KEY))).value as string[] | undefined;
      if (Array.isArray(kept)) dispatch.pane = kept;
      // Fire and log: a UI open or a status call that never settles must not block the registration path.
      void attempt(() => $.ui.open({ id: 'board', title: 'Dispatch board' })).then((r) =>
        log(p, r === 'ok' ? 'ui.open ok' : `ui.open failed ${r}`),
      );
      void refreshPaneBounded(dp, dispatch).then((r) =>
        log(p, r === 'ok' ? 'refreshPane ok' : `refreshPane failed ${r}`),
      );
      // The first tick runs at once so a pending rotate request is consumed within seconds of `up`.
      if (timer === 'ok') void attempt(run);
      return next(e);
    }
    if (role === 'planner') {
      await health({ state: 'loaded' });
      // The roster name keys the stored last reply; the launcher sets it, the role is the fallback.
      planner.name = typeof named === 'string' && named ? named : 'planner';
      router.current = 'planner';
      planner.enabled = true;
      if (planner.resumePending) await resumeAfterClear(p, planner);
      await log(p, 'registered role=planner');
      return next(e);
    }
    if (role !== 'executor') return next(e);
    await health({ state: 'loaded' });
    router.current = 'executor';
    state.enabled = true;
    // INTERIM: if a host fires session.start after a mod-run clear, resume from here as well.
    if (state.resumePending) await resumeAfterClear(p, state);
    await log(p, 'registered role=executor');
    return next(e);
  });
};
