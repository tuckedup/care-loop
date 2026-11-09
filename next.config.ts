import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/**
 * Content-Security-Policy. Next.js App Router emits inline bootstrap scripts, so without a
 * nonce-issuing middleware `script-src` must allow 'unsafe-inline' (dev also needs 'unsafe-eval' for
 * React refresh). That is the weakest part of this policy; everything else is locked down:
 * same-origin connections, no plugins, no framing, same-origin form posts and base URI.
 *
 * Set CSP_REPORT_ONLY=true at build time to ship the same policy as Content-Security-Policy-Report-Only
 * (observe, do not block) if a deployment ever needs to loosen it.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isProd ? "" : " ws: wss:"}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  {
    key:
      process.env.CSP_REPORT_ONLY === "true"
        ? "Content-Security-Policy-Report-Only"
        : "Content-Security-Policy",
    value: csp,
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  devIndicators: false,
  // Concurrent dev servers/e2e runs must not share a build cache: set NEXT_DIST_DIR (e.g. .next-ui).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Container builds set NEXT_OUTPUT=standalone to trace a minimal server; local builds are unchanged.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
  reactStrictMode: true,
  poweredByHeader: false,
  // /admin/evals reads evals/results/*.json at request time; trace them into the serverless bundle.
  outputFileTracingIncludes: {
    "/admin/evals": ["./evals/results/*.json"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
