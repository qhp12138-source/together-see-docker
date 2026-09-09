import type { Server as HttpServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { Server } from 'socket.io';
import { env, isPublicOriginAllowed } from '../config/env.js';
import {
  createMediaProxyClientBinding,
  issueMediaProxyGrant,
  registerMediaProxySession,
  revokeMediaProxySession,
  suspendMediaProxySession,
  toPublicMediaGrantFailure,
} from '../routes/proxy.routes.js';
import { parseVideoUrl } from '../services/parser.service.js';
import { roomService } from '../services/room.service.js';
import { getTrustedClientAddress } from '../utils/client-address.js';
import { createId, normalizeRoomCode } from '../utils/id.js';
import { createLocalPlaceholderUrl, hasUsableLocalFileMeta } from '../utils/local-media.js';
import { isBilibiliPageUrl, sanitizeBilibiliSourceMeta } from '../utils/bilibili.js';
import { assertPublicHttpUrl, resolvePublicAddress } from '../utils/remote-url.js';
import { diagnosticFingerprint, logStructuredEvent } from '../utils/structured-log.js';
import { BoundedSlidingWindowRateLimiter } from '../utils/rate-limit.js';
import type { PlaybackAction, PlaylistItem, PlaybackState, RoomState, SourceType } from '../types/room.js';

interface JoinPayload {
  roomCode: string;
  roomName?: string;
  memberId: string;
  name?: string;
  password?: string;
  adminToken?: string;
  reconnectToken?: string;
  clientId?: string;
  attemptId?: string;
}

interface PlaylistPayload {
  roomCode: string;
  item: Omit<PlaylistItem, 'createdAt'> & { createdAt?: number };
}

interface PlaylistActionPayload {
  roomCode: string;
  itemId: string;
  direction?: -1 | 1;
  title?: string;
}

interface PlaylistBilibiliDanmakuPayload {
  roomCode: string;
  itemId: string;
  enabled: boolean;
}

interface PlaylistBilibiliRefreshPayload {
  roomCode: string;
  itemId: string;
}

interface BilibiliRefreshResult {
  state: RoomState | null;
  success: boolean;
  changed: boolean;
  reason: string;
  message: string;
}

interface RoomAutoPlayNextPayload {
  roomCode: string;
  enabled: boolean;
}

interface PlaybackPayload {
  roomCode: string;
  patch: Partial<PlaybackState>;
  action?: PlaybackAction;
  baseRevision?: number;
  client?: {
    ready?: boolean;
    seeking?: boolean;
  };
}

interface RoomLockPayload {
  roomCode: string;
  locked: boolean;
  adminToken?: string;
}

interface KickMemberPayload {
  roomCode: string;
  memberId: string;
  adminToken?: string;
}

interface RoomPasswordPayload {
  roomCode: string;
  password?: string;
  adminToken?: string;
}

interface RoomControlPolicyPayload {
  roomCode: string;
  controlPolicy?: 'host_only' | 'everyone';
  adminToken?: string;
}

interface RecoverAdminPayload {
  roomCode: string;
  recoveryCode?: string;
  memberId?: string;
  name?: string;
}

interface MemberRenamePayload {
  roomCode: string;
  name?: string;
}

interface ProxyTokenPayload {
  requestId?: string;
  roomCode: string;
  routeName?: 'hls' | 'media';
  url?: string;
  refUrl?: string;
}

interface ControllerObservation {
  category: 'playback' | 'playlist';
  action: string;
  sourceId?: string;
  sourceType?: SourceType;
}

type SocketInstance = import('socket.io').Socket;
type RoomAck = (state: RoomState | null) => void;

const MAX_MEMBER_NAME_LENGTH = 24;
const MAX_MEMBER_ID_LENGTH = 80;
const MAX_CLIENT_ID_LENGTH = 120;
const MAX_CHAT_TEXT_LENGTH = 500;
const MAX_DANMAKU_TEXT_LENGTH = 100;
const MAX_PLAYLIST_TITLE_LENGTH = 160;
const MAX_URL_LENGTH = 2048;
const MAX_ROOM_PASSWORD_LENGTH = 80;
const ALLOWED_SOURCE_TYPES = new Set<SourceType>(['hls', 'video', 'dash', 'page', 'local', 'unknown']);
const ALLOWED_PLAYBACK_ACTIONS = new Set<PlaybackAction>(['play', 'pause', 'seek', 'rate', 'source', 'periodic', 'buffering']);
const CHAT_RATE_LIMIT = { limit: 20, windowMs: 30_000 };
const DANMAKU_RATE_LIMIT = { limit: 12, windowMs: 10_000 };
const PASSWORD_RATE_LIMIT = { limit: 8, windowMs: 5 * 60_000 };
const PROXY_TOKEN_RATE_LIMIT = { limit: 60, windowMs: 60_000 };
const JOIN_RATE_LIMIT = { limit: 30, windowMs: 60_000 };
const JOIN_GLOBAL_RATE_LIMIT = { limit: 120, windowMs: 60_000 };
const PLAYBACK_RATE_LIMIT = { limit: 30, windowMs: 10_000 };
const PLAYLIST_RATE_LIMIT = { limit: 15, windowMs: 30_000 };
const BILIBILI_REFRESH_RATE_LIMIT = { limit: 2, windowMs: 60_000 };
const BILIBILI_REFRESH_ITEM_COOLDOWN_MS = 15_000;
const chatRateLimiter = new BoundedSlidingWindowRateLimiter();
const danmakuRateLimiter = new BoundedSlidingWindowRateLimiter();
const passwordRateLimiter = new BoundedSlidingWindowRateLimiter();
const proxyTokenRateLimiter = new BoundedSlidingWindowRateLimiter();
const joinRateLimiter = new BoundedSlidingWindowRateLimiter();
const joinGlobalRateLimiter = new BoundedSlidingWindowRateLimiter();
const playbackRateLimiter = new BoundedSlidingWindowRateLimiter();
const playlistRateLimiter = new BoundedSlidingWindowRateLimiter();
const bilibiliRefreshRateLimiter = new BoundedSlidingWindowRateLimiter();
const bilibiliRefreshItemRateLimiter = new BoundedSlidingWindowRateLimiter();
const bilibiliRefreshTasks = new Map<string, Promise<BilibiliRefreshResult>>();
const joinDiagnosticSecret = randomBytes(32);

function classifyClientType(userAgent: string | undefined): string {
  const value = String(userAgent || '').toLowerCase();
  if (/android/.test(value) && /;\s*wv\)|\bwv\b/.test(value)) return 'android_webview';
  if (/android/.test(value)) return 'android_browser';
  if (/iphone|ipad|ipod/.test(value)) return 'ios_browser';
  if (/^node$|undici|node\.js|node\//.test(value)) return 'automation';
  if (/mobile/.test(value)) return 'mobile_other';
  return value ? 'desktop_browser' : 'unknown';
}

function playbackDeltaBucket(value: number | null): string {
  if (!Number.isFinite(value)) return 'unknown';
  if (value! < -10) return '<-10s';
  if (value! < -2.5) return '-10--2.5s';
  if (value! <= 2.5) return '-2.5-2.5s';
  if (value! <= 10) return '2.5-10s';
  return '>10s';
}

function logPlaybackDecision(
  socket: SocketInstance,
  roomCode: string,
  memberId: string,
  action: string,
  decision: 'accepted' | 'rejected',
  reason: string,
  details: {
    baseRevision?: number;
    currentRevision?: number;
    nextRevision?: number;
    sourceMatch?: boolean;
    clientReady?: boolean;
    clientSeeking?: boolean;
    leaseOwnerChanged?: boolean;
    previousSourceId?: string | null;
    nextSourceId?: string | null;
    timelineDeltaSeconds?: number | null;
  } = {},
): void {
  const roomFingerprint = diagnosticFingerprint('room', roomCode);
  const actorFingerprint = diagnosticFingerprint('actor', memberId);
  const previousSourceFingerprint = diagnosticFingerprint('source', details.previousSourceId);
  const nextSourceFingerprint = diagnosticFingerprint('source', details.nextSourceId);
  logStructuredEvent('playback_decision', {
    roomFingerprint,
    actorFingerprint,
    clientType: classifyClientType(socket.request.headers['user-agent']),
    action,
    decision,
    reason,
    baseRevision: details.baseRevision,
    currentRevision: details.currentRevision,
    nextRevision: details.nextRevision,
    sourceMatch: details.sourceMatch,
    clientReady: details.clientReady,
    clientSeeking: details.clientSeeking,
    leaseOwnerChanged: details.leaseOwnerChanged,
    previousSourceFingerprint,
    nextSourceFingerprint,
    deltaBucket: playbackDeltaBucket(details.timelineDeltaSeconds ?? null),
  }, {
    level: decision === 'rejected' ? 'warn' : 'info',
    suppressKey: `${roomFingerprint}:${actorFingerprint}:${nextSourceFingerprint || previousSourceFingerprint}:${action}:${decision}:${reason}`,
  });
}

function logPlaylistDecision(
  socket: SocketInstance,
  roomCode: string,
  memberId: string,
  action: string,
  decision: 'accepted' | 'rejected',
  reason: string,
  before: RoomState,
  after: RoomState = before,
  sourceId = '',
  sourceType?: SourceType,
): void {
  const roomFingerprint = diagnosticFingerprint('room', roomCode);
  const actorFingerprint = diagnosticFingerprint('actor', memberId);
  const sourceFingerprint = diagnosticFingerprint('source', sourceId);
  logStructuredEvent('playlist_decision', {
    roomFingerprint,
    actorFingerprint,
    clientType: classifyClientType(socket.request.headers['user-agent']),
    action,
    decision,
    reason,
    sourceFingerprint,
    sourceType,
    countBefore: before.playlist.length,
    countAfter: after.playlist.length,
    activeSourceChanged: before.playback.activeSourceId !== after.playback.activeSourceId,
  }, {
    level: decision === 'rejected' ? 'warn' : 'info',
    suppressKey: `${roomFingerprint}:${actorFingerprint}:${sourceFingerprint || 'none'}:${action}:${decision}:${reason}`,
  });
}

function snapshotPlaylistLogState(state: RoomState): RoomState {
  return {
    ...state,
    playlist: [...state.playlist],
    playback: { ...state.playback },
  };
}

function logJoinRejection(socket: SocketInstance, roomCode: string, adminToken: string, rejectionCode: string): void {
  const diagnostic = roomService.getJoinDiagnostic(roomCode, adminToken);
  const roomFingerprint = createHmac('sha256', joinDiagnosticSecret).update(roomCode).digest('hex').slice(0, 12);
  console.warn('[together-see-server] join_rejected', JSON.stringify({
    event: 'join_rejected',
    roomFingerprint,
    creatorPending: diagnostic.creatorPending,
    adminTokenPresent: Boolean(adminToken),
    adminTokenValid: diagnostic.adminTokenValid,
    rejectionCode,
    clientType: classifyClientType(socket.request.headers['user-agent']),
  }));
}

function emitRoomState(io: Server, roomCode: string, state: RoomState): void {
  io.to(roomCode).emit('room_state', state);
}

function emitRoomPermissions(socket: SocketInstance, roomCode: string, memberId: string, adminToken: string): void {
  const canManage = roomService.isCreatorAdmin(roomCode, memberId, adminToken);
  socket.data.adminToken = canManage ? adminToken : '';
  socket.emit('room_permissions', {
    roomCode,
    memberId,
    canManage,
    isCreator: roomService.isOriginalCreator(roomCode, memberId),
  });
}

function getSocketRoomCode(socket: SocketInstance): string | null {
  const value = socket.data.roomCode;
  return typeof value === 'string' ? value : null;
}

function getSocketMemberId(socket: SocketInstance): string | null {
  const value = socket.data.memberId;
  return typeof value === 'string' ? value : null;
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanPassword(value: unknown): string {
  return String(value || '').trim().slice(0, MAX_ROOM_PASSWORD_LENGTH);
}

function cleanUrl(value: unknown): string {
  return String(value || '').trim().slice(0, MAX_URL_LENGTH);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function rejectRoomAction(socket: SocketInstance, message: string, state: RoomState | null, ack?: RoomAck): false {
  ack?.(state);
  socket.emit('room_error', { message, state });
  return false;
}

function resolveJoinedRoom(socket: SocketInstance, requestedRoomCode?: string): string | null {
  const joinedRoom = getSocketRoomCode(socket);
  if (!joinedRoom) return null;
  const requested = requestedRoomCode ? normalizeRoomCode(requestedRoomCode) : joinedRoom;
  return requested === joinedRoom ? joinedRoom : null;
}

function requireRoomMember(socket: SocketInstance, requestedRoomCode: string | undefined, ack?: RoomAck): { roomCode: string; memberId: string; state: RoomState } | null {
  const roomCode = resolveJoinedRoom(socket, requestedRoomCode);
  const memberId = getSocketMemberId(socket);
  if (!roomCode || !memberId) {
    rejectRoomAction(socket, '请先加入当前房间', null, ack);
    return null;
  }

  const state = roomService.getRoom(roomCode);
  if (!state || !roomService.isMemberSocket(roomCode, memberId, socket.id)) {
    rejectRoomAction(socket, '当前成员不在该房间中，请刷新后重试', state, ack);
    return null;
  }

  return { roomCode, memberId, state };
}

function requireHost(socket: SocketInstance, requestedRoomCode: string | undefined, ack?: RoomAck): { roomCode: string; memberId: string; state: RoomState } | null {
  const context = requireRoomMember(socket, requestedRoomCode, ack);
  if (!context) return null;
  if (!roomService.isHost(context.roomCode, context.memberId)) {
    rejectRoomAction(socket, '只有房主可以执行该操作', context.state, ack);
    return null;
  }
  return context;
}

function requireController(
  socket: SocketInstance,
  requestedRoomCode: string | undefined,
  ack?: RoomAck,
  observation?: ControllerObservation,
): { roomCode: string; memberId: string; state: RoomState } | null {
  const context = requireRoomMember(socket, requestedRoomCode, ack);
  if (!context) return null;
  if (!roomService.canControlRoom(context.roomCode, context.memberId)) {
    if (observation?.category === 'playback') {
      logPlaybackDecision(socket, context.roomCode, context.memberId, observation.action, 'rejected', 'not_controller', {
        currentRevision: context.state.playback.revision,
        nextRevision: context.state.playback.revision,
        previousSourceId: context.state.playback.activeSourceId,
        nextSourceId: context.state.playback.activeSourceId,
      });
    } else if (observation?.category === 'playlist') {
      logPlaylistDecision(
        socket,
        context.roomCode,
        context.memberId,
        observation.action,
        'rejected',
        'not_controller',
        context.state,
        context.state,
        observation.sourceId,
        observation.sourceType,
      );
    }
    rejectRoomAction(socket, '当前房间仅房主可以执行该操作', context.state, ack);
    return null;
  }
  return context;
}

function requireAdmin(socket: SocketInstance, requestedRoomCode: string | undefined, adminToken: string | undefined, ack?: RoomAck): { roomCode: string; memberId: string; state: RoomState } | null {
  const context = requireRoomMember(socket, requestedRoomCode, ack);
  if (!context) return null;
  if (!roomService.isCreatorAdmin(context.roomCode, context.memberId, adminToken || '')) {
    rejectRoomAction(socket, '只有当前房间管理员可以执行该操作', context.state, ack);
    return null;
  }
  return context;
}

function requireActionRate(
  socket: SocketInstance,
  context: { roomCode: string; memberId: string; state: RoomState },
  limiter: BoundedSlidingWindowRateLimiter,
  policy: { limit: number; windowMs: number },
  message: string,
  ack?: RoomAck,
  observation?: ControllerObservation,
): boolean {
  const key = `${context.roomCode}:${context.memberId}`;
  if (limiter.allow(key, policy.limit, policy.windowMs)) return true;
  if (observation?.category === 'playback') {
    logPlaybackDecision(socket, context.roomCode, context.memberId, observation.action, 'rejected', 'rate_limited', {
      currentRevision: context.state.playback.revision,
      nextRevision: context.state.playback.revision,
      previousSourceId: context.state.playback.activeSourceId,
      nextSourceId: context.state.playback.activeSourceId,
    });
  } else if (observation?.category === 'playlist') {
    logPlaylistDecision(
      socket,
      context.roomCode,
      context.memberId,
      observation.action,
      'rejected',
      'rate_limited',
      context.state,
      context.state,
      observation.sourceId,
      observation.sourceType,
    );
  }
  rejectRoomAction(socket, message, context.state, ack);
  return false;
}

function findMemberName(state: RoomState | null, memberId: string | undefined): string {
  if (!memberId) return '';
  return state?.members.find((member) => member.id === memberId)?.name || memberId;
}

function createDanmakuMessage(roomCode: string, senderId: string, senderName: string, text: string) {
  return {
    id: createId('danmaku'),
    roomCode,
    senderId,
    senderName,
    text: cleanText(text, MAX_DANMAKU_TEXT_LENGTH),
    createdAt: Date.now(),
  };
}

function canonicalProxySourceUrl(rawUrl: string): string | null {
  try {
    const url = assertPublicHttpUrl(rawUrl);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function findProxyPlaylistItem(state: RoomState, routeName: 'hls' | 'media', rawUrl: string): PlaylistItem | null {
  const requestedUrl = canonicalProxySourceUrl(rawUrl);
  if (!requestedUrl) return null;
  const expectedType: SourceType = routeName === 'hls' ? 'hls' : 'video';
  return state.playlist.find((item) => item.sourceType === expectedType
    && canonicalProxySourceUrl(item.sourceUrl) === requestedUrl) || null;
}

export function sanitizePlaylistItem(item: PlaylistPayload['item'], memberId: string): Omit<PlaylistItem, 'id' | 'createdAt'> & { id?: string; createdAt?: number } | null {
  if (!item) return null;
  const sourceType = ALLOWED_SOURCE_TYPES.has(item.sourceType as SourceType) ? item.sourceType as SourceType : 'unknown';
  const sourceUrl = cleanUrl(item.sourceUrl || item.pageUrl);
  const pageUrl = cleanUrl(item.pageUrl || item.sourceUrl);
  const finalUrl = cleanUrl(item.finalUrl);
  const refererUrl = sourceType === 'local' ? '' : cleanUrl(item.refererUrl || pageUrl);
  if (sourceType !== 'local' && !sourceUrl && !pageUrl) return null;
  if (sourceType !== 'local') {
    try {
      for (const value of [sourceUrl, pageUrl, refererUrl, finalUrl].filter(Boolean)) {
        const url = assertPublicHttpUrl(value);
        const port = url.port || (url.protocol === 'https:' ? '443' : '80');
        if ((url.protocol === 'https:' && port !== '443') || (url.protocol === 'http:' && port !== '80')) return null;
      }
    } catch {
      return null;
    }
  }

  const localFile = item.localFile ? {
    name: cleanText(item.localFile.name, 180),
    size: clampNumber(item.localFile.size, 0, Number.MAX_SAFE_INTEGER, 0),
    type: cleanText(item.localFile.type, 120),
    lastModified: clampNumber(item.localFile.lastModified, 0, Number.MAX_SAFE_INTEGER, 0),
  } : null;
  if (sourceType === 'local' && !hasUsableLocalFileMeta(localFile)) return null;
  const sharedSourceUrl = sourceType === 'local' ? createLocalPlaceholderUrl(localFile!) : (sourceUrl || pageUrl);
  const sharedPageUrl = sourceType === 'local' ? sharedSourceUrl : (pageUrl || sharedSourceUrl);
  const bilibiliMeta = sourceType === 'local' ? undefined : sanitizeBilibiliSourceMeta(item.bilibili);
  const bilibili = bilibiliMeta && isBilibiliPageUrl(pageUrl) ? bilibiliMeta : undefined;

  return {
    id: cleanText(item.id, 80) || undefined,
    title: cleanText(item.title || pageUrl || sourceUrl || localFile?.name || '未命名视频', MAX_PLAYLIST_TITLE_LENGTH),
    pageUrl: sharedPageUrl,
    sourceUrl: sharedSourceUrl,
    sourceType,
    createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : undefined,
    addedBy: memberId,
    localFile,
    requiresClientParse: Boolean(item.requiresClientParse),
    parseMessage: cleanText(item.parseMessage, 240),
    finalUrl: sourceType === 'local' ? '' : finalUrl,
    refererUrl,
    bilibili,
  };
}

async function validatePlaylistRemoteAddresses(item: Omit<PlaylistItem, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): Promise<void> {
  if (item.sourceType === 'local') return;
  const hostnames = new Set<string>();
  for (const value of [item.sourceUrl, item.pageUrl, item.refererUrl, item.finalUrl].filter(Boolean) as string[]) {
    hostnames.add(assertPublicHttpUrl(value).hostname);
  }
  await Promise.all([...hostnames].map((hostname) => resolvePublicAddress(hostname)));
}

async function refreshBilibiliPlaylistSource(io: Server, roomCode: string, itemId: string): Promise<BilibiliRefreshResult> {
  const before = roomService.getRoom(roomCode);
  const sourceItem = before?.playlist.find((item) => item.id === itemId);
  const sourceMeta = sanitizeBilibiliSourceMeta(sourceItem?.bilibili);
  if (!before || !sourceItem || sourceItem.sourceType !== 'video' || !sourceMeta || !isBilibiliPageUrl(sourceItem.pageUrl)) {
    return { state: before, success: false, changed: false, reason: 'item_not_refreshable', message: '当前播放项不支持刷新解析地址' };
  }

  const originalSourceUrl = sourceItem.sourceUrl;
  const parsed = await parseVideoUrl(sourceItem.pageUrl, { force: true });
  const parsedMeta = sanitizeBilibiliSourceMeta(parsed.bilibili);
  if (!parsed.success || parsed.type !== 'video' || !parsed.src || !parsedMeta) {
    return { state: roomService.getRoom(roomCode), success: false, changed: false, reason: 'parse_failed', message: parsed.message || 'B站播放地址刷新失败' };
  }
  if (parsedMeta.bvid !== sourceMeta.bvid || parsedMeta.cid !== sourceMeta.cid || parsedMeta.page !== sourceMeta.page) {
    return { state: roomService.getRoom(roomCode), success: false, changed: false, reason: 'identity_mismatch', message: 'B站播放项身份校验失败，请重新添加该视频' };
  }

  const replacement = sanitizePlaylistItem({
    ...sourceItem,
    pageUrl: parsed.pageUrl || sourceItem.pageUrl,
    sourceUrl: parsed.src,
    sourceType: 'video',
    requiresClientParse: false,
    parseMessage: parsed.message || sourceItem.parseMessage || '',
    finalUrl: parsed.finalUrl || '',
    refererUrl: parsed.refererUrl || parsed.pageUrl || sourceItem.pageUrl,
    bilibili: {
      ...parsedMeta,
      danmakuEnabled: sourceMeta.danmakuEnabled,
    },
  }, sourceItem.addedBy || 'system');
  if (!replacement?.bilibili) {
    return { state: roomService.getRoom(roomCode), success: false, changed: false, reason: 'invalid_result', message: 'B站播放地址刷新结果无效' };
  }
  await validatePlaylistRemoteAddresses(replacement);

  const latest = roomService.getRoom(roomCode);
  const latestItem = latest?.playlist.find((item) => item.id === itemId);
  const latestMeta = sanitizeBilibiliSourceMeta(latestItem?.bilibili);
  if (!latest || !latestItem || !latestMeta
    || latestMeta.bvid !== sourceMeta.bvid || latestMeta.cid !== sourceMeta.cid || latestMeta.page !== sourceMeta.page) {
    return { state: latest, success: false, changed: false, reason: 'stale_item', message: '播放项已变化，请重试' };
  }
  if (latestItem.sourceUrl !== originalSourceUrl) {
    return { state: latest, success: true, changed: false, reason: 'already_refreshed', message: 'B站播放地址已由其他成员刷新' };
  }

  const state = roomService.refreshBilibiliPlaylistSource(roomCode, itemId, replacement);
  const refreshedItem = state?.playlist.find((item) => item.id === itemId);
  const changed = Boolean(refreshedItem && refreshedItem.sourceUrl !== originalSourceUrl);
  if (!state || !changed) {
    return { state, success: false, changed: false, reason: 'store_rejected', message: 'B站播放地址刷新未生效' };
  }
  emitRoomState(io, roomCode, state);
  return { state, success: true, changed: true, reason: 'refreshed', message: 'B站播放地址已刷新' };
}

function sanitizePlaybackPatch(patch: Partial<PlaybackState> | undefined): Partial<PlaybackState> {
  const cleanPatch: Partial<PlaybackState> = {};
  if (!patch) return cleanPatch;
  if ('activeSourceId' in patch) {
    const sourceId = patch.activeSourceId === null ? null : cleanText(patch.activeSourceId, 80);
    cleanPatch.activeSourceId = sourceId || null;
  }
  if ('playing' in patch) cleanPatch.playing = Boolean(patch.playing);
  if ('buffering' in patch) cleanPatch.buffering = Boolean(patch.buffering);
  if ('currentTime' in patch) cleanPatch.currentTime = clampNumber(patch.currentTime, 0, Number.MAX_SAFE_INTEGER, 0);
  if ('duration' in patch) {
    cleanPatch.duration = patch.duration === null ? null : clampNumber(patch.duration, 0, Number.MAX_SAFE_INTEGER, 0);
  }
  if ('playbackRate' in patch) cleanPatch.playbackRate = clampNumber(patch.playbackRate, 0.25, 3, 1);
  return cleanPatch;
}

function sanitizePlaybackAction(value: unknown): PlaybackAction | null {
  return typeof value === 'string' && ALLOWED_PLAYBACK_ACTIONS.has(value as PlaybackAction)
    ? value as PlaybackAction
    : null;
}

export function attachSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    path: '/socket.io',
    allowRequest: (req, callback) => {
      callback(null, isPublicOriginAllowed(req.headers.origin));
    },
    cors: {
      origin: (origin, callback) => {
        callback(null, isPublicOriginAllowed(origin));
      },
      credentials: true,
    },
  });

  function scheduleHostFailover(roomCode: string, departedHostId: string): void {
    const remainingMs = roomService.getHostReconnectRemainingMs(roomCode);
    if (remainingMs === null) return;
    const timer = setTimeout(() => {
      const nextState = roomService.finalizeHostDeparture(roomCode, departedHostId);
      if (nextState) emitRoomState(io, roomCode, nextState);
    }, remainingMs + 25);
    timer.unref();
  }

  function refreshRoomPermissions(roomCode: string): void {
    for (const targetSocket of io.sockets.sockets.values()) {
      if (getSocketRoomCode(targetSocket) !== roomCode) continue;
      const memberId = getSocketMemberId(targetSocket);
      if (!memberId) continue;
      emitRoomPermissions(targetSocket, roomCode, memberId, cleanText(targetSocket.data.adminToken, 120));
    }
  }

  function scheduleAdminFailover(roomCode: string): void {
    const reconnect = roomService.getAdminReconnectRemainingMs(roomCode);
    if (!reconnect) return;
    const timer = setTimeout(() => {
      const result = roomService.finalizeAdminDeparture(roomCode, reconnect.memberId);
      if (!result) return;
      const targetSocket = io.sockets.sockets.get(result.socketId);
      if (targetSocket && getSocketRoomCode(targetSocket) === roomCode && getSocketMemberId(targetSocket) === result.memberId) {
        targetSocket.data.adminToken = result.adminToken;
        targetSocket.emit('room_admin_token', {
          roomCode,
          adminToken: result.adminToken,
          delegated: true,
        });
      }
      refreshRoomPermissions(roomCode);
      emitRoomState(io, roomCode, result.state);
    }, reconnect.remainingMs + 50);
    timer.unref();
  }

  function scheduleMemberDeparture(roomCode: string, memberId: string, memberName: string, reconnectUntil: number): void {
    const timer = setTimeout(() => {
      const nextState = roomService.finalizeMemberDeparture(roomCode, memberId, memberName, reconnectUntil);
      if (!nextState) return;
      const systemMessage = nextState.chat.at(-1);
      if (systemMessage?.kind === 'system') {
        io.to(roomCode).emit('chat_message_created', systemMessage);
      }
      emitRoomState(io, roomCode, nextState);
    }, Math.max(25, reconnectUntil - Date.now() + 25));
    timer.unref();
  }

  io.on('connection', (socket) => {
    socket.on('join_room', async (payload: JoinPayload, ack?: RoomAck) => {
      const attemptId = cleanText(payload?.attemptId, 80);
      if (socket.data.joinPending) {
        socket.emit('room_error', { message: '正在验证房间身份，请稍候', code: 'join_pending', attemptId });
        ack?.(null);
        return;
      }
      socket.data.joinPending = true;
      try {
      const roomCode = normalizeRoomCode(payload?.roomCode || '默认房间');
      const memberId = cleanText(payload?.memberId, MAX_MEMBER_ID_LENGTH) || socket.id;
      const clientId = cleanText(payload?.clientId, MAX_CLIENT_ID_LENGTH);
      const reconnectToken = cleanText(payload?.reconnectToken, 120);
      const adminToken = cleanText(payload?.adminToken, 120);
      const password = cleanPassword(payload?.password);
      const joinClientAddress = getTrustedClientAddress(socket.request);
      const joinRateKey = `${joinClientAddress}:${roomCode}`;
      if (!joinGlobalRateLimiter.allow(joinClientAddress, JOIN_GLOBAL_RATE_LIMIT.limit, JOIN_GLOBAL_RATE_LIMIT.windowMs)
        || !joinRateLimiter.allow(joinRateKey, JOIN_RATE_LIMIT.limit, JOIN_RATE_LIMIT.windowMs)) {
        socket.emit('room_error', { message: '进入房间尝试过于频繁，请稍后再试', code: 'join_rate_limited', attemptId });
        ack?.(null);
        return;
      }
      const boundRoomCode = getSocketRoomCode(socket);
      const boundMemberId = getSocketMemberId(socket);
      if ((boundRoomCode && boundRoomCode !== roomCode) || (boundMemberId && boundMemberId !== memberId)) {
        socket.emit('room_error', { message: '当前连接已经加入其他房间或成员身份，请刷新页面后重试', code: 'socket_already_joined', attemptId });
        ack?.(null);
        return;
      }
      const alreadyOnline = roomService.hasMember(roomCode, memberId);
      const recognizedReconnect = roomService.isRecognizedReconnect(roomCode, memberId, reconnectToken, socket.id);
      const adminAuthorized = roomService.isCreatorAdmin(roomCode, memberId, adminToken);
      const passwordRateKey = `${getTrustedClientAddress(socket.request)}:${roomCode}`;
      if (password && !recognizedReconnect && !adminAuthorized
        && !passwordRateLimiter.allow(passwordRateKey, PASSWORD_RATE_LIMIT.limit, PASSWORD_RATE_LIMIT.windowMs)) {
        socket.emit('room_error', { message: '密码尝试过于频繁，请稍后再试', code: 'password_rate_limited', attemptId });
        ack?.(null);
        return;
      }
      const rejection = await roomService.getJoinRejection(
        roomCode,
        memberId,
        password,
        adminToken,
        reconnectToken,
        socket.id,
        clientId,
      );
      if (rejection) {
        logJoinRejection(socket, roomCode, adminToken, rejection.code);
        socket.emit('room_error', { message: rejection.message, code: rejection.code, attemptId });
        ack?.(null);
        return;
      }
      passwordRateLimiter.delete(passwordRateKey);

      let state = roomService.joinRoom({
        roomCode,
        roomName: payload?.roomName,
        memberId,
        socketId: socket.id,
        name: cleanText(payload?.name, MAX_MEMBER_NAME_LENGTH),
        reconnectToken,
        adminToken,
        clientId,
      });

      socket.data.roomCode = roomCode;
      socket.data.memberId = memberId;
      registerMediaProxySession(
        socket.id,
        roomCode,
        memberId,
        createMediaProxyClientBinding(
          getTrustedClientAddress(socket.request),
          String(socket.request.headers['user-agent'] || ''),
        ),
      );
      socket.join(roomCode);

      if (!alreadyOnline && !recognizedReconnect) {
        const joinedName = findMemberName(state, memberId);
        const nextState = roomService.addChat(roomCode, {
          kind: 'system',
          senderId: 'system',
          senderName: '系统',
          text: `${joinedName || '成员'} 加入了房间`,
          memberId,
          systemEvent: 'member_joined',
        });
        if (nextState) {
          state = nextState;
          const systemMessage = state.chat.at(-1);
          if (systemMessage?.kind === 'system') {
            io.to(roomCode).emit('chat_message_created', systemMessage);
          }
        }
      }

      ack?.(state);
      const memberReconnectToken = roomService.claimPendingMemberReconnectToken(roomCode, memberId);
      if (memberReconnectToken) {
        socket.emit('room_member_token', { roomCode, memberId, reconnectToken: memberReconnectToken });
      }
      const credentials = roomService.claimPendingAdminCredentials(roomCode, memberId);
      if (credentials) {
        socket.emit('room_admin_token', { roomCode, ...credentials });
      } else {
        const recoveryCode = roomService.claimPendingAdminRecoveryCode(roomCode, memberId, adminToken);
        if (recoveryCode) socket.emit('room_admin_token', { roomCode, adminToken, recoveryCode });
      }
      emitRoomPermissions(socket, roomCode, memberId, credentials?.adminToken || adminToken);
      emitRoomState(io, roomCode, state);
      if (state.hostMemberId && !state.members.some((member) => member.id === state.hostMemberId)) {
        scheduleHostFailover(roomCode, state.hostMemberId);
      }
      scheduleAdminFailover(roomCode);
      } catch {
        socket.emit('room_error', { message: '房间身份验证失败，请稍后重试', code: 'join_failed', attemptId });
        ack?.(null);
      } finally {
        socket.data.joinPending = false;
      }
    });

    socket.on('recover_admin_token', (payload: RecoverAdminPayload, ack?: (result: { ok: boolean; message?: string; state?: RoomState }) => void) => {
      const roomCode = normalizeRoomCode(payload?.roomCode || getSocketRoomCode(socket) || '');
      const joinedMemberId = getSocketMemberId(socket);
      const memberId = cleanText(joinedMemberId || payload?.memberId || socket.id, 80);
      const memberName = cleanText(payload?.name || findMemberName(roomService.getRoom(roomCode), memberId), MAX_MEMBER_NAME_LENGTH);
      const result = roomService.recoverAdminToken(roomCode, cleanText(payload?.recoveryCode, 120), {
        memberId,
        memberName,
        socketId: socket.id,
      });
      if (!result) {
        ack?.({ ok: false, message: '恢复码无效、已失效，或创建者仍在其他页面在线' });
        return;
      }

      socket.emit('room_admin_token', { roomCode, adminToken: result.adminToken, recoveryCode: result.recoveryCode, recovered: true });
      socket.data.adminToken = result.adminToken;
      refreshRoomPermissions(roomCode);
      ack?.({ ok: true, state: result.state });
      emitRoomState(io, roomCode, result.state);
    });

    socket.on('member_rename', (payload: MemberRenamePayload, ack?: RoomAck) => {
      const context = requireRoomMember(socket, payload?.roomCode, ack);
      if (!context) return;
      const name = cleanText(payload?.name, MAX_MEMBER_NAME_LENGTH);
      if (!name) {
        rejectRoomAction(socket, '昵称不能为空', context.state, ack);
        return;
      }
      const state = roomService.renameMember(context.roomCode, context.memberId, name);
      ack?.(state);
      if (state) emitRoomState(io, context.roomCode, state);
    });

    socket.on('proxy_token_request', async (payload: ProxyTokenPayload) => {
      const requestId = cleanText(payload?.requestId, 80);
      let logRoomCode = normalizeRoomCode(payload?.roomCode || '');
      let logMemberId = getSocketMemberId(socket) || '';
      let logRouteName = payload?.routeName === 'media' ? 'media' : payload?.routeName === 'hls' ? 'hls' : '';
      let logUrl = cleanUrl(payload?.url);
      let playlistMatched = false;
      let grantMode = 'none';
      let revalidationAttempted = false;
      const respond = (result: Record<string, unknown>) => {
        const success = result.success === true;
        const reason = success ? 'granted' : cleanText(result.code, 80) || 'authorization_failed';
        const roomFingerprint = diagnosticFingerprint('room', logRoomCode);
        const actorFingerprint = diagnosticFingerprint('actor', logMemberId);
        logStructuredEvent('proxy_grant_decision', {
          roomFingerprint,
          actorFingerprint,
          sourceFingerprint: diagnosticFingerprint('source', canonicalProxySourceUrl(logUrl) || logUrl),
          clientType: classifyClientType(socket.request.headers['user-agent']),
          routeName: logRouteName,
          decision: success ? 'accepted' : 'rejected',
          reason,
          playlistMatched,
          grantMode,
          revalidationAttempted,
        }, {
          level: success ? 'info' : 'warn',
          suppressKey: `${roomFingerprint}:${actorFingerprint}:${diagnosticFingerprint('source', canonicalProxySourceUrl(logUrl) || logUrl) || 'none'}:${logRouteName}:${success ? 'accepted' : 'rejected'}:${reason}`,
        });
        socket.emit('proxy_token_created', { requestId, ...result });
      };
      const context = requireRoomMember(socket, payload?.roomCode);
      if (!context) {
        respond({ success: false, code: 'room_access_required', message: '请先加入当前房间' });
        return;
      }
      logRoomCode = context.roomCode;
      logMemberId = context.memberId;
      const rateKey = `${context.roomCode}:${context.memberId}`;
      if (!proxyTokenRateLimiter.allow(rateKey, PROXY_TOKEN_RATE_LIMIT.limit, PROXY_TOKEN_RATE_LIMIT.windowMs)) {
        respond({ success: false, code: 'parse_authorization_busy', message: '授权解析繁忙，请稍后再试' });
        return;
      }
      const routeName = logRouteName === 'media' ? 'media' : logRouteName === 'hls' ? 'hls' : null;
      const url = logUrl;
      if (!requestId || !routeName || !url) {
        respond({ success: false, code: 'parse_source_denied', message: '当前视频源不在可解析范围' });
        return;
      }
      let playlistItem = findProxyPlaylistItem(context.state, routeName, url);
      playlistMatched = Boolean(playlistItem);
      if (!playlistItem) {
        respond({ success: false, code: 'parse_source_denied', message: '当前视频源不在可解析范围' });
        return;
      }
      const authoritativeRefUrl = playlistItem
        ? (playlistItem.refererUrl || playlistItem.pageUrl || playlistItem.sourceUrl)
        : cleanUrl(payload?.refUrl);
      try {
        const grant = issueMediaProxyGrant(routeName, url, authoritativeRefUrl, { sessionId: socket.id });
        grantMode = 'allowlist';
        respond({ success: true, ...grant });
        return;
      } catch (error) {
        const failure = toPublicMediaGrantFailure(error);
        if (failure.code !== 'parse_option_missing' && failure.code !== 'parse_source_denied') {
          respond({ success: false, ...failure });
          return;
        }
      }

      try {
        const grant = issueMediaProxyGrant(routeName, url, authoritativeRefUrl, {
          allowVerifiedDirect: true,
          sessionId: socket.id,
        });
        grantMode = 'verified_direct';
        respond({ success: true, ...grant });
        return;
      } catch (error) {
        const failure = toPublicMediaGrantFailure(error);
        if (failure.code !== 'parse_option_missing' && failure.code !== 'parse_source_denied') {
          respond({ success: false, ...failure });
          return;
        }
      }

      try {
        revalidationAttempted = true;
        const parsed = await parseVideoUrl(url, { force: true });
        const expectedType = routeName === 'hls' ? 'hls' : 'video';
        if (!parsed.success
          || parsed.type !== expectedType
          || canonicalProxySourceUrl(parsed.src) !== canonicalProxySourceUrl(url)) {
          respond({ success: false, code: 'parse_source_denied', message: '当前视频源不在可解析范围' });
          return;
        }

        const refreshedContext = requireRoomMember(socket, payload?.roomCode);
        if (!refreshedContext) {
          respond({ success: false, code: 'room_access_required', message: '请先加入当前房间' });
          return;
        }
        playlistItem = findProxyPlaylistItem(refreshedContext.state, routeName, url);
        playlistMatched = Boolean(playlistItem);
        if (!playlistItem) {
          respond({ success: false, code: 'parse_source_denied', message: '当前视频源不在可解析范围' });
          return;
        }
        const refreshedRefUrl = playlistItem.refererUrl || playlistItem.pageUrl || playlistItem.sourceUrl;
        const grant = issueMediaProxyGrant(routeName, url, refreshedRefUrl, {
          allowVerifiedDirect: true,
          sessionId: socket.id,
        });
        grantMode = 'revalidated_direct';
        respond({ success: true, ...grant });
      } catch (error) {
        respond({ success: false, ...toPublicMediaGrantFailure(error) });
      }
    });

    socket.on('playlist_add', async (payload: PlaylistPayload, ack?: RoomAck) => {
      const sourceId = cleanText(payload?.item?.id, 80);
      const sourceType = ALLOWED_SOURCE_TYPES.has(payload?.item?.sourceType as SourceType)
        ? payload.item.sourceType as SourceType
        : undefined;
      const observation: ControllerObservation = { category: 'playlist', action: 'add', sourceId, sourceType };
      let context = requireController(socket, payload?.roomCode, ack, observation);
      if (!context) return;
      if (!requireActionRate(socket, context, playlistRateLimiter, PLAYLIST_RATE_LIMIT, '播放列表操作太频繁，请稍后再试', ack, observation)) return;
      if (context.state.playlist.length >= env.roomMaxPlaylistItems) {
        logPlaylistDecision(socket, context.roomCode, context.memberId, 'add', 'rejected', 'capacity', context.state, context.state, sourceId, sourceType);
        rejectRoomAction(socket, `播放列表最多保留 ${env.roomMaxPlaylistItems} 项`, context.state, ack);
        return;
      }
      const item = sanitizePlaylistItem(payload?.item, context.memberId);
      if (!item) {
        logPlaylistDecision(socket, context.roomCode, context.memberId, 'add', 'rejected', 'invalid_payload', context.state, context.state, sourceId, sourceType);
        rejectRoomAction(socket, '播放项参数无效', context.state, ack);
        return;
      }

      try {
        await validatePlaylistRemoteAddresses(item);
      } catch {
        logPlaylistDecision(socket, context.roomCode, context.memberId, 'add', 'rejected', 'remote_address_denied', context.state, context.state, item.id, item.sourceType);
        rejectRoomAction(socket, '播放项地址不可用或未通过公网安全校验', context.state, ack);
        return;
      }

      context = requireController(socket, payload?.roomCode, ack, observation);
      if (!context) return;
      if (context.state.playlist.length >= env.roomMaxPlaylistItems) {
        logPlaylistDecision(socket, context.roomCode, context.memberId, 'add', 'rejected', 'capacity', context.state, context.state, item.id, item.sourceType);
        rejectRoomAction(socket, `播放列表最多保留 ${env.roomMaxPlaylistItems} 项`, context.state, ack);
        return;
      }
      const before = snapshotPlaylistLogState(context.state);
      let state: RoomState;
      try {
        state = roomService.addPlaylistItem(context.roomCode, item);
      } catch (error) {
        logPlaylistDecision(socket, context.roomCode, context.memberId, 'add', 'rejected', 'store_capacity', context.state, context.state, item.id, item.sourceType);
        const message = error instanceof Error ? error.message : '播放项参数无效';
        rejectRoomAction(socket, message, context.state, ack);
        return;
      }

      const addedItem = state.playlist.at(-1);
      logPlaylistDecision(socket, context.roomCode, context.memberId, 'add', 'accepted', 'accepted', before, state, addedItem?.id, addedItem?.sourceType);
      ack?.(state);
      emitRoomState(io, context.roomCode, state);
    });

    socket.on('playlist_rename', (payload: PlaylistActionPayload, ack?: RoomAck) => {
      const itemId = cleanText(payload?.itemId, 80);
      const observation: ControllerObservation = { category: 'playlist', action: 'rename', sourceId: itemId };
      const context = requireController(socket, payload?.roomCode, ack, observation);
      if (!context) return;
      if (!requireActionRate(socket, context, playlistRateLimiter, PLAYLIST_RATE_LIMIT, '播放列表操作太频繁，请稍后再试', ack, observation)) return;
      if (!itemId || !context.state.playlist.some((item) => item.id === itemId)) {
        logPlaylistDecision(socket, context.roomCode, context.memberId, 'rename', 'rejected', itemId ? 'item_not_found' : 'invalid_payload', context.state, context.state, itemId);
        rejectRoomAction(socket, '播放项不存在或参数无效', context.state, ack);
        return;
      }
      const before = snapshotPlaylistLogState(context.state);
      const state = roomService.renamePlaylistItem(context.roomCode, itemId, cleanText(payload?.title, MAX_PLAYLIST_TITLE_LENGTH));
      if (state) logPlaylistDecision(socket, context.roomCode, context.memberId, 'rename', 'accepted', 'accepted', before, state, itemId);
      ack?.(state);
      if (state) emitRoomState(io, context.roomCode, state);
    });

    socket.on('playlist_bilibili_danmaku_update', (payload: PlaylistBilibiliDanmakuPayload, ack?: RoomAck) => {
      const itemId = cleanText(payload?.itemId, 80);
      const observation: ControllerObservation = { category: 'playlist', action: 'danmaku_toggle', sourceId: itemId };
      const context = requireController(socket, payload?.roomCode, ack, observation);
      if (!context) return;
      if (!requireActionRate(socket, context, playlistRateLimiter, PLAYLIST_RATE_LIMIT, '播放列表操作太频繁，请稍后再试', ack, observation)) return;
      const sourceItem = context.state.playlist.find((item) => item.id === itemId);
      if (!itemId || !sourceItem?.bilibili?.danmakuAvailable) {
        logPlaylistDecision(socket, context.roomCode, context.memberId, 'danmaku_toggle', 'rejected', itemId ? 'item_not_found' : 'invalid_payload', context.state, context.state, itemId);
        rejectRoomAction(socket, '播放项不存在或不支持原弹幕', context.state, ack);
        return;
      }
      const before = snapshotPlaylistLogState(context.state);
      const state = roomService.updatePlaylistBilibiliDanmaku(
        context.roomCode,
        itemId,
        payload.enabled === true,
      );
      if (state) logPlaylistDecision(socket, context.roomCode, context.memberId, 'danmaku_toggle', 'accepted', 'accepted', before, state, itemId, sourceItem.sourceType);
      ack?.(state);
      if (state) emitRoomState(io, context.roomCode, state);
    });

    socket.on('playlist_bilibili_source_refresh', async (payload: PlaylistBilibiliRefreshPayload, ack?: RoomAck) => {
      const itemId = cleanText(payload?.itemId, 80);
      const observation: ControllerObservation = { category: 'playlist', action: 'bilibili_refresh', sourceId: itemId, sourceType: 'video' };
      const context = requireRoomMember(socket, payload?.roomCode, ack);
      if (!context) return;
      if (!requireActionRate(socket, context, bilibiliRefreshRateLimiter, BILIBILI_REFRESH_RATE_LIMIT, '播放地址刷新过于频繁，请稍后再试', ack, observation)) return;
      const sourceItem = context.state.playlist.find((item) => item.id === itemId);
      if (!itemId || !sourceItem?.bilibili || sourceItem.sourceType !== 'video' || !isBilibiliPageUrl(sourceItem.pageUrl)) {
        logPlaylistDecision(socket, context.roomCode, context.memberId, 'bilibili_refresh', 'rejected', itemId ? 'item_not_refreshable' : 'invalid_payload', context.state, context.state, itemId, sourceItem?.sourceType);
        rejectRoomAction(socket, '当前播放项不支持刷新解析地址', context.state, ack);
        return;
      }

      const taskKey = `${context.roomCode}:${itemId}`;
      let task = bilibiliRefreshTasks.get(taskKey);
      if (!task) {
        if (!bilibiliRefreshItemRateLimiter.allow(taskKey, 1, BILIBILI_REFRESH_ITEM_COOLDOWN_MS)) {
          const latest = roomService.getRoom(context.roomCode);
          logPlaylistDecision(socket, context.roomCode, context.memberId, 'bilibili_refresh', 'rejected', 'cooldown', context.state, latest || context.state, itemId, sourceItem.sourceType);
          ack?.(latest);
          return;
        }
        task = refreshBilibiliPlaylistSource(io, context.roomCode, itemId)
          .catch(() => ({
            state: roomService.getRoom(context.roomCode),
            success: false,
            changed: false,
            reason: 'refresh_failed',
            message: 'B站播放地址刷新失败，请稍后重试',
          }))
          .finally(() => {
            if (bilibiliRefreshTasks.get(taskKey) === task) bilibiliRefreshTasks.delete(taskKey);
          });
        bilibiliRefreshTasks.set(taskKey, task);
      }

      const before = snapshotPlaylistLogState(context.state);
      const result = await task;
      const latest = result.state || roomService.getRoom(context.roomCode);
      logPlaylistDecision(
        socket,
        context.roomCode,
        context.memberId,
        'bilibili_refresh',
        result.success ? 'accepted' : 'rejected',
        result.reason,
        before,
        latest || before,
        itemId,
        sourceItem.sourceType,
      );
      ack?.(latest);
      if (!result.success) socket.emit('room_error', { message: result.message, state: latest });
    });

    socket.on('room_autoplay_next_update', (payload: RoomAutoPlayNextPayload, ack?: RoomAck) => {
      const observation: ControllerObservation = { category: 'playlist', action: 'autoplay_next' };
      const context = requireController(socket, payload?.roomCode, ack, observation);
      if (!context) return;
      if (!requireActionRate(socket, context, playlistRateLimiter, PLAYLIST_RATE_LIMIT, '播放队列操作太频繁，请稍后再试', ack, observation)) return;
      const before = snapshotPlaylistLogState(context.state);
      const state = roomService.setAutoPlayNext(context.roomCode, payload?.enabled === true, {
        memberId: context.memberId,
        memberName: findMemberName(context.state, context.memberId),
      });
      if (state) logPlaylistDecision(socket, context.roomCode, context.memberId, 'autoplay_next', 'accepted', 'accepted', before, state);
      ack?.(state);
      if (state) emitRoomState(io, context.roomCode, state);
    });

    socket.on('playlist_delete', (payload: PlaylistActionPayload, ack?: RoomAck) => {
      const itemId = cleanText(payload?.itemId, 80);
      const observation: ControllerObservation = { category: 'playlist', action: 'delete', sourceId: itemId };
      const context = requireController(socket, payload?.roomCode, ack, observation);
      if (!context) return;
      if (!requireActionRate(socket, context, playlistRateLimiter, PLAYLIST_RATE_LIMIT, '播放列表操作太频繁，请稍后再试', ack, observation)) return;
      if (!itemId || !context.state.playlist.some((item) => item.id === itemId)) {
        logPlaylistDecision(socket, context.roomCode, context.memberId, 'delete', 'rejected', itemId ? 'item_not_found' : 'invalid_payload', context.state, context.state, itemId);
        rejectRoomAction(socket, '播放项不存在或参数无效', context.state, ack);
        return;
      }
      const before = snapshotPlaylistLogState(context.state);
      const state = roomService.deletePlaylistItem(context.roomCode, itemId);
      if (state) logPlaylistDecision(socket, context.roomCode, context.memberId, 'delete', 'accepted', 'accepted', before, state, itemId);
      ack?.(state);
      if (state) emitRoomState(io, context.roomCode, state);
    });

    socket.on('playlist_move', (payload: PlaylistActionPayload, ack?: RoomAck) => {
      const itemId = cleanText(payload?.itemId, 80);
      const observation: ControllerObservation = { category: 'playlist', action: 'move', sourceId: itemId };
      const context = requireController(socket, payload?.roomCode, ack, observation);
      if (!context) return;
      if (!requireActionRate(socket, context, playlistRateLimiter, PLAYLIST_RATE_LIMIT, '播放列表操作太频繁，请稍后再试', ack, observation)) return;
      const direction = payload?.direction === -1 ? -1 : 1;
      const index = context.state.playlist.findIndex((item) => item.id === itemId);
      if (!itemId || index < 0 || index + direction < 0 || index + direction >= context.state.playlist.length) {
        logPlaylistDecision(socket, context.roomCode, context.memberId, 'move', 'rejected', itemId && index >= 0 ? 'boundary' : itemId ? 'item_not_found' : 'invalid_payload', context.state, context.state, itemId);
        rejectRoomAction(socket, '播放项不存在或已经位于队列边界', context.state, ack);
        return;
      }
      const before = snapshotPlaylistLogState(context.state);
      const state = roomService.movePlaylistItem(context.roomCode, itemId, direction);
      if (state) logPlaylistDecision(socket, context.roomCode, context.memberId, 'move', 'accepted', 'accepted', before, state, itemId);
      ack?.(state);
      if (state) emitRoomState(io, context.roomCode, state);
    });

    socket.on('playback_update', (payload: PlaybackPayload, ack?: RoomAck) => {
      const requestedAction = sanitizePlaybackAction(payload?.action);
      const observation: ControllerObservation = { category: 'playback', action: requestedAction || 'legacy' };
      const context = requireController(socket, payload?.roomCode, ack, observation);
      if (!context) return;
      if (!requireActionRate(socket, context, playbackRateLimiter, PLAYBACK_RATE_LIMIT, '播放操作太频繁，请稍后再试', ack, observation)) return;

      const legacyHostUpdate = !requestedAction && context.state.hostMemberId === context.memberId;
      if (!requestedAction && !legacyHostUpdate) {
        logPlaybackDecision(socket, context.roomCode, context.memberId, 'unknown', 'rejected', 'action_required', {
          currentRevision: context.state.playback.revision,
          nextRevision: context.state.playback.revision,
          previousSourceId: context.state.playback.activeSourceId,
          nextSourceId: context.state.playback.activeSourceId,
        });
        ack?.(context.state);
        socket.emit('playback_state', context.state.playback);
        return;
      }
      const legacyAction: PlaybackAction = payload?.patch?.activeSourceId !== undefined
        && payload.patch.activeSourceId !== context.state.playback.activeSourceId
        ? 'source'
        : payload?.patch?.playing !== undefined && payload.patch.playing !== context.state.playback.playing
          ? (payload.patch.playing ? 'play' : 'pause')
          : payload?.patch?.playbackRate !== undefined && payload.patch.playbackRate !== context.state.playback.playbackRate
            ? 'rate'
            : payload?.patch?.currentTime !== undefined
              && Math.abs(Number(payload.patch.currentTime) - context.state.playback.currentTime) > 2.75
              ? 'seek'
              : 'periodic';
      const action = requestedAction || legacyAction;
      const baseRevision = Number.isSafeInteger(payload?.baseRevision)
        ? Number(payload.baseRevision)
        : (legacyHostUpdate ? context.state.playback.revision : -1);
      const decision = roomService.updatePlaybackWithDecision(context.roomCode, {
        ...sanitizePlaybackPatch(payload?.patch),
        updatedBy: context.memberId,
      }, {
        memberId: context.memberId,
        action,
        baseRevision,
        clientReady: legacyHostUpdate || payload?.client?.ready === true,
        clientSeeking: payload?.client?.seeking === true,
      });
      const state = decision.state;
      if (action !== 'periodic' || !decision.accepted || decision.reason !== 'accepted') {
        logPlaybackDecision(
          socket,
          context.roomCode,
          context.memberId,
          action,
          decision.accepted ? 'accepted' : 'rejected',
          decision.reason,
          {
            baseRevision,
            currentRevision: decision.previousRevision,
            nextRevision: decision.nextRevision,
            sourceMatch: decision.sourceMatch,
            clientReady: legacyHostUpdate || payload?.client?.ready === true,
            clientSeeking: payload?.client?.seeking === true,
            leaseOwnerChanged: decision.leaseOwnerChanged,
            previousSourceId: context.state.playback.activeSourceId,
            nextSourceId: state?.playback.activeSourceId,
            timelineDeltaSeconds: decision.timelineDeltaSeconds,
          },
        );
      }
      ack?.(state);
      if (state && decision.accepted) {
        socket.to(context.roomCode).emit('playback_state', state.playback);
      } else if (state) {
        socket.emit('playback_state', state.playback);
      }
    });

    socket.on('transfer_host', (payload: { roomCode: string; memberId: string }, ack?: RoomAck) => {
      if (!payload?.memberId) return;
      const context = requireHost(socket, payload?.roomCode, ack);
      if (!context) return;
      const targetMemberId = cleanText(payload.memberId, 80);
      if (!roomService.hasMember(context.roomCode, targetMemberId)) {
        rejectRoomAction(socket, '只能转让给当前在线成员', context.state, ack);
        return;
      }
      const state = roomService.transferHost(context.roomCode, targetMemberId, {
        memberId: context.memberId,
        memberName: findMemberName(context.state, context.memberId),
      });
      ack?.(state);
      if (state) emitRoomState(io, context.roomCode, state);
    });

    socket.on('room_lock_update', (payload: RoomLockPayload, ack?: RoomAck) => {
      const context = requireAdmin(socket, payload?.roomCode, payload?.adminToken, ack);
      if (!context) return;
      const state = roomService.setRoomLocked(context.roomCode, payload?.locked === true, {
        memberId: context.memberId,
        memberName: findMemberName(context.state, context.memberId),
      });
      ack?.(state);
      if (state) emitRoomState(io, context.roomCode, state);
    });

    socket.on('room_control_policy_update', (payload: RoomControlPolicyPayload, ack?: RoomAck) => {
      const context = requireAdmin(socket, payload?.roomCode, payload?.adminToken, ack);
      if (!context) return;
      const nextPolicy = payload?.controlPolicy === 'everyone' ? 'everyone' : 'host_only';
      const state = roomService.setControlPolicy(context.roomCode, nextPolicy, {
        memberId: context.memberId,
        memberName: findMemberName(context.state, context.memberId),
      });
      ack?.(state);
      if (state) emitRoomState(io, context.roomCode, state);
    });

    socket.on('kick_member', (payload: KickMemberPayload, ack?: RoomAck) => {
      if (!payload?.memberId) return;
      const context = requireAdmin(socket, payload?.roomCode, payload?.adminToken, ack);
      if (!context) return;
      const targetMemberId = cleanText(payload.memberId, 80);
      if (targetMemberId === context.memberId) {
        rejectRoomAction(socket, '不能踢出自己', context.state, ack);
        return;
      }
      if (targetMemberId === context.state.hostMemberId) {
        rejectRoomAction(socket, '不能踢出当前房主', context.state, ack);
        return;
      }
      if (!roomService.hasMember(context.roomCode, targetMemberId)) {
        rejectRoomAction(socket, '该成员已不在房间中', context.state, ack);
        return;
      }

      const result = roomService.kickMember(context.roomCode, targetMemberId, undefined, {
        memberId: context.memberId,
        memberName: findMemberName(context.state, context.memberId),
      });
      if (!result) {
        rejectRoomAction(socket, '踢出成员失败', context.state, ack);
        return;
      }

      ack?.(result.state);
      const systemMessage = result.state.chat.at(-1);
      if (systemMessage?.kind === 'system') {
        io.to(context.roomCode).emit('chat_message_created', systemMessage);
      }
      emitRoomState(io, context.roomCode, result.state);
      if (result.kickedSocketId) {
        const targetSocket = io.sockets.sockets.get(result.kickedSocketId);
        revokeMediaProxySession(result.kickedSocketId);
        targetSocket?.emit('room_kicked', { message: '你已被房主请出该房间，请稍后再试' });
        targetSocket?.leave(context.roomCode);
        targetSocket?.disconnect(true);
      }
    });

    socket.on('room_password_update', async (payload: RoomPasswordPayload, ack?: RoomAck) => {
      const context = requireAdmin(socket, payload?.roomCode, payload?.adminToken, ack);
      if (!context) return;
      const password = cleanPassword(payload?.password);
      if (password && password.length < 4) {
        rejectRoomAction(socket, '房间密码至少 4 个字符', context.state, ack);
        return;
      }
      try {
        const state = await roomService.setRoomPassword(context.roomCode, password, {
          memberId: context.memberId,
          memberName: findMemberName(context.state, context.memberId),
        }, {
          memberId: context.memberId,
          adminToken: cleanText(payload?.adminToken, 120),
        });
        ack?.(state);
        if (state) emitRoomState(io, context.roomCode, state);
      } catch {
        rejectRoomAction(socket, '房间密码暂时无法安全保存，请稍后重试', context.state, ack);
      }
    });

    socket.on('chat_message', (payload: { roomCode: string; text: string }, ack?: RoomAck) => {
      const context = requireRoomMember(socket, payload?.roomCode, ack);
      if (!context) return;
      const rateKey = `${context.roomCode}:${context.memberId}`;
      if (!chatRateLimiter.allow(rateKey, CHAT_RATE_LIMIT.limit, CHAT_RATE_LIMIT.windowMs)) {
        rejectRoomAction(socket, '发送消息太频繁，请稍后再试', context.state, ack);
        return;
      }
      const text = cleanText(payload?.text, MAX_CHAT_TEXT_LENGTH);
      if (!text) return;
      const state = roomService.addChat(context.roomCode, {
        kind: 'user',
        senderId: context.memberId,
        senderName: findMemberName(context.state, context.memberId),
        text,
      });
      ack?.(state);
      if (state) {
        const createdMessage = state.chat.at(-1);
        if (createdMessage) {
          io.to(context.roomCode).emit('chat_message_created', createdMessage);
          io.to(context.roomCode).emit('danmaku_message_created', createDanmakuMessage(
            context.roomCode,
            context.memberId,
            createdMessage.senderName,
            createdMessage.text,
          ));
        }
        emitRoomState(io, context.roomCode, state);
      }
    });

    socket.on('danmaku_message', (payload: { roomCode: string; text: string }, ack?: RoomAck) => {
      const context = requireRoomMember(socket, payload?.roomCode, ack);
      if (!context) return;
      const rateKey = `${context.roomCode}:${context.memberId}`;
      if (!danmakuRateLimiter.allow(rateKey, DANMAKU_RATE_LIMIT.limit, DANMAKU_RATE_LIMIT.windowMs)) {
        rejectRoomAction(socket, '弹幕发送太频繁，请稍后再试', context.state, ack);
        return;
      }
      const text = cleanText(payload?.text, MAX_DANMAKU_TEXT_LENGTH);
      if (!text) return;
      const state = roomService.addChat(context.roomCode, {
        kind: 'user',
        senderId: context.memberId,
        senderName: findMemberName(context.state, context.memberId),
        text,
      });
      ack?.(state);
      if (state) {
        const createdMessage = state.chat.at(-1);
        if (createdMessage) {
          io.to(context.roomCode).emit('chat_message_created', createdMessage);
          io.to(context.roomCode).emit('danmaku_message_created', createDanmakuMessage(
            context.roomCode,
            context.memberId,
            createdMessage.senderName,
            createdMessage.text,
          ));
        }
        emitRoomState(io, context.roomCode, state);
      }
    });

    socket.on('ping_latency', (payload: { roomCode: string; clientTime: number }, ack?: (serverTime: number) => void) => {
      ack?.(Date.now());
    });

    socket.on('disconnect', () => {
      suspendMediaProxySession(socket.id, env.roomReconnectGraceMs);
      const changes = roomService.leaveBySocket(socket.id);
      changes.forEach(({ roomCode, state, departedHostId, departedAdminId, memberId, memberName, reconnectUntil }) => {
        emitRoomState(io, roomCode, state);
        scheduleMemberDeparture(roomCode, memberId, memberName, reconnectUntil);
        if (departedHostId) scheduleHostFailover(roomCode, departedHostId);
        if (departedAdminId) scheduleAdminFailover(roomCode);
      });
    });
  });

  return io;
}
