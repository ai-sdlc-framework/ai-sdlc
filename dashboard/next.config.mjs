/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@ai-sdlc/orchestrator'],
};

export default nextConfig;
