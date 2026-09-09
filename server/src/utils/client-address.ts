import type { IncomingMessage } from 'node:http';
import { env } from '../config/env.js';

function normalizeAddress(value: string): string {
  const address = value.trim().replace(/^\[|\]$/g, '');
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(address)) return address.slice(7);
  return address || 'unknown';
}

/** Mirrors Express' numeric trust-proxy behavior for HTTP and Engine.IO requests. */
export function getTrustedClientAddress(request: IncomingMessage, trustedHops = env.trustProxyHops): string {
  const remoteAddress = normalizeAddress(request.socket.remoteAddress || 'unknown');
  if (trustedHops <= 0) return remoteAddress;

  const forwardedHeader = request.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(forwardedHeader) ? forwardedHeader.join(',') : String(forwardedHeader || ''))
    .split(',')
    .map(normalizeAddress)
    .filter((address) => address !== 'unknown')
    .reverse();
  const chain = [remoteAddress, ...forwarded];
  return chain[Math.min(trustedHops, chain.length - 1)] || remoteAddress;
}
