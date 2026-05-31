import { createRequire } from 'node:module';

// `@ai-sdlc-enterprise/dashboard` is an OPTIONAL enterprise package. OSS builds
// (and CI) do not install it; the analytics routes/pages reference it via
// `await import()` wrapped in try/catch with an "Enterprise feature" fallback
// (see src/app/analytics/* + src/app/api/analytics/*). Listing it unconditionally
// in `transpilePackages` forces Next/webpack to RESOLVE it at build time, so
// `next build` fails with "Module not found" whenever it isn't installed —
// which breaks CI for any PR that touches the dashboard.
//
// Detect whether it's actually installed and adapt:
//   - installed → transpile it (full enterprise build, unchanged behavior)
//   - absent    → mark it a server-external so webpack does NOT resolve it at
//                 build time. At runtime the `import()` rejects and the existing
//                 try/catch renders the fallback UI.
const require = createRequire(import.meta.url);
let enterpriseInstalled = true;
try {
  require.resolve('@ai-sdlc-enterprise/dashboard');
} catch {
  enterpriseInstalled = false;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: [
    '@ai-sdlc/orchestrator',
    ...(enterpriseInstalled ? ['@ai-sdlc-enterprise/dashboard'] : []),
  ],
  ...(enterpriseInstalled ? {} : { serverExternalPackages: ['@ai-sdlc-enterprise/dashboard'] }),
};

export default nextConfig;
