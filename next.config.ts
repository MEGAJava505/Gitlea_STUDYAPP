import type { NextConfig } from 'next';

/**
 * Next.js App Router skeleton.
 *
 * The foundation placeholder keeps configuration minimal. Route handlers under
 * `src/app/api` are the only server surface added in Phase 0/1; product routes
 * are added by later tasks and must not reach into Gitea or the database
 * directly (they depend on the interfaces exported by Tasks A/B/C).
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Local/dev deployments are served over plain HTTP behind the Caddy proxy.
  // Production certificate handling is owned by the reverse proxy (PROXY_HTTPS_PORT);
  // the app itself does not terminate TLS.
  output: 'standalone',
  experimental: { authInterrupts: true },
};

export default nextConfig;
