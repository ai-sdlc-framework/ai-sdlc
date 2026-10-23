// RFC-0058 phase 1 (AISDLC-1034): the hierarchy hooks module, executor role only.
// Registered through hooks/hooks.json `modules`. It registers one `session.start` gate; the role hooks are
// registered from inside it, so a session with no hierarchy role (or a host below the floor) gets none.
// `$` is only ever spelled `$.noun.verb(...)` here (the validator refuses anything else).
import {
  RESUME_COMMAND,
  ROTATION_KEY,
  guard,
  log,
  pickRole,
  exists,
  registerExecutor,
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
    const carried = (await safe(() => $.store.get(ROTATION_KEY))).value;
    const role = pickRole([
      (await safe(() => $.env.get('HIERARCHY_ROLE'))).value,
      (await safe(() => $.env.get('AI_SDLC_HIERARCHY_ROLE'))).value,
      options?.role,
      carried?.role,
    ]);
    if (!role) return next(e);

    const version = (await safe(() => $.session.version())).value;
    // The validator refuses reading `$.noun.verb` as a value, so each primitive is probed by a call. The
    // payloads are wrong-typed (null fields), never empty or valid, so the host's typed boundary rejects them
    // before any action (no compaction, no blank turn); only a TypeError "not a function" counts as missing.
    const present = {
      'prompt.submit': await exists(() => $.prompt.submit({ text: null })),
      'command.run': await exists(() => $.command.run({ command: null })),
      'session.compact': await exists(() => $.session.compact({ instructions: null })),
      // `session.measure` is an event; its pull-side twin `$.session.usage` stands in for it.
      'session.measure': await exists(() => $.session.usage()),
      'session.send': await exists(() => $.session.send({ to: null, text: null })),
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
    // After a clear the store carries the resume command: start the next executor loop.
    if (carried?.resume) {
      await p.storeSet(ROTATION_KEY, null);
      state.lastReply = String(carried.lastReply ?? '');
      await safe(() => p.submit({ text: carried.resume ?? RESUME_COMMAND }));
    }
    return next(e);
  });
};
