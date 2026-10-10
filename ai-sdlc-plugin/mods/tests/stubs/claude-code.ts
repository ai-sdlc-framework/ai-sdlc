/** Test stub for the host `claude-code` module: atoms are plain keyed cells. */
export type Atom<T> = { key: string; init: T };

export function atom<T>(id: { plugin: string; key: string }, init: T): Atom<T> {
  return { key: `${id.plugin}/${id.key}`, init };
}

export type Ctx = { store: Map<string, unknown> };

export async function read<T>($: Ctx, a: Atom<T>): Promise<T> {
  return ($.store.has(a.key) ? $.store.get(a.key) : a.init) as T;
}

export async function update<T>($: Ctx, a: Atom<T>, fn: (v: T) => T): Promise<void> {
  $.store.set(a.key, fn(await read($, a)));
}
