import type { NextConfig } from 'next';

/**
 * The frontend is a pure client of the backend API -- nothing is proxied through
 * Next. That means CORS and credentialed cookies are exercised exactly as they
 * would be with the two services deployed on separate hosts, rather than being
 * masked by a dev-only rewrite that would then need rewriting for production.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The floating dev badge sits on top of the sidebar footer. Turning it off
  // keeps the dev UI identical to production.
  devIndicators: false,
};

export default nextConfig;
