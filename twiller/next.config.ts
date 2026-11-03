import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // The repository root also contains a package-lock.json (created beside the
  // backend/, outside twiller/), so Next.js walks UP from twiller/ and finds
  // more than one lockfile. It then infers the REPO ROOT as the workspace root
  // and prints the "multiple lockfiles" warning. Pinning the tracing root to
  // that same repository root makes the choice explicit, silences the warning,
  // and leaves dependency tracing identical. No lockfile, dependency, manifest
  // or Next.js version is changed.
  outputFileTracingRoot: path.join(__dirname, ".."),
  env: {
    BACKEND_URL: process.env.BACKEND_URL,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
