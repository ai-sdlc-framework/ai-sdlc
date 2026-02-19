/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@ai-sdlc/orchestrator', '@ai-sdlc-enterprise/dashboard'],
};

export default nextConfig;
