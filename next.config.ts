import type { NextConfig } from "next";

/**
 * En-têtes de sécurité. La Content-Security-Policy, qui a besoin d'un nonce différent à chaque
 * requête, est posée par src/proxy.ts. Flexstaff est un outil interne : jamais indexé.
 */
const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex" },
        ],
      },
      {
        // Scanner des QR codes des récompenses
        source: "/staff",
        headers: [{ key: "Permissions-Policy", value: "camera=(self)" }],
      },
    ];
  },
};

export default nextConfig;
