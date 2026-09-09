import dotenv from 'dotenv';

dotenv.config();

function intFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeIntFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function boundedIntFromEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  const normalized = Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, normalized));
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value !== 'false' && value !== '0';
}

function listFromEnv(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function originListFromEnv(name: string, fallback: string): string[] {
  const raw = process.env[name] || fallback;
  return raw
    .split(',')
    .map((value) => normalizeOrigin(value))
    .filter(Boolean);
}

function normalizeOrigin(value: string): string {
  const cleanValue = value.trim();
  if (!cleanValue) return '';
  if (cleanValue === '*') return '*';
  try {
    const parsed = new URL(cleanValue);
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return cleanValue.replace(/\/+$/, '').toLowerCase();
  }
}

export function isPublicOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  if (env.publicOrigins.includes('*')) return true;
  return env.publicOrigins.includes(normalizeOrigin(origin));
}

const roomReconnectGraceMs = intFromEnv('ROOM_RECONNECT_GRACE_MS', 2 * 60 * 1000);
const roomHostReconnectGraceMs = Math.min(
  roomReconnectGraceMs,
  intFromEnv('ROOM_HOST_RECONNECT_GRACE_MS', 60 * 1000),
);
const roomStoreMaxBytes = boundedIntFromEnv('ROOM_STORE_MAX_BYTES', 64 * 1024 * 1024, 1024 * 1024, 256 * 1024 * 1024);
const roomStoreMaxRoomBytes = boundedIntFromEnv(
  'ROOM_STORE_MAX_ROOM_BYTES',
  3 * 1024 * 1024,
  256 * 1024,
  Math.min(8 * 1024 * 1024, roomStoreMaxBytes - 4096),
);
const roomStoreMaxRooms = boundedIntFromEnv('ROOM_STORE_MAX_ROOMS', 500, 20, 2000);
const roomMaxActiveByStore = Math.max(1, Math.floor((roomStoreMaxBytes - 4096) / (roomStoreMaxRoomBytes + 2)));
const roomMaxMembers = boundedIntFromEnv('ROOM_MAX_MEMBERS', 20, 1, 100);

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: intFromEnv('PORT', 3000),
  trustProxyHops: nonNegativeIntFromEnv('TRUST_PROXY_HOPS', 2),
  publicOrigin: process.env.PUBLIC_ORIGIN || '*',
  publicOrigins: originListFromEnv('PUBLIC_ORIGIN', '*'),
  parseTimeoutMs: intFromEnv('PARSE_TIMEOUT_MS', 12000),
  parseProbeTimeoutMs: intFromEnv('PARSE_PROBE_TIMEOUT_MS', 5000),
  parseProbeMaxCandidates: intFromEnv('PARSE_PROBE_MAX_CANDIDATES', 3),
  parseMaxConcurrentPerClient: intFromEnv('PARSE_MAX_CONCURRENT_PER_CLIENT', 2),
  parseMaxConcurrentTotal: intFromEnv('PARSE_MAX_CONCURRENT_TOTAL', 16),
  parseMaxResponseBytes: intFromEnv('PARSE_MAX_RESPONSE_BYTES', 2 * 1024 * 1024),
  parseCacheTtlMs: intFromEnv('PARSE_CACHE_TTL_MS', 10 * 60 * 1000),
  bilibiliEnabled: boolFromEnv('BILIBILI_ENABLED', true),
  bilibiliTimeoutMs: intFromEnv('BILIBILI_TIMEOUT_MS', 12_000),
  bilibiliRateLimitPerMinute: nonNegativeIntFromEnv('BILIBILI_RATE_LIMIT_PER_MINUTE', 20),
  bilibiliDanmakuMaxItems: intFromEnv('BILIBILI_DANMAKU_MAX_ITEMS', 3000),
  bilibiliDanmakuMaxResponseBytes: intFromEnv('BILIBILI_DANMAKU_MAX_RESPONSE_BYTES', 8 * 1024 * 1024),
  bilibiliCacheTtlMs: intFromEnv('BILIBILI_CACHE_TTL_MS', 10 * 60 * 1000),
  hlsProxyEnabled: boolFromEnv('HLS_PROXY_ENABLED', true),
  hlsProxyTimeoutMs: intFromEnv('HLS_PROXY_TIMEOUT_MS', 30000),
  hlsProxyRateLimitPerMinute: nonNegativeIntFromEnv('HLS_PROXY_RATE_LIMIT_PER_MINUTE', 120),
  hlsProxyMaxConcurrentPerClient: intFromEnv('HLS_PROXY_MAX_CONCURRENT_PER_CLIENT', 8),
  hlsProxyMaxConcurrentTotal: intFromEnv('HLS_PROXY_MAX_CONCURRENT_TOTAL', 64),
  hlsProxyAllowedHosts: listFromEnv('HLS_PROXY_ALLOWED_HOSTS'),
  mediaProxyTokenTtlMs: intFromEnv('MEDIA_PROXY_TOKEN_TTL_MS', 6 * 60 * 60 * 1000),
  mediaProxyTokenMaxActive: intFromEnv('MEDIA_PROXY_TOKEN_MAX_ACTIVE', 50_000),
  proxyUserAgent: process.env.PROXY_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  roomStoreEnabled: boolFromEnv('ROOM_STORE_ENABLED', true),
  roomStoreFile: process.env.ROOM_STORE_FILE || 'data/rooms.json',
  roomStoreWriteDelayMs: intFromEnv('ROOM_STORE_WRITE_DELAY_MS', 800),
  roomStoreShutdownTimeoutMs: boundedIntFromEnv('ROOM_STORE_SHUTDOWN_TIMEOUT_MS', 20_000, 5_000, 60_000),
  roomStoreMaxBytes,
  roomStoreMaxRoomBytes,
  roomStoreMaxRooms,
  roomMaxMembers,
  roomMaxReconnectEntries: boundedIntFromEnv('ROOM_MAX_RECONNECT_ENTRIES', 100, roomMaxMembers, 500),
  roomMaxActive: boundedIntFromEnv('ROOM_MAX_ACTIVE', 20, 1, Math.min(roomStoreMaxRooms, roomMaxActiveByStore)),
  roomCreateRateLimitPerMinute: nonNegativeIntFromEnv('ROOM_CREATE_RATE_LIMIT_PER_MINUTE', 10),
  roomMaxPlaylistItems: boundedIntFromEnv('ROOM_MAX_PLAYLIST_ITEMS', 200, 1, 500),
  roomMaxKickedEntries: boundedIntFromEnv('ROOM_MAX_KICKED_ENTRIES', 400, 20, 2000),
  roomEmptyTtlMs: intFromEnv('ROOM_EMPTY_TTL_MS', 2 * 60 * 60 * 1000),
  roomReconnectGraceMs,
  roomHostReconnectGraceMs,
  parseRateLimitPerMinute: nonNegativeIntFromEnv('PARSE_RATE_LIMIT_PER_MINUTE', 30),
};
