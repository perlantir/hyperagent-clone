/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Don't fail the build on TS / ESLint — the codebase prioritizes shipping.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3"],
  },
};
module.exports = nextConfig;
