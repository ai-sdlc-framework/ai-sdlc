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

type Any = any;

export const register = (on: Any, options?: Any): void => {
  let armed = false;
  const state: ExecutorState = { active: false, pendingRotate: false, lastReply: '' };

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
    const present = {
      'prompt.submit': await exists(() => $.prompt.submit('probe'), 'submit'),
      'command.run': await exists(() => $.command.run('probe'), 'run'),
      'session.compact': await exists(() => $.session.compact('probe'), 'compact'),
      'session.measure': await exists(() => $.session.usage(), 'usage'),
      'session.send': await exists(() => $.session.send('probe'), 'send'),
    };
    const miss = guard(version, present);
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
