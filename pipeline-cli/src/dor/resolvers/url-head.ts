/**
 * URL HEAD resolver. Handles arbitrary `https?://` references that
 * aren't recognised by the github-issue resolver.
 *
 * Resolution: issues a HEAD request via `fetch`. Tests inject a fake
 * `fetchImpl`; production defaults to the global `fetch`. A 2xx OR 3xx
 * status counts as resolved (some servers reject HEAD with a 405 →
 * fallback to GET).
 *
 * RFC-0011 §13 Q2 — pluggable resolver registry. This is the URL HEAD
 * resolver; sister resolvers handle GitHub issues and file existence.
 */

import type { Reference, ResolveResult, Resolver, ResolverOpts } from '../types.js';

const HTTP_RE = /^https?:\/\//i;

export const urlHeadResolver: Resolver = {
  name: 'url',
  supports(ref: Reference): boolean {
    if (ref.kind === 'url') return true;
    if (ref.kind === 'github-issue' || ref.kind === 'file-existence') return false;
    return HTTP_RE.test(ref.raw.trim());
  },
  async resolve(ref: Reference, opts: ResolverOpts): Promise<ResolveResult> {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
      return { ref, resolved: false, reason: 'no fetch implementation available' };
    }
    const url = ref.raw.trim();
    const timeoutMs = opts.timeoutMs ?? 5_000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetchImpl(url, { method: 'HEAD', signal: controller.signal });
      } catch (err) {
        return {
          ref,
          resolved: false,
          reason: `HEAD ${url} threw: ${(err as Error).message}`,
        };
      }
      // Some servers refuse HEAD; retry with GET.
      if (res.status === 405 || res.status === 501) {
        try {
          res = await fetchImpl(url, { method: 'GET', signal: controller.signal });
        } catch (err) {
          return { ref, resolved: false, reason: `GET fallback threw: ${(err as Error).message}` };
        }
      }
      if (res.status >= 200 && res.status < 400) {
        return { ref, resolved: true };
      }
      return { ref, resolved: false, reason: `HTTP ${res.status}` };
    } finally {
      clearTimeout(timer);
    }
  },
};
