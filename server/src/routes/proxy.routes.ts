import crypto from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { env } from '../config/env.js';
import { isVerifiedDirectMediaUrl } from '../services/parser.service.js';
import { getTrustedClientAddress } from '../utils/client-address.js';
import { BoundedSlidingWindowRateLimiter } from '../utils/rate-limit.js';
import { assertPublicHttpUrl, isBlockedRemoteIpAddress, resolvePublicAddress } from '../utils/remote-url.js';
import { diagnosticFingerprint, elapsedBucket, logStructuredEvent } from '../utils/structured-log.js';

const HLS_PROXY_RATE_WINDOW_MS = 60_000;
const MAX_PROXY_REDIRECTS = 5;
const MAX_PROXY_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_PROXY_TOKEN_LENGTH = 160;
const MAX_PROXY_GRANTS_PER_SESSION = Math.min(1024, env.mediaProxyTokenMaxActive);
const MAX_PROXY_GRANTS_PER_CLIENT = Math.min(2048, env.mediaProxyTokenMaxActive);
const MAX_PROXY_GRANTS_PER_ROOM = Math.max(
  4,
  Math.floor((env.mediaProxyTokenMaxActive * 0.8) / Math.max(1, env.roomMaxActive)),
);
const MAX_HLS_REWRITTEN_TARGETS = Math.min(900, Math.max(1, MAX_PROXY_GRANTS_PER_SESSION - 1));
export const mediaProxyGrantLimits = Object.freeze({
  perSession: MAX_PROXY_GRANTS_PER_SESSION,
  perClient: MAX_PROXY_GRANTS_PER_CLIENT,
  perRoom: MAX_PROXY_GRANTS_PER_ROOM,
  perHlsManifest: MAX_HLS_REWRITTEN_TARGETS,
});
const hlsProxyRateLimiter = new BoundedSlidingWindowRateLimiter();
const activeProxyRequests = new Map<string, number>();
let activeProxyRequestTotal = 0;

type ProxyRouteName = 'hls' | 'media';

interface MediaProxyGrant {
  routeName: ProxyRouteName;
  targetUrl: string;
  refUrl: string;
  expiresAt: number;
  allowUnlistedPublicTargets: boolean;
  sessionId: string;
  clientBinding: string;
  clientQuotaKey: string;
  roomCode: string;
  parentToken: string | null;
}

interface MediaProxyGrantResult {
  proxyUrl: string;
  expiresAt: number;
}

interface MediaProxyGrantOptions {
  allowVerifiedDirect?: boolean;
  sessionId?: string;
}

interface MediaProxySession {
  roomCode: string;
  memberId: string;
  clientBinding: string;
  clientQuotaKey: string;
  expiresAt: number | null;
}

export interface PublicMediaGrantFailure {
  code: 'parse_option_missing' | 'parse_option_disabled' | 'parse_authorization_busy'
    | 'parse_source_denied' | 'parse_authorization_failed';
  message: string;
}

const mediaProxyGrants = new Map<string, MediaProxyGrant>();
const mediaProxySessions = new Map<string, MediaProxySession>();
const activeProxyControllersBySession = new Map<string, Set<AbortController>>();
const mediaProxyGrantTokensBySession = new Map<string, Set<string>>();
const mediaProxyGrantTokensByKey = new Map<string, Map<string, string>>();
const mediaProxyGrantCountsByClient = new Map<string, number>();
const mediaProxyGrantCountsByRoom = new Map<string, number>();
const mediaProxyGrantChildrenByParent = new Map<string, Set<string>>();
const mediaProxyGrantCurrentChildrenByParent = new Map<string, Set<string>>();
const mediaProxyGrantPreviousChildrenByParent = new Map<string, Set<string>>();
let nextProxyGrantCleanupAt = 0;

export function createMediaProxyClientBinding(clientAddress: string, userAgent: string): string {
  const normalizedAddress = String(clientAddress || 'unknown').trim();
  const addressDigest = crypto.createHash('sha256').update(normalizedAddress).digest('hex');
  const bindingDigest = crypto.createHash('sha256')
    .update(`${normalizedAddress}\n${String(userAgent || '').slice(0, 512)}`)
    .digest('hex');
  return `${addressDigest}.${bindingDigest}`;
}

function adjustGrantCount(counts: Map<string, number>, key: string, delta: number): void {
  const next = Math.max(0, (counts.get(key) || 0) + delta);
  if (next === 0) counts.delete(key);
  else counts.set(key, next);
}

function deleteMediaProxyGrant(token: string, visited = new Set<string>()): void {
  if (visited.has(token)) return;
  visited.add(token);
  for (const childToken of [...(mediaProxyGrantChildrenByParent.get(token) || [])]) {
    deleteMediaProxyGrant(childToken, visited);
  }
  mediaProxyGrantChildrenByParent.delete(token);
  mediaProxyGrantCurrentChildrenByParent.delete(token);
  mediaProxyGrantPreviousChildrenByParent.delete(token);
  const grant = mediaProxyGrants.get(token);
  if (!grant) return;
  mediaProxyGrants.delete(token);
  adjustGrantCount(mediaProxyGrantCountsByClient, grant.clientQuotaKey, -1);
  adjustGrantCount(mediaProxyGrantCountsByRoom, grant.roomCode, -1);
  const tokens = mediaProxyGrantTokensBySession.get(grant.sessionId);
  tokens?.delete(token);
  if (tokens?.size === 0) mediaProxyGrantTokensBySession.delete(grant.sessionId);
  const keyMap = mediaProxyGrantTokensByKey.get(grant.sessionId);
  for (const [key, mappedToken] of keyMap || []) {
    if (mappedToken === token) keyMap?.delete(key);
  }
  if (keyMap?.size === 0) mediaProxyGrantTokensByKey.delete(grant.sessionId);
  if (grant.parentToken) {
    for (const childMap of [
      mediaProxyGrantChildrenByParent,
      mediaProxyGrantCurrentChildrenByParent,
      mediaProxyGrantPreviousChildrenByParent,
    ]) {
      const siblings = childMap.get(grant.parentToken);
      siblings?.delete(token);
      if (siblings?.size === 0) childMap.delete(grant.parentToken);
    }
  }
}

function createProxyGrantKey(
  routeName: ProxyRouteName,
  targetUrl: string,
  refUrl: string,
  allowUnlistedPublicTargets: boolean,
  parentToken = '',
): string {
  return JSON.stringify([routeName, targetUrl, refUrl, allowUnlistedPublicTargets, parentToken]);
}

function getReusableProxyGrantToken(sessionId: string, grantKey: string, now = Date.now()): string | null {
  const token = mediaProxyGrantTokensByKey.get(sessionId)?.get(grantKey) || '';
  const grant = token ? mediaProxyGrants.get(token) : null;
  if (grant && grant.expiresAt > now) return token;
  if (token) deleteMediaProxyGrant(token);
  return null;
}

export function getMediaProxyGrantUsage(sessionId: string): {
  session: number;
  client: number;
  room: number;
  global: number;
} {
  const session = mediaProxySessions.get(sessionId);
  return {
    session: mediaProxyGrantTokensBySession.get(sessionId)?.size || 0,
    client: session ? mediaProxyGrantCountsByClient.get(session.clientQuotaKey) || 0 : 0,
    room: session ? mediaProxyGrantCountsByRoom.get(session.roomCode) || 0 : 0,
    global: mediaProxyGrants.size,
  };
}

function removeMediaProxySessionGrants(sessionId: string): void {
  if (!sessionId) return;
  for (const token of [...(mediaProxyGrantTokensBySession.get(sessionId) || [])]) deleteMediaProxyGrant(token);
}

export function registerMediaProxySession(
  sessionId: string,
  roomCode: string,
  memberId: string,
  clientBinding: string,
): void {
  if (!sessionId || !roomCode || !memberId || !clientBinding) throw new Error('媒体代理会话参数无效');
  for (const [existingSessionId, session] of mediaProxySessions.entries()) {
    if (existingSessionId === sessionId) continue;
    if (session.roomCode === roomCode && session.memberId === memberId) {
      revokeMediaProxySession(existingSessionId);
    }
  }
  const clientQuotaKey = clientBinding.split('.', 1)[0] || clientBinding;
  mediaProxySessions.set(sessionId, { roomCode, memberId, clientBinding, clientQuotaKey, expiresAt: null });
}

export function suspendMediaProxySession(sessionId: string, graceMs: number): void {
  const session = mediaProxySessions.get(sessionId);
  if (!session) return;
  const expiresAt = Date.now() + Math.max(0, graceMs);
  session.expiresAt = expiresAt;
  const timer = setTimeout(() => {
    const latest = mediaProxySessions.get(sessionId);
    if (latest?.expiresAt === expiresAt && expiresAt <= Date.now()) revokeMediaProxySession(sessionId);
  }, Math.max(1, expiresAt - Date.now() + 25));
  timer.unref?.();
}

export function revokeMediaProxySession(sessionId: string): void {
  if (!sessionId) return;
  mediaProxySessions.delete(sessionId);
  removeMediaProxySessionGrants(sessionId);
  const controllers = activeProxyControllersBySession.get(sessionId);
  activeProxyControllersBySession.delete(sessionId);
  controllers?.forEach((controller) => controller.abort());
}

export function attachMediaProxySessionAbortController(
  sessionId: string,
  controller: AbortController,
): (() => void) | null {
  if (!hasActiveMediaProxySession(sessionId)) return null;
  const controllers = activeProxyControllersBySession.get(sessionId) || new Set<AbortController>();
  controllers.add(controller);
  activeProxyControllersBySession.set(sessionId, controllers);
  return () => {
    const current = activeProxyControllersBySession.get(sessionId);
    if (!current) return;
    current.delete(controller);
    if (current.size === 0) activeProxyControllersBySession.delete(sessionId);
  };
}

function getClientRateKey(req: import('express').Request): string {
  return getTrustedClientAddress(req);
}

function allowRate(key: string): boolean {
  return hlsProxyRateLimiter.allow(key, env.hlsProxyRateLimitPerMinute, HLS_PROXY_RATE_WINDOW_MS);
}

function acquireProxySlot(key: string): boolean {
  const activeForClient = activeProxyRequests.get(key) || 0;
  if (activeForClient >= env.hlsProxyMaxConcurrentPerClient
    || activeProxyRequestTotal >= env.hlsProxyMaxConcurrentTotal) return false;
  activeProxyRequests.set(key, activeForClient + 1);
  activeProxyRequestTotal += 1;
  return true;
}

function releaseProxySlot(key: string): void {
  const activeForClient = activeProxyRequests.get(key) || 0;
  if (activeForClient <= 1) activeProxyRequests.delete(key);
  else activeProxyRequests.set(key, activeForClient - 1);
  activeProxyRequestTotal = Math.max(0, activeProxyRequestTotal - 1);
}

function assertRemoteHttpUrl(rawUrl: string, allowUnlistedPublicTarget = false): URL {
  if (allowUnlistedPublicTarget) {
    const url = assertPublicHttpUrl(rawUrl);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    if ((url.protocol === 'https:' && port !== '443') || (url.protocol === 'http:' && port !== '80')) {
      throw new Error('直链媒体授权仅允许标准 HTTP/HTTPS 端口');
    }
    url.hash = '';
    return url;
  }
  if (env.nodeEnv === 'production' && env.hlsProxyAllowedHosts.length === 0) {
    throw new Error('生产环境必须配置 HLS_PROXY_ALLOWED_HOSTS 后才能使用媒体代理');
  }
  const url = assertPublicHttpUrl(rawUrl, env.hlsProxyAllowedHosts);
  url.hash = '';
  return url;
}

function parseProxyReferrer(rawUrl: string): URL {
  const url = new URL(String(rawUrl || '').trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('ref 参数必须是不含凭据的 http / https 链接');
  }
  return url;
}

function cleanupExpiredProxyGrants(now = Date.now(), force = false): void {
  if (!force && now < nextProxyGrantCleanupAt) return;
  nextProxyGrantCleanupAt = now + 5_000;
  for (const [sessionId, session] of mediaProxySessions.entries()) {
    if (session.expiresAt !== null && session.expiresAt <= now) {
      revokeMediaProxySession(sessionId);
    }
  }
  for (const [token, grant] of mediaProxyGrants.entries()) {
    if (grant.expiresAt <= now) deleteMediaProxyGrant(token);
  }
}

function hasActiveMediaProxySession(sessionId: string, now = Date.now()): boolean {
  if (!sessionId) return false;
  const session = mediaProxySessions.get(sessionId);
  if (!session || (session.expiresAt !== null && session.expiresAt <= now)) {
    if (session) revokeMediaProxySession(sessionId);
    return false;
  }
  return true;
}

function createProxyGrant(
  routeName: ProxyRouteName,
  targetUrl: string,
  refUrl: string,
  allowUnlistedPublicTargets = false,
  sessionId = '',
  parentToken = '',
  capacityReserved = false,
): MediaProxyGrantResult {
  cleanupExpiredProxyGrants();
  if (!hasActiveMediaProxySession(sessionId)) {
    throw new Error('媒体代理房间会话已失效');
  }
  const session = mediaProxySessions.get(sessionId)!;
  if (parentToken) {
    const parent = mediaProxyGrants.get(parentToken);
    if (!parent || parent.sessionId !== sessionId || parent.routeName !== 'hls') {
      throw new Error('HLS 父级临时授权已失效');
    }
  }
  const grantKey = createProxyGrantKey(routeName, targetUrl, refUrl, allowUnlistedPublicTargets, parentToken);
  const existingToken = getReusableProxyGrantToken(sessionId, grantKey);
  const existingGrant = existingToken ? mediaProxyGrants.get(existingToken)! : null;
  if (existingToken && existingGrant) {
    return {
      proxyUrl: `/api/proxy/${routeName}?token=${encodeURIComponent(existingToken)}`,
      expiresAt: existingGrant.expiresAt,
    };
  }
  const sessionTokens = mediaProxyGrantTokensBySession.get(sessionId) || new Set<string>();
  if (!capacityReserved) {
    if (sessionTokens.size >= MAX_PROXY_GRANTS_PER_SESSION) {
      throw new Error('媒体代理单会话临时授权数量已达上限，请稍后再试');
    }
    if ((mediaProxyGrantCountsByClient.get(session.clientQuotaKey) || 0) >= MAX_PROXY_GRANTS_PER_CLIENT) {
      throw new Error('媒体代理当前客户端临时授权数量已达上限，请稍后再试');
    }
    if ((mediaProxyGrantCountsByRoom.get(session.roomCode) || 0) >= MAX_PROXY_GRANTS_PER_ROOM) {
      throw new Error('媒体代理当前房间临时授权数量已达上限，请稍后再试');
    }
    if (mediaProxyGrants.size >= env.mediaProxyTokenMaxActive) cleanupExpiredProxyGrants(Date.now(), true);
    if (mediaProxyGrants.size >= env.mediaProxyTokenMaxActive) {
      throw new Error('媒体代理临时授权数量已达上限，请稍后再试');
    }
  }
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + env.mediaProxyTokenTtlMs;
  mediaProxyGrants.set(token, {
    routeName,
    targetUrl,
    refUrl,
    expiresAt,
    allowUnlistedPublicTargets,
    sessionId,
    clientBinding: session.clientBinding,
    clientQuotaKey: session.clientQuotaKey,
    roomCode: session.roomCode,
    parentToken: parentToken || null,
  });
  adjustGrantCount(mediaProxyGrantCountsByClient, session.clientQuotaKey, 1);
  adjustGrantCount(mediaProxyGrantCountsByRoom, session.roomCode, 1);
  sessionTokens.add(token);
  mediaProxyGrantTokensBySession.set(sessionId, sessionTokens);
  const keyMap = mediaProxyGrantTokensByKey.get(sessionId) || new Map<string, string>();
  keyMap.set(grantKey, token);
  mediaProxyGrantTokensByKey.set(sessionId, keyMap);
  if (parentToken) {
    const children = mediaProxyGrantChildrenByParent.get(parentToken) || new Set<string>();
    children.add(token);
    mediaProxyGrantChildrenByParent.set(parentToken, children);
  }
  return {
    proxyUrl: `/api/proxy/${routeName}?token=${encodeURIComponent(token)}`,
    expiresAt,
  };
}

export function issueMediaProxyGrant(
  routeName: ProxyRouteName,
  rawUrl: string,
  rawRefUrl = '',
  options: MediaProxyGrantOptions = {},
): MediaProxyGrantResult {
  if (!env.hlsProxyEnabled) throw new Error('媒体代理未启用');
  if (routeName !== 'hls' && routeName !== 'media') throw new Error('媒体代理类型无效');
  const expectedType = routeName === 'hls' ? 'hls' : 'video';
  const allowUnlistedPublicTargets = options.allowVerifiedDirect === true
    && isVerifiedDirectMediaUrl(rawUrl, expectedType);
  const targetUrl = assertRemoteHttpUrl(rawUrl, allowUnlistedPublicTargets).toString();
  const refUrl = rawRefUrl ? parseProxyReferrer(rawRefUrl).toString() : '';
  return createProxyGrant(routeName, targetUrl, refUrl, allowUnlistedPublicTargets, options.sessionId || '');
}

export function toPublicMediaGrantFailure(error: unknown): PublicMediaGrantFailure {
  const detail = error instanceof Error ? error.message : '';
  if (/HLS_PROXY_ALLOWED_HOSTS|生产环境必须配置/.test(detail)) {
    return { code: 'parse_option_missing', message: '未配置解析项' };
  }
  if (/媒体代理未启用/.test(detail)) {
    return { code: 'parse_option_disabled', message: '解析项未启用' };
  }
  if (/数量已达上限|请求太频繁|并发请求过多/.test(detail)) {
    return { code: 'parse_authorization_busy', message: '授权解析繁忙，请稍后再试' };
  }
  if (/白名单|本机|内网|保留地址|仅支持 http|链接不能包含|缺少 url|类型无效|标准 HTTP\/HTTPS 端口|参数/.test(detail)) {
    return { code: 'parse_source_denied', message: '当前视频源不在可解析范围' };
  }
  return { code: 'parse_authorization_failed', message: '授权解析失败' };
}

function resolveProxyGrant(token: string, routeName: ProxyRouteName, clientBinding: string): MediaProxyGrant | null {
  if (!token || token.length > MAX_PROXY_TOKEN_LENGTH) return null;
  const grant = mediaProxyGrants.get(token);
  if (!grant || grant.routeName !== routeName || grant.expiresAt <= Date.now()) {
    if (grant?.expiresAt && grant.expiresAt <= Date.now()) deleteMediaProxyGrant(token);
    return null;
  }
  if (!hasActiveMediaProxySession(grant.sessionId)) {
    deleteMediaProxyGrant(token);
    return null;
  }
  const expected = Buffer.from(grant.clientBinding, 'utf8');
  const actual = Buffer.from(clientBinding, 'utf8');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  return grant;
}

export const isBlockedProxyIpAddress = isBlockedRemoteIpAddress;

function isPlaylistResponse(targetUrl: URL, contentType: string): boolean {
  const pathname = targetUrl.pathname.toLowerCase();
  const lowerType = contentType.toLowerCase();
  return pathname.endsWith('.m3u8')
    || lowerType.includes('mpegurl')
    || lowerType.includes('vnd.apple.mpegurl')
    || lowerType.includes('application/x-mpegurl');
}

function collectHlsRewriteTargets(playlist: string, baseUrl: string): Set<string> {
  const targets = new Set<string>();
  for (const rawLine of playlist.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const candidates = line.startsWith('#')
      ? [...line.matchAll(/URI="([^"]+)"/gi)].map((match) => match[1])
      : [line];
    for (const candidate of candidates) {
      try {
        targets.add(new URL(candidate, baseUrl).toString());
      } catch {
        continue;
      }
      if (targets.size > MAX_HLS_REWRITTEN_TARGETS) {
        throw new Error('HLS 播放列表包含过多媒体地址');
      }
    }
  }
  return targets;
}

export function assertHlsRewriteTargetBudget(playlist: string, baseUrl: string): number {
  return collectHlsRewriteTargets(playlist, baseUrl).size;
}

function assertAdditionalMediaProxyGrantCapacity(
  sessionId: string,
  additionalCount: number,
  reclaimableCount = 0,
): void {
  cleanupExpiredProxyGrants();
  if (!hasActiveMediaProxySession(sessionId)) throw new Error('媒体代理房间会话已失效');
  const session = mediaProxySessions.get(sessionId)!;
  const sessionCount = Math.max(0, (mediaProxyGrantTokensBySession.get(sessionId)?.size || 0) - reclaimableCount);
  if (sessionCount + additionalCount > MAX_PROXY_GRANTS_PER_SESSION) {
    throw new Error('媒体代理单会话临时授权数量已达上限，请稍后再试');
  }
  const clientCount = Math.max(0, (mediaProxyGrantCountsByClient.get(session.clientQuotaKey) || 0) - reclaimableCount);
  if (clientCount + additionalCount > MAX_PROXY_GRANTS_PER_CLIENT) {
    throw new Error('媒体代理当前客户端临时授权数量已达上限，请稍后再试');
  }
  const roomCount = Math.max(0, (mediaProxyGrantCountsByRoom.get(session.roomCode) || 0) - reclaimableCount);
  if (roomCount + additionalCount > MAX_PROXY_GRANTS_PER_ROOM) {
    throw new Error('媒体代理当前房间临时授权数量已达上限，请稍后再试');
  }
  const globalCount = Math.max(0, mediaProxyGrants.size - reclaimableCount);
  if (globalCount + additionalCount > env.mediaProxyTokenMaxActive) {
    cleanupExpiredProxyGrants(Date.now(), true);
    if (Math.max(0, mediaProxyGrants.size - reclaimableCount) + additionalCount > env.mediaProxyTokenMaxActive) {
      throw new Error('媒体代理临时授权数量已达上限，请稍后再试');
    }
  }
}

function prepareHlsProxyUrls(
  targets: Set<string>,
  baseUrl: string,
  refUrl: string,
  allowUnlistedPublicTargets: boolean,
  sessionId: string,
  parentToken: string,
): Map<string, string> {
  cleanupExpiredProxyGrants();
  if (!hasActiveMediaProxySession(sessionId)) throw new Error('媒体代理房间会话已失效');
  const effectiveRefUrl = refUrl || baseUrl;
  const preparedByKey = new Map<string, {
    absoluteUrls: string[];
    targetUrl: string;
    grantKey: string;
    existingToken: string | null;
  }>();
  for (const absoluteUrl of targets) {
    const targetUrl = assertRemoteHttpUrl(absoluteUrl, allowUnlistedPublicTargets).toString();
    const grantKey = createProxyGrantKey('hls', targetUrl, effectiveRefUrl, allowUnlistedPublicTargets, parentToken);
    const existing = preparedByKey.get(grantKey);
    if (existing) {
      existing.absoluteUrls.push(absoluteUrl);
      continue;
    }
    const existingToken = getReusableProxyGrantToken(sessionId, grantKey);
    preparedByKey.set(grantKey, { absoluteUrls: [absoluteUrl], targetUrl, grantKey, existingToken });
  }
  const prepared = [...preparedByKey.values()];
  const missing = prepared.filter((entry) => !entry.existingToken);
  const previousCurrentTokens = new Set(mediaProxyGrantCurrentChildrenByParent.get(parentToken) || []);
  const previousGraceTokens = new Set(mediaProxyGrantPreviousChildrenByParent.get(parentToken) || []);
  const reusedTokens = new Set(prepared.map((entry) => entry.existingToken).filter(Boolean));
  const reclaimableTokens = new Set([...previousGraceTokens].filter(
    (token) => !reusedTokens.has(token) && !previousCurrentTokens.has(token),
  ));
  assertAdditionalMediaProxyGrantCapacity(sessionId, missing.length, reclaimableTokens.size);

  const proxyUrls = new Map<string, string>();
  const createdTokens: string[] = [];
  const nextChildTokens = new Set<string>();
  try {
    for (const entry of prepared) {
      if (entry.existingToken) {
        const proxyUrl = `/api/proxy/hls?token=${encodeURIComponent(entry.existingToken)}`;
        entry.absoluteUrls.forEach((absoluteUrl) => proxyUrls.set(absoluteUrl, proxyUrl));
        nextChildTokens.add(entry.existingToken);
        continue;
      }
      const grant = createProxyGrant(
        'hls',
        entry.targetUrl,
        effectiveRefUrl,
        allowUnlistedPublicTargets,
        sessionId,
        parentToken,
        true,
      );
      const token = new URL(grant.proxyUrl, 'http://proxy.local').searchParams.get('token') || '';
      if (!token) throw new Error('媒体代理临时授权创建失败');
      createdTokens.push(token);
      nextChildTokens.add(token);
      entry.absoluteUrls.forEach((absoluteUrl) => proxyUrls.set(absoluteUrl, grant.proxyUrl));
    }
    const nextGraceTokens = new Set([...previousCurrentTokens].filter((token) => !nextChildTokens.has(token)));
    for (const staleToken of previousGraceTokens) {
      if (!nextChildTokens.has(staleToken)) deleteMediaProxyGrant(staleToken);
    }
    const ownedTokens = new Set([...nextChildTokens, ...nextGraceTokens]);
    if (ownedTokens.size > 0) mediaProxyGrantChildrenByParent.set(parentToken, ownedTokens);
    else mediaProxyGrantChildrenByParent.delete(parentToken);
    if (nextChildTokens.size > 0) mediaProxyGrantCurrentChildrenByParent.set(parentToken, nextChildTokens);
    else mediaProxyGrantCurrentChildrenByParent.delete(parentToken);
    if (nextGraceTokens.size > 0) mediaProxyGrantPreviousChildrenByParent.set(parentToken, nextGraceTokens);
    else mediaProxyGrantPreviousChildrenByParent.delete(parentToken);
    return proxyUrls;
  } catch (error) {
    createdTokens.forEach((token) => deleteMediaProxyGrant(token));
    throw error;
  }
}

function rewriteQuotedUriAttributes(line: string, baseUrl: string, proxyUrls: Map<string, string>): string {
  return line.replace(/URI="([^"]+)"/gi, (_match, uri: string) => {
    let absolute: string;
    try {
      absolute = new URL(uri, baseUrl).toString();
    } catch {
      return `URI="${uri}"`;
    }
    const proxyUrl = proxyUrls.get(absolute);
    if (!proxyUrl) throw new Error('HLS 子资源授权缺失');
    return `URI="${proxyUrl}"`;
  });
}

function rewriteM3u8(
  playlist: string,
  baseUrl: string,
  refUrl: string,
  allowUnlistedPublicTargets: boolean,
  sessionId: string,
  parentToken: string,
): string {
  const targets = collectHlsRewriteTargets(playlist, baseUrl);
  const proxyUrls = prepareHlsProxyUrls(
    targets,
    baseUrl,
    refUrl,
    allowUnlistedPublicTargets,
    sessionId,
    parentToken,
  );
  return playlist.split(/\r?\n/).map((rawLine) => {
    const line = rawLine.trim();
    if (!line) return rawLine;

    if (line.startsWith('#')) {
      return rewriteQuotedUriAttributes(rawLine, baseUrl, proxyUrls);
    }

    let absolute: string;
    try {
      absolute = new URL(line, baseUrl).toString();
    } catch {
      return rawLine;
    }
    const proxyUrl = proxyUrls.get(absolute);
    if (!proxyUrl) throw new Error('HLS 子资源授权缺失');
    return proxyUrl;
  }).join('\n');
}

export function buildProxyForwardHeaders(range: string, targetUrl: URL, refUrl: string): Record<string, string> {
  const referer = refUrl || `${targetUrl.protocol}//${targetUrl.host}/`;
  const refererOrigin = (() => {
    try {
      const parsed = new URL(referer);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return `${targetUrl.protocol}//${targetUrl.host}`;
    }
  })();

  const headers: Record<string, string> = {
    'user-agent': env.proxyUserAgent,
    accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, video/*, audio/*, */*;q=0.8',
    'accept-encoding': 'identity',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
    referer,
    origin: refererOrigin,
  };

  if (range) headers.range = range;

  return headers;
}

function buildForwardHeaders(req: import('express').Request, targetUrl: URL, refUrl: string): Record<string, string> {
  const range = typeof req.headers.range === 'string' ? req.headers.range : '';
  return buildProxyForwardHeaders(range, targetUrl, refUrl);
}

async function requestProxyUrl(
  req: import('express').Request,
  targetUrl: URL,
  refUrl: string,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const resolved = await resolvePublicAddress(targetUrl.hostname);
  const request = targetUrl.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const upstreamRequest = request(targetUrl, {
      method: 'GET',
      headers: buildForwardHeaders(req, targetUrl, refUrl),
      signal,
      lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
        if (options?.all) {
          callback(null, [resolved]);
          return;
        }
        callback(null, resolved.address, resolved.family);
      }) as any,
    }, resolve);
    upstreamRequest.once('error', reject);
    upstreamRequest.end();
  });
}

async function fetchProxyTarget(
  req: import('express').Request,
  initialUrl: URL,
  refUrl: string,
  signal: AbortSignal,
  allowUnlistedPublicTargets: boolean,
): Promise<{ response: IncomingMessage; responseUrl: URL }> {
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= MAX_PROXY_REDIRECTS; redirectCount += 1) {
    const response = await requestProxyUrl(req, currentUrl, refUrl, signal);
    const status = response.statusCode || 502;
    if (![301, 302, 303, 307, 308].includes(status)) {
      return { response, responseUrl: currentUrl };
    }

    const location = response.headers.location;
    if (!location) return { response, responseUrl: currentUrl };
    if (redirectCount === MAX_PROXY_REDIRECTS) throw new Error('媒体代理重定向次数过多');
    response.destroy();
    currentUrl = assertRemoteHttpUrl(new URL(location, currentUrl).toString(), allowUnlistedPublicTargets);
  }

  throw new Error('媒体代理重定向次数过多');
}

function getUpstreamHeader(response: IncomingMessage, name: string): string {
  const value = response.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : String(value || '');
}

async function readUpstreamText(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_PROXY_TEXT_BYTES) {
      response.destroy();
      throw new Error('上游文本响应过大');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

type ProxyTargetFetcher = typeof fetchProxyTarget;

export function createMediaProxyRouter(fetchProxyTargetImpl: ProxyTargetFetcher = fetchProxyTarget): Router {
  const router = Router();
  router.get(['/proxy/hls', '/proxy/media'], async (req, res) => {
  const startedAt = performance.now();
  const routeName: ProxyRouteName = req.path.toLowerCase().endsWith('/media') ? 'media' : 'hls';
  let sourceFingerprint: string | undefined;
  const logFetchRejection = (reason: string, status?: number) => {
    logStructuredEvent('proxy_fetch_decision', {
      sourceFingerprint,
      routeName,
      decision: 'rejected',
      reason,
      statusClass: Number.isFinite(status) ? `${Math.floor(Number(status) / 100)}xx` : undefined,
      elapsedBucket: elapsedBucket(performance.now() - startedAt),
    }, {
      level: 'warn',
      suppressKey: `${sourceFingerprint || 'unknown'}:${routeName}:${reason}`,
    });
  };
  const canonicalPath = routeName === 'media' ? '/proxy/media' : '/proxy/hls';
  if (req.path !== canonicalPath) {
    logFetchRejection('invalid_request', 404);
    res.status(404).json({ success: false, message: '当前解析请求无效' });
    return;
  }
  if (!env.hlsProxyEnabled) {
    logFetchRejection('disabled', 403);
    res.status(403).json({ success: false, message: '解析项未启用' });
    return;
  }
  const clientKey = getClientRateKey(req);
  if (!allowRate(clientKey)) {
    logFetchRejection('rate_limited', 429);
    res.status(429).json({ success: false, message: '解析请求太频繁，请稍后再试' });
    return;
  }

  let targetUrl: URL;
  let refUrl = '';
  let proxyGrant: MediaProxyGrant;
  let proxyGrantToken = '';

  try {
    if (req.query.url || req.query.ref) throw new Error('只接受已入房成员签发的临时令牌');
    const clientBinding = createMediaProxyClientBinding(
      clientKey,
      String(req.headers['user-agent'] || ''),
    );
    const grantToken = String(req.query.token || '');
    const grant = resolveProxyGrant(grantToken, routeName, clientBinding);
    if (!grant) {
      logFetchRejection('invalid_or_expired_grant', 401);
      res.status(401).json({ success: false, message: '播放凭据无效或已过期，请重新加载视频' });
      return;
    }
    proxyGrant = grant;
    proxyGrantToken = grantToken;
    targetUrl = assertRemoteHttpUrl(grant.targetUrl, grant.allowUnlistedPublicTargets);
    sourceFingerprint = diagnosticFingerprint('source', targetUrl.toString());
    refUrl = grant.refUrl;
  } catch (error) {
    logFetchRejection('invalid_request', 400);
    res.status(400).json({ success: false, message: toPublicMediaGrantFailure(error).message });
    return;
  }
  if (!acquireProxySlot(clientKey)) {
    logFetchRejection('concurrency_limited', 429);
    res.status(429).json({ success: false, message: '解析请求繁忙，请稍后再试' });
    return;
  }

  const controller = new AbortController();
  let abortCause: 'upstream_timeout' | 'client_cancelled' | null = null;
  let detachSessionController: (() => void) | null = null;
  let timeout: NodeJS.Timeout | null = null;
  const armTimeout = () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      if (controller.signal.aborted) return;
      abortCause = 'upstream_timeout';
      controller.abort();
    }, env.hlsProxyTimeoutMs);
  };
  const abortOnClientClose = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      abortCause = 'client_cancelled';
      controller.abort();
    }
  };
  req.once('aborted', abortOnClientClose);
  res.once('close', abortOnClientClose);
  armTimeout();

  try {
    detachSessionController = attachMediaProxySessionAbortController(proxyGrant.sessionId, controller);
    if (!detachSessionController) {
      logFetchRejection('invalid_or_expired_grant', 401);
      res.status(401).json({ success: false, message: '播放凭据无效或已过期，请重新加载视频' });
      return;
    }
    const { response: upstream, responseUrl } = await fetchProxyTargetImpl(
      req,
      targetUrl,
      refUrl,
      controller.signal,
      proxyGrant.allowUnlistedPublicTargets,
    );
    armTimeout();

    const upstreamStatus = upstream.statusCode || 502;
    const contentType = getUpstreamHeader(upstream, 'content-type');
    const isPlaylist = isPlaylistResponse(responseUrl, contentType);

    res.status(upstreamStatus);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');

    if (upstreamStatus < 200 || upstreamStatus >= 300) {
      logFetchRejection('upstream_status', upstreamStatus);
      const message = await readUpstreamText(upstream).catch(() => '');
      res.type('text/plain; charset=utf-8').send(message || `上游视频源请求失败：HTTP ${upstreamStatus}`);
      return;
    }

    if (isPlaylist) {
      const text = await readUpstreamText(upstream);
      res.type('application/vnd.apple.mpegurl; charset=utf-8').send(rewriteM3u8(
        text,
        responseUrl.toString(),
        refUrl,
        proxyGrant.allowUnlistedPublicTargets,
        proxyGrant.sessionId,
        proxyGrantToken,
      ));
      return;
    }

    const passThroughHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
    passThroughHeaders.forEach((name) => {
      const value = getUpstreamHeader(upstream, name);
      if (value) res.setHeader(name, value);
    });

    const activityMonitor = new Transform({
      transform(chunk, _encoding, callback) {
        armTimeout();
        callback(null, chunk);
      },
    });
    await pipeline(upstream, activityMonitor, res);
  } catch (error) {
    const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
    const sessionActive = hasActiveMediaProxySession(proxyGrant.sessionId);
    const reason = !sessionActive
      ? 'invalid_or_expired_grant'
      : (abortCause === 'client_cancelled' ? 'client_cancelled' : (aborted ? 'upstream_timeout' : 'upstream_error'));
    const status = !sessionActive ? 401 : (abortCause === 'client_cancelled' ? 499 : (aborted ? 504 : 502));
    logFetchRejection(reason, status);
    if (abortCause === 'client_cancelled') {
      if (!res.writableEnded) res.destroy();
      return;
    }
    if (res.headersSent) {
      if (!res.writableEnded) res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    res.status(status).json({
      success: false,
      message: !sessionActive
        ? '播放凭据无效或已过期，请重新加载视频'
        : (aborted ? '视频源响应超时' : '视频源加载失败'),
    });
  } finally {
    detachSessionController?.();
    releaseProxySlot(clientKey);
    if (timeout) clearTimeout(timeout);
    req.removeListener('aborted', abortOnClientClose);
    res.removeListener('close', abortOnClientClose);
  }
  });
  return router;
}

export const proxyRouter = createMediaProxyRouter();
