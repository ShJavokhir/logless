import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  distDir: process.env.LOGLESS_BUILD_DIR ?? ".next",
  async rewrites() {
    const origin = process.env.LOGLESS_API_ORIGIN ?? "https://144-202-110-2.sslip.io";
    return [{ source: "/api/:path*", destination: `${origin.replace(/\/$/, "")}/api/:path*` }];
  },
};

export default nextConfig;
