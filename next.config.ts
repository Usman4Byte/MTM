import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Parsers with Node-only internals stay outside the server bundle.
  serverExternalPackages: ["exceljs", "mammoth"],
};

export default nextConfig;
