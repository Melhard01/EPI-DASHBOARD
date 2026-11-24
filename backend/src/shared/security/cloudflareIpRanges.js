/**
 * Cloudflare edge server IP ranges.
 *
 * Used to validate that CF-Connecting-IP headers come from actual Cloudflare
 * infrastructure (not forged by clients) when the deployment mode is
 * cloudflare-proxy or vercel-cloudflare.
 *
 * Updated: 2024
 * Source: https://www.cloudflare.com/ips/
 */

// IPv4 ranges (Cloudflare Anycast edge IPs)
export const CLOUDFLARE_IPV4_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.56.0.0/12',
  '147.75.0.0/16',
  '131.0.72.0/22',
];

// IPv6 ranges (Cloudflare Anycast edge IPs)
export const CLOUDFLARE_IPV6_RANGES = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];
