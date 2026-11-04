import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Cache Components (and partialPrefetching, which requires it) are off until we
  // settle caching patterns for authenticated, per-workspace pages. See docs/adr when we revisit.
  reactCompiler: true,
  transpilePackages: [
    '@crunch/db',
    '@crunch/crypto',
    '@crunch/authz',
    '@crunch/providers',
    '@crunch/doc-model',
    '@crunch/renderer',
  ],
  serverExternalPackages: ['pg'],
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
