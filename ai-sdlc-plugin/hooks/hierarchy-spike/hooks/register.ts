// RFC-0058 phase 0 spike (AISDLC-1033). Inert unless AI_SDLC_HIERARCHY_SPIKE=1.
// Every hook appends one JSON line to the $.store list below (dumped to .ai-sdlc/hierarchy-spike.log). Control messages
// (received text) drive the experiments:
//   hier:consume       -> session.receive returns { consumed } (model must stay silent)
//   hier:run clear     -> store a marker, $.command.run clear, then (next session.start) submit /hier-ping
//   hier:run compact   -> same sequence with $.session.compact (fallback when clear drops)
//   hier:relay-bench   -> not consumed: the model relays (baseline for the saving measurement)
type Any = any;

export const MARKER_KEY = 'hierarchy-spike/marker';
export const PENDING_KEY = 'hierarchy-spike/pending';

export function spikeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AI_SDLC_HIERARCHY_SPIKE === '1';
}

// A hooks module may import only relative files and "claude-code" (claude plugin validate
// refuses node:fs) and may never pass `$` around, so there is no shared sink: each call site
// appends a line to a $.store list (`await $.store.set(STORE_LOG_KEY, [...])`) that the
// operator dumps after the run. No file API is assumed; that gap is an upstream finding.
export const STORE_LOG_KEY = 'hierarchy-spike/log';
export function line(event: string, data: Record<string, unknown> = {}): string {
  return JSON.stringify({ t: new Date().toISOString(), event, ...data });
}

async function safe<T>(
  fn: () => Promise<T> | T,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// A `{ drop }` result means the host refused the call; record the reason.
function outcome(r: Any): Record<string, unknown> {
  if (!r.ok) return { ran: false, threw: r.error };
  const v = r.value as Any;
  if (v && typeof v === 'object' && 'drop' in v) return { ran: false, drop: v.drop };
  return { ran: true };
}

export const register = (on: Any): void => {
  if (!spikeEnabled()) return;

  on('session.start', async ($: Any, e: Any, next: Any) => {
    // A second module_loaded after a clear means the module reloaded.
    await $.store.set(STORE_LOG_KEY, [
      ...((await $.store.get(STORE_LOG_KEY)) ?? []),
      line('module_loaded', { reason: e?.reason ?? null }),
    ]);
    const id = await safe(() => $.session.id());
    const marker = await safe(() => $.store.get(MARKER_KEY));
    const pending = await safe(() => $.store.get(PENDING_KEY));
    await $.store.set(STORE_LOG_KEY, [
      ...((await $.store.get(STORE_LOG_KEY)) ?? []),
      line('session.start', {
        sessionId: id.ok ? id.value : null,
        reason: e?.reason ?? null,
        storeMarkerSurvived: marker.ok && marker.value != null,
        storeMarker: marker.ok ? (marker.value ?? null) : null,
      }),
    ]);
    if (pending.ok && pending.value) {
      const step = String(pending.value);
      await safe(() => $.store.set(PENDING_KEY, null));
      const r = await safe(() => $.prompt.submit({ text: '/hier-ping' }));
      await $.store.set(STORE_LOG_KEY, [
        ...((await $.store.get(STORE_LOG_KEY)) ?? []),
        line('prompt.submit', { after: step, ...outcome(r) }),
      ]);
    }
    return next(e);
  });

  on('turn.start', async ($: Any, e: Any, next: Any) => {
    await $.store.set(STORE_LOG_KEY, [
      ...((await $.store.get(STORE_LOG_KEY)) ?? []),
      line('turn.start', { turnId: e?.turnId ?? null, text: e?.text ?? null }),
    ]);
    return next(e);
  });

  on('turn.complete', async ($: Any, e: Any, next: Any) => {
    await $.store.set(STORE_LOG_KEY, [
      ...((await $.store.get(STORE_LOG_KEY)) ?? []),
      line('turn.complete', {
        turnId: e?.turnId ?? null,
        reason: e?.reason ?? null,
        usage: e?.usage ?? null,
      }),
    ]);
    return next(e);
  });

  on('session.measure', async ($: Any, e: Any, next: Any) => {
    await $.store.set(STORE_LOG_KEY, [
      ...((await $.store.get(STORE_LOG_KEY)) ?? []),
      line('session.measure', { measure: e ?? null }),
    ]);
    return next(e);
  });

  on('session.end', async ($: Any, e: Any, next: Any) => {
    await $.store.set(STORE_LOG_KEY, [
      ...((await $.store.get(STORE_LOG_KEY)) ?? []),
      line('session.end', { reason: e?.reason ?? null }),
    ]);
    return next(e);
  });

  on('session.receive', async ($: Any, e: Any, next: Any) => {
    const text = String(e?.text ?? '');
    await $.store.set(STORE_LOG_KEY, [
      ...((await $.store.get(STORE_LOG_KEY)) ?? []),
      line('session.receive', { origin: e?.origin ?? null, text }),
    ]);

    if (text.startsWith('hier:consume')) {
      await $.store.set(STORE_LOG_KEY, [
        ...((await $.store.get(STORE_LOG_KEY)) ?? []),
        line('session.receive.consumed', { returned: 'consumed' }),
      ]);
      return { consumed: true };
    }

    const run = /^hier:run (clear|compact)/.exec(text);
    if (run) {
      const how = run[1];
      await safe(() => $.store.set(MARKER_KEY, `written-before-${how}`));
      await safe(() => $.store.set(PENDING_KEY, how));
      const r =
        how === 'clear'
          ? await safe(() => $.command.run({ command: 'clear' }))
          : await safe(() => $.session.compact({ instructions: 'spike' }));
      await $.store.set(STORE_LOG_KEY, [
        ...((await $.store.get(STORE_LOG_KEY)) ?? []),
        line(`${how}.result`, outcome(r)),
      ]);
      return { consumed: true };
    }

    return next(e);
  });
};
