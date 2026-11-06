import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Concurrent dev servers/e2e runs must not share a build cache: set NEXT_DIST_DIR (e.g. .next-ui).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
