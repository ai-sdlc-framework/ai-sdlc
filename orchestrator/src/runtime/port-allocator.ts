/**
 * Deterministic port allocator for git worktrees.
 *
 * `deterministicPort` maps an absolute worktree path to a port number in a fixed
 * 900-port range (DEFAULT_BASE_PORT + PORT_RANGE_OFFSET_MIN … PORT_RANGE_OFFSET_MAX)
 * by hashing the path with MD5 and taking the first two bytes modulo the range span.
 *
 * **Hash-collision caveat**: the 900-port range is finite. When multiple worktree paths
 * are fed through `deterministicPort` in a single test, birthday-paradox collisions are
 * possible. For n=3 paths the probability is roughly (n*(n-1)/2) / span ≈ 0.33%. Over
 * thousands of CI runs this causes spurious "distinct ports" assertion failures.
 *
 * **Integration-test guidance**: do NOT assert `new Set(ports).size === n` unless the
 * test controls the exact path strings and has pre-verified they hash to distinct values.
 * Instead assert:
 *   - each port is in [DEFAULT_BASE_PORT + PORT_RANGE_OFFSET_MIN, DEFAULT_BASE_PORT + PORT_RANGE_OFFSET_MAX]
 *   - calling allocatePort twice for the same path returns the same value (idempotency)
 *   - ports[i] === deterministicPort(h.path) (the core deterministic-port property)
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createServer } from 'node:net';

export const DEFAULT_BASE_PORT = 3190;
export const PORT_RANGE_OFFSET_MIN = 100;
export const PORT_RANGE_OFFSET_MAX = 999;
const PORT_RANGE_SPAN = PORT_RANGE_OFFSET_MAX - PORT_RANGE_OFFSET_MIN + 1;
const COLLISION_PROBE_ATTEMPTS = 10;

export interface AllocatePortOptions {
  basePort?: number;
  envOverride?: string | undefined;
  isPortFree?: (port: number) => Promise<boolean>;
}

export interface AllocateContiguousOptions extends AllocatePortOptions {
  count: number;
}

export class PortAllocationError extends Error {
  constructor(
    message: string,
    public readonly worktreePath: string,
    public readonly attemptedPorts: number[],
  ) {
    super(message);
    this.name = 'PortAllocationError';
  }
}

/**
 * Derive a deterministic port for `worktreePath` by hashing its absolute form with MD5
 * and mapping the first two bytes into [basePort + PORT_RANGE_OFFSET_MIN,
 * basePort + PORT_RANGE_OFFSET_MAX].
 *
 * **Collision risk**: the output space is only 900 ports wide. When called with multiple
 * independent (e.g. mkdtemp-generated) paths, two or more paths may map to the same port.
 * For n=3 paths the birthday probability is ~0.33%. Integration tests that need to assert
 * port distinctness MUST use pre-chosen, manually-verified paths rather than random
 * temporaries — see the module-level JSDoc for the recommended assertion pattern.
 */
export function deterministicPort(
  worktreePath: string,
  basePort: number = DEFAULT_BASE_PORT,
): number {
  const absolute = resolve(worktreePath);
  const digest = createHash('md5').update(absolute).digest();
  const offset = (((digest[0] << 8) | digest[1]) % PORT_RANGE_SPAN) + PORT_RANGE_OFFSET_MIN;
  return basePort + offset;
}

export async function allocatePort(
  worktreePath: string,
  options: AllocatePortOptions = {},
): Promise<number> {
  const envValue = options.envOverride;
  if (envValue !== undefined && envValue !== '') {
    const parsed = Number.parseInt(envValue, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
      throw new PortAllocationError(
        `PORT environment override is not a valid TCP port: ${envValue}`,
        worktreePath,
        [],
      );
    }
    return parsed;
  }

  const basePort = options.basePort ?? DEFAULT_BASE_PORT;
  const start = deterministicPort(worktreePath, basePort);
  const probe = options.isPortFree ?? isPortFree;
  const attempted: number[] = [];

  for (let i = 0; i < COLLISION_PROBE_ATTEMPTS; i++) {
    const candidate = start + i;
    attempted.push(candidate);
    if (await probe(candidate)) {
      return candidate;
    }
  }

  throw new PortAllocationError(
    `No free port found after ${COLLISION_PROBE_ATTEMPTS} attempts starting at ${start}`,
    worktreePath,
    attempted,
  );
}

export async function allocateContiguousPorts(
  worktreePath: string,
  options: AllocateContiguousOptions,
): Promise<number[]> {
  if (options.count < 1 || options.count > 10) {
    throw new PortAllocationError(
      `Contiguous port count must be between 1 and 10 (got ${options.count})`,
      worktreePath,
      [],
    );
  }

  const first = await allocatePort(worktreePath, options);
  return Array.from({ length: options.count }, (_, i) => first + i);
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const server = createServer();
    server.once('error', () => {
      resolveProbe(false);
    });
    server.once('listening', () => {
      server.close(() => resolveProbe(true));
    });
    server.listen(port, '127.0.0.1');
  });
}
