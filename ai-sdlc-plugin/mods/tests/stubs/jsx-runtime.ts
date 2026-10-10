export type El = { type: unknown; props: Record<string, unknown> };

export const Fragment = Symbol('Fragment');

export function jsx(type: unknown, props: Record<string, unknown>, key?: string): El {
  return { type, props: key === undefined ? props : { ...props, key } };
}

export const jsxs = jsx;
export const jsxDEV = jsx;
