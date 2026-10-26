import { register } from '../../../hooks/hierarchy/register.tsx';

// AISDLC-1081: the real host throws on any on() made after register() returned. Every hierarchy test
// registers through this stub so a late on() fails the test instead of the live session.
export function registerStrict(options: any = {}): Map<string, any> {
  const handlers = new Map<string, any>();
  let open = true;
  register((n: string, h: any) => {
    if (!open)
      throw new Error(
        `on("${n}") after register() returned: on() is for register(); a hook may not register hooks`,
      );
    handlers.set(n, h);
  }, options);
  open = false;
  return handlers;
}
