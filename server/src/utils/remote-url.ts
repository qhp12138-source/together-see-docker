import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^0\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^::1$/,
  /^\[?::1\]?$/,
];

function hostMatchesAllowedPattern(hostname: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === pattern;
}

function normalizeIpAddress(address: string): string {
  return String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
}

export function isBlockedRemoteIpAddress(rawAddress: string): boolean {
  const address = normalizeIpAddress(rawAddress);
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split('.').map(Number);
    const [a, b, c] = parts;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  }
  if (version === 6) {
    if (address.startsWith('::ffff:')) return isBlockedRemoteIpAddress(address.slice(7));
    return address === '::'
      || address === '::1'
      || address.startsWith('fc')
      || address.startsWith('fd')
      || /^fe[89ab]/.test(address)
      || address.startsWith('ff')
      || address.startsWith('2001:db8:');
  }
  return true;
}

export function assertPublicHttpUrl(rawUrl: string, allowedHosts: string[] = []): URL {
  const value = String(rawUrl || '').trim();
  if (!value) throw new Error('缺少 url 参数');

  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('仅支持 http / https 链接');
  }
  if (url.username || url.password) {
    throw new Error('链接不能包含用户名或密码');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname.endsWith('.local') || PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) {
    throw new Error('出于安全原因，不允许访问本机或内网地址');
  }
  if (allowedHosts.length > 0 && !allowedHosts.some((pattern) => hostMatchesAllowedPattern(hostname, pattern))) {
    throw new Error('目标不在允许的主机白名单中');
  }
  return url;
}

export async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const cleanHostname = normalizeIpAddress(hostname);
  const literalFamily = isIP(cleanHostname);
  const addresses = literalFamily
    ? [{ address: cleanHostname, family: literalFamily }]
    : await dnsLookup(cleanHostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isBlockedRemoteIpAddress(entry.address))) {
    throw new Error('目标解析到了内网或保留地址');
  }
  const selected = addresses.find((entry) => entry.family === 4) || addresses[0];
  return { address: selected.address, family: selected.family as 4 | 6 };
}
