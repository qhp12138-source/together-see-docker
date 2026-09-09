import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { createId, normalizeRoomCode } from '../utils/id.js';
import { createLocalPlaceholderUrl, hasUsableLocalFileMeta } from '../utils/local-media.js';
import { isBilibiliPageUrl, sanitizeBilibiliSourceMeta } from '../utils/bilibili.js';
import { assertPublicHttpUrl } from '../utils/remote-url.js';
import { roomStore, type PersistedRoomState } from './room-store.service.js';
import type { ChatMessage, PlaybackAction, PlaybackState, PlaylistItem, RoomAuditEntry, RoomMember, RoomSecurity, RoomState } from '../types/room.js';

interface InternalRoomMember extends RoomMember {
  socketId: string;
  clientIdentityHash: string;
}

interface InternalRoomState extends Omit<RoomState, 'members'> {
  members: Map<string, InternalRoomMember>;
  hostAssignment: 'creator' | 'manual' | 'automatic';
  emptySince: number | null;
  kickedMembers: Map<string, number>;
  reconnectUntil: Map<string, number>;
  memberReconnectHashes: Map<string, string>;
  pendingMemberReconnectTokens: Map<string, string>;
  hostReconnectUntil: number | null;
  creatorPending: boolean;
  creatorMemberId: string | null;
  adminMemberId: string | null;
  adminAssignment: 'creator' | 'automatic';
  adminReconnectUntil: number | null;
  adminTokenHash: string;
  adminRecoveryHash: string;
  passwordHash: string | null;
  passwordSalt: string | null;
  pendingAdminToken?: string;
  pendingAdminRecoveryCode?: string;
}

const rooms = new Map<string, InternalRoomState>();
const DEFAULT_KICK_DURATION_MS = 60 * 60 * 1000;
const SECRET_HASH_ALGORITHM = 'sha256';
const PASSWORD_HASH_PREFIX = 'scrypt$';

interface JoinRejection {
  code: 'room_not_found' | 'creator_pending' | 'kicked' | 'admin_member_mismatch' | 'member_online_elsewhere' | 'reconnect_token_invalid' | 'locked' | 'password_required' | 'password_invalid' | 'room_full';
  message: string;
}

interface AuditActor {
  memberId?: string | null;
  memberName?: string | null;
  socketId?: string | null;
}

interface AuditTarget {
  targetId?: string | null;
  targetName?: string | null;
}

interface AdminCredentials {
  adminToken: string;
  recoveryCode?: string;
}

interface RoomCreationResult {
  state: RoomState;
  credentials: AdminCredentials & { recoveryCode: string };
  created: boolean;
}

interface AdminRecoveryResult extends AdminCredentials {
  state: RoomState;
}

interface AdminFailoverResult {
  state: RoomState;
  memberId: string;
  socketId: string;
  adminToken: string;
}

interface PlaybackUpdateOptions {
  memberId?: string | null;
  action?: PlaybackAction;
  baseRevision?: number;
  clientReady?: boolean;
  clientSeeking?: boolean;
}

export type PlaybackDecisionReason = 'accepted' | 'room_not_found' | 'stale_revision'
  | 'source_not_found' | 'lease_not_owner' | 'client_not_ready' | 'client_seeking'
  | 'source_mismatch' | 'room_not_playing' | 'room_buffering' | 'timeline_outlier' | 'timeline_reanchored';

export interface PlaybackUpdateDecision {
  state: RoomState | null;
  accepted: boolean;
  reason: PlaybackDecisionReason;
  previousRevision: number;
  nextRevision: number;
  sourceMatch: boolean;
  leaseOwnerChanged: boolean;
  timelineDeltaSeconds: number | null;
}

const PLAYBACK_CONTROL_LEASE_MS = 10_000;
const PLAYBACK_PERIODIC_BACKWARD_TOLERANCE_SECONDS = 2.75;
const PLAYBACK_PERIODIC_FORWARD_TOLERANCE_SECONDS = 8;
const ROOM_STORE_RUNTIME_RESERVE_BYTES = Math.min(
  128 * 1024,
  Math.floor(env.roomStoreMaxRoomBytes / 3),
);

function createSecretToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function createRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const raw = Array.from(crypto.randomBytes(25), (value) => alphabet[value & 31]).join('');
  return raw.match(/.{1,5}/g)?.join('-') || raw;
}

function hashSecret(secret: string): string {
  return crypto.createHash(SECRET_HASH_ALGORITHM).update(secret).digest('hex');
}

function clientKickKey(clientId: string): string {
  return clientId ? `client:${hashSecret(clientId)}` : '';
}

function clientKickKeyFromHash(clientIdentityHash: string): string {
  return clientIdentityHash ? `client:${clientIdentityHash}` : '';
}

function cleanRecoveryCode(value: string): string {
  return value.trim().replace(/\s+/g, '').toUpperCase();
}

function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const derived = await derivePassword(password, salt);
  return `${PASSWORD_HASH_PREFIX}${derived.toString('hex')}`;
}

function hashLegacyPassword(password: string, salt: string): string {
  return crypto.createHash(SECRET_HASH_ALGORITHM).update(`${salt}:${password}`).digest('hex');
}

function safeEqualHash(left: string, right: string): boolean {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function defaultPlayback(): PlaybackState {
  return {
    activeSourceId: null,
    playing: false,
    buffering: false,
    currentTime: 0,
    duration: null,
    playbackRate: 1,
    revision: 0,
    controlLeaseUntil: null,
    updatedAt: Date.now(),
    updatedBy: null,
  };
}

function playbackRevision(playback: PlaybackState): number {
  return Number.isSafeInteger(playback.revision) && playback.revision >= 0 ? playback.revision : 0;
}

function predictPlaybackTime(playback: PlaybackState, now = Date.now()): number {
  const baseTime = Number.isFinite(playback.currentTime) ? Math.max(0, playback.currentTime) : 0;
  if (!playback.playing || playback.buffering) return baseTime;
  const rate = Number.isFinite(playback.playbackRate) ? Math.min(3, Math.max(0.25, playback.playbackRate || 1)) : 1;
  return baseTime + Math.max(0, now - playback.updatedAt) / 1000 * rate;
}

function currentPlaybackAuthority(room: InternalRoomState, now = Date.now()): string | null {
  if (room.security.controlPolicy !== 'everyone') return room.hostMemberId;
  const leaseOwner = room.playback.updatedBy;
  const leaseActive = Boolean(
    leaseOwner
    && room.members.has(leaseOwner)
    && (room.playback.buffering || (
      room.playback.controlLeaseUntil
      && room.playback.controlLeaseUntil > now
    ))
  );
  return leaseActive ? leaseOwner : room.hostMemberId;
}

function resetPlaybackAuthority(room: InternalRoomState, memberId: string | null, now = Date.now()): void {
  room.playback.updatedBy = memberId;
  room.playback.updatedAt = now;
  room.playback.revision = playbackRevision(room.playback) + 1;
  room.playback.controlLeaseUntil = null;
  room.playback.buffering = false;
}

function defaultSecurity(): RoomSecurity {
  return {
    locked: false,
    hasPassword: false,
    controlPolicy: 'host_only',
  };
}

function formatMemberSystemMessage(event: ChatMessage['systemEvent'], name: string): string {
  const member = name || '成员';
  if (event === 'member_joined') return `${member} 加入了房间`;
  if (event === 'member_left') return `${member} 离开了房间`;
  if (event === 'member_kicked') return `${member} 被移出了房间`;
  return member;
}

function memberName(room: InternalRoomState, memberId?: string | null): string {
  if (!memberId) return 'System';
  return room.members.get(memberId)?.name || memberId;
}

function appendAudit(
  room: InternalRoomState,
  action: RoomAuditEntry['action'],
  actor: AuditActor = {},
  target: AuditTarget = {},
  detail = '',
): void {
  const actorId = actor.memberId || 'system';
  const targetId = target.targetId || undefined;
  room.audit.push({
    id: createId('audit'),
    action,
    actorId,
    actorName: actor.memberName || memberName(room, actorId),
    targetId,
    targetName: target.targetName || (targetId ? memberName(room, targetId) : undefined),
    detail: detail.slice(0, 240) || undefined,
    createdAt: Date.now(),
  });
  room.audit = room.audit.slice(-100);
}

function currentHostWasManuallyAssigned(room: InternalRoomState): boolean {
  return Boolean(room.hostMemberId && room.hostAssignment === 'manual');
}

function reclaimAutomaticHost(room: InternalRoomState, creatorMemberId: string, actor: AuditActor): boolean {
  if (!creatorMemberId || !room.hostMemberId || room.hostMemberId === creatorMemberId || currentHostWasManuallyAssigned(room)) return false;
  room.hostMemberId = creatorMemberId;
  room.hostAssignment = 'creator';
  room.hostReconnectUntil = null;
  for (const member of room.members.values()) {
    member.role = member.id === creatorMemberId ? 'host' : 'follower';
  }
  if (room.security.controlPolicy === 'host_only') {
    resetPlaybackAuthority(room, creatorMemberId);
  }
  appendAudit(
    room,
    'host_reclaimed',
    actor,
    { targetId: creatorMemberId },
    'Creator reclaimed host control after automatic failover',
  );
  return true;
}

function pruneExpiredKicks(room: InternalRoomState): boolean {
  const now = Date.now();
  let changed = false;
  for (const [memberId, kickedUntil] of room.kickedMembers.entries()) {
    if (kickedUntil <= now) {
      room.kickedMembers.delete(memberId);
      changed = true;
    }
  }
  return changed;
}

function pruneExpiredReconnects(room: InternalRoomState, now = Date.now()): void {
  for (const [memberId, expiresAt] of room.reconnectUntil.entries()) {
    if (expiresAt <= now) {
      room.reconnectUntil.delete(memberId);
      if (!room.members.has(memberId)) {
        room.memberReconnectHashes.delete(memberId);
        room.pendingMemberReconnectTokens.delete(memberId);
      }
    }
  }
}

function hasReconnectReservation(room: InternalRoomState, memberId: string, now = Date.now()): boolean {
  return (room.reconnectUntil.get(memberId) || 0) > now;
}

function countOccupiedMemberSlots(room: InternalRoomState, now = Date.now()): number {
  pruneExpiredReconnects(room, now);
  const occupiedIds = new Set(room.members.keys());
  for (const [memberId, expiresAt] of room.reconnectUntil.entries()) {
    if (expiresAt > now) occupiedIds.add(memberId);
  }
  return occupiedIds.size;
}

function toPublicRoom(room: InternalRoomState): RoomState {
  pruneExpiredKicks(room);
  return {
    roomCode: room.roomCode,
    roomName: room.roomName,
    hostMemberId: room.hostMemberId,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    playlist: room.playlist,
    playback: room.playback,
    members: Array.from(room.members.values(), ({ socketId: _socketId, clientIdentityHash: _clientIdentityHash, ...member }) => member),
    chat: room.chat.slice(-50),
    audit: room.audit.slice(-50),
    security: {
      locked: room.security.locked,
      hasPassword: Boolean(room.passwordHash),
      controlPolicy: room.security.controlPolicy === 'everyone' ? 'everyone' : 'host_only',
    },
    autoPlayNext: room.autoPlayNext === true,
  };
}

function touch(room: InternalRoomState): void {
  room.updatedAt = Date.now();
}

interface SerializedPersistedRoom {
  state: PersistedRoomState;
  json: string;
  bytes: number;
}

function capturePersistedRoom(room: InternalRoomState, now = Date.now()): PersistedRoomState {
  const reconnectEntries: [string, { tokenHash: string; expiresAt: number }][] = [];
  for (const [memberId, tokenHash] of room.memberReconnectHashes.entries()) {
    const expiresAt = room.members.has(memberId)
      ? now + env.roomReconnectGraceMs
      : (room.reconnectUntil.get(memberId) || 0);
    if (expiresAt > now) reconnectEntries.push([memberId, { tokenHash, expiresAt }]);
  }
  reconnectEntries.sort((left, right) => right[1].expiresAt - left[1].expiresAt);
  const reconnectMembers = Object.fromEntries(reconnectEntries.slice(0, env.roomMaxReconnectEntries));
  const hostReconnectUntil = room.hostMemberId && room.members.has(room.hostMemberId)
    ? now + env.roomHostReconnectGraceMs
    : room.hostReconnectUntil;
  const adminReconnectUntil = room.adminMemberId && room.members.has(room.adminMemberId)
    ? now + env.roomReconnectGraceMs
    : room.adminReconnectUntil;
  return {
    roomCode: room.roomCode,
    roomName: room.roomName,
    hostMemberId: room.hostMemberId,
    hostAssignment: room.hostAssignment,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    emptySince: room.emptySince,
    playlist: room.playlist.map((item) => ({
      ...item,
      localFile: item.localFile ? { ...item.localFile } : item.localFile,
      bilibili: item.bilibili ? { ...item.bilibili } : undefined,
    })),
    playback: { ...room.playback },
    chat: room.chat.slice(-100).map((message) => ({ ...message })),
    audit: room.audit.slice(-100).map((entry) => ({ ...entry })),
    security: {
      locked: room.security.locked,
      hasPassword: Boolean(room.passwordHash),
      controlPolicy: room.security.controlPolicy === 'everyone' ? 'everyone' : 'host_only',
    },
    autoPlayNext: room.autoPlayNext === true,
    kickedMembers: Object.fromEntries([...room.kickedMembers.entries()]
      .filter(([, kickedUntil]) => kickedUntil > now)
      .sort((left, right) => right[1] - left[1])
      .slice(0, env.roomMaxKickedEntries)),
    reconnectMembers,
    hostReconnectUntil,
    creatorPending: room.creatorPending,
    creatorMemberId: room.creatorMemberId,
    adminMemberId: room.adminMemberId,
    adminAssignment: room.adminAssignment,
    adminReconnectUntil,
    adminTokenHash: room.adminTokenHash,
    adminRecoveryHash: room.adminRecoveryHash,
    passwordHash: room.passwordHash,
    passwordSalt: room.passwordSalt,
  };
}

function serializePersistedRoomState(
  persisted: PersistedRoomState,
  maxBytes = env.roomStoreMaxRoomBytes,
): SerializedPersistedRoom {
  let json = JSON.stringify(persisted);
  let bytes = Buffer.byteLength(json, 'utf8');

  // Chat and audit history are bounded, expendable history. Find the smallest
  // chronological prefix to discard with logarithmic re-serialization instead
  // of serializing the whole room once per removed entry.
  if (bytes > maxBytes && (persisted.chat.length > 0 || persisted.audit.length > 0)) {
    const history = [
      ...persisted.chat.map((entry, index) => ({ kind: 'chat' as const, index, createdAt: entry.createdAt })),
      ...persisted.audit.map((entry, index) => ({ kind: 'audit' as const, index, createdAt: entry.createdAt })),
    ].sort((left, right) => left.createdAt - right.createdAt || left.index - right.index);
    let low = 1;
    let high = history.length;
    let accepted: SerializedPersistedRoom | null = null;
    while (low <= high) {
      const dropCount = Math.floor((low + high) / 2);
      let droppedChat = 0;
      let droppedAudit = 0;
      for (const entry of history.slice(0, dropCount)) {
        if (entry.kind === 'chat') droppedChat += 1;
        else droppedAudit += 1;
      }
      const candidate: PersistedRoomState = {
        ...persisted,
        chat: persisted.chat.slice(droppedChat),
        audit: persisted.audit.slice(droppedAudit),
      };
      const candidateJson = JSON.stringify(candidate);
      const candidateBytes = Buffer.byteLength(candidateJson, 'utf8');
      if (candidateBytes <= maxBytes) {
        accepted = { state: candidate, json: candidateJson, bytes: candidateBytes };
        high = dropCount - 1;
      } else {
        low = dropCount + 1;
      }
    }
    if (accepted) return accepted;
  }
  if (bytes > maxBytes) {
    throw new Error('房间内容已达到容量上限，请先删除部分播放项');
  }
  return { state: persisted, json, bytes };
}

function serializePersistedRoom(room: InternalRoomState, maxBytes = env.roomStoreMaxRoomBytes): SerializedPersistedRoom {
  return serializePersistedRoomState(capturePersistedRoom(room), maxBytes);
}

function persistedRoomBytes(room: InternalRoomState): number {
  const admissionLimit = env.roomStoreMaxRoomBytes - ROOM_STORE_RUNTIME_RESERVE_BYTES;
  return serializePersistedRoom(room, admissionLimit).bytes;
}

function assertRoomFitsStore(room: InternalRoomState): void {
  if (persistedRoomBytes(room) > env.roomStoreMaxRoomBytes - ROOM_STORE_RUNTIME_RESERVE_BYTES) {
    throw new Error('房间内容已达到容量上限，请先删除部分播放项');
  }
}

function pruneKickedMembers(room: InternalRoomState, now = Date.now()): void {
  for (const [memberId, kickedUntil] of room.kickedMembers.entries()) {
    if (kickedUntil <= now) room.kickedMembers.delete(memberId);
  }
  if (room.kickedMembers.size <= env.roomMaxKickedEntries) return;
  const oldest = [...room.kickedMembers.entries()].sort((left, right) => left[1] - right[1]);
  for (const [memberId] of oldest.slice(0, room.kickedMembers.size - env.roomMaxKickedEntries)) {
    room.kickedMembers.delete(memberId);
  }
}

function persistRooms(): void {
  roomStore.saveRooms();
}

function flushRooms(): Promise<void> {
  return roomStore.flush();
}

function hydrateRooms(): void {
  const now = Date.now();
  let removedExpiredRoom = false;
  for (const savedRoom of roomStore.loadRooms()) {
    // A null marker means the room was occupied when the process stopped. Give
    // reconnecting clients a fresh grace period after a server restart.
    const emptySince = savedRoom.emptySince === null ? now : savedRoom.emptySince;
    if (now - emptySince >= env.roomEmptyTtlMs) {
      removedExpiredRoom = true;
      continue;
    }
    const adminToken = savedRoom.adminTokenHash ? undefined : createSecretToken();
    const recoveryCode = savedRoom.adminRecoveryHash ? undefined : createRecoveryCode();
    const reconnectEntries = Object.entries(savedRoom.reconnectMembers || {})
      .filter(([, entry]) => entry.expiresAt > now)
      .map(([memberId, entry]) => [memberId, {
        tokenHash: entry.tokenHash,
        expiresAt: Math.min(entry.expiresAt, now + env.roomReconnectGraceMs),
      }] as const);
    rooms.set(savedRoom.roomCode, {
      roomCode: savedRoom.roomCode,
      roomName: savedRoom.roomName,
      hostMemberId: savedRoom.hostMemberId,
      hostAssignment: savedRoom.hostAssignment,
      createdAt: savedRoom.createdAt,
      updatedAt: savedRoom.updatedAt,
      emptySince,
      playlist: savedRoom.playlist,
      playback: savedRoom.playback,
      members: new Map(),
      chat: savedRoom.chat,
      audit: savedRoom.audit || [],
      security: {
        locked: savedRoom.security?.locked === true,
        hasPassword: Boolean(savedRoom.passwordHash),
        controlPolicy: savedRoom.security?.controlPolicy === 'everyone' ? 'everyone' : 'host_only',
      },
      autoPlayNext: savedRoom.autoPlayNext === true,
      kickedMembers: new Map(Object.entries(savedRoom.kickedMembers || {})),
      reconnectUntil: new Map(reconnectEntries.map(([memberId, entry]) => [memberId, entry.expiresAt])),
      memberReconnectHashes: new Map(reconnectEntries.map(([memberId, entry]) => [memberId, entry.tokenHash])),
      pendingMemberReconnectTokens: new Map(),
      hostReconnectUntil: savedRoom.hostReconnectUntil && savedRoom.hostReconnectUntil > now
        ? Math.min(savedRoom.hostReconnectUntil, now + env.roomHostReconnectGraceMs)
        : null,
      creatorPending: savedRoom.creatorPending === true,
      creatorMemberId: savedRoom.creatorMemberId || null,
      adminMemberId: savedRoom.adminMemberId || savedRoom.creatorMemberId || null,
      adminAssignment: savedRoom.adminAssignment === 'automatic' ? 'automatic' : 'creator',
      adminReconnectUntil: savedRoom.adminReconnectUntil && savedRoom.adminReconnectUntil > now
        ? Math.min(savedRoom.adminReconnectUntil, now + env.roomReconnectGraceMs)
        : (savedRoom.adminMemberId && savedRoom.reconnectMembers?.[savedRoom.adminMemberId]?.expiresAt > now
          ? Math.min(savedRoom.reconnectMembers[savedRoom.adminMemberId].expiresAt, now + env.roomReconnectGraceMs)
          : null),
      adminTokenHash: savedRoom.adminTokenHash || hashSecret(adminToken!),
      adminRecoveryHash: savedRoom.adminRecoveryHash || hashSecret(cleanRecoveryCode(recoveryCode!)),
      passwordHash: savedRoom.passwordHash,
      passwordSalt: savedRoom.passwordSalt,
      pendingAdminToken: adminToken,
      pendingAdminRecoveryCode: recoveryCode,
    });
  }
  if (removedExpiredRoom) persistRooms();
}

function persistedRoomSnapshots(): Iterable<string> {
  const snapshotTime = Date.now();
  const generationRooms = Array.from(rooms.values(), (room) => capturePersistedRoom(room, snapshotTime));
  return {
    *[Symbol.iterator]() {
      for (const room of generationRooms) yield serializePersistedRoomState(room).json;
    },
  };
}

roomStore.setSnapshotProvider(persistedRoomSnapshots);
hydrateRooms();

export function flushRoomPersistence(): Promise<void> {
  return flushRooms();
}

export class RoomService {
  expireEmptyRooms(now = Date.now()): string[] {
    const expiredRoomCodes: string[] = [];
    for (const [roomCode, room] of rooms.entries()) {
      if (room.members.size > 0 || room.emptySince === null || now - room.emptySince < env.roomEmptyTtlMs) continue;
      rooms.delete(roomCode);
      expiredRoomCodes.push(roomCode);
    }
    if (expiredRoomCodes.length > 0) persistRooms();
    return expiredRoomCodes;
  }

  getOrCreateRoom(roomCode: string, roomName?: string): RoomState {
    const code = normalizeRoomCode(roomCode);
    this.expireEmptyRooms();
    let room = rooms.get(code);
    if (!room) {
      const now = Date.now();
      room = {
        roomCode: code,
        roomName: roomName?.trim().slice(0, 64) || code,
        hostMemberId: null,
        hostAssignment: 'automatic',
        createdAt: now,
        updatedAt: now,
        emptySince: now,
        playlist: [],
        playback: defaultPlayback(),
        members: new Map(),
        chat: [],
        audit: [],
        security: defaultSecurity(),
        autoPlayNext: false,
        kickedMembers: new Map(),
        reconnectUntil: new Map(),
        memberReconnectHashes: new Map(),
        pendingMemberReconnectTokens: new Map(),
        hostReconnectUntil: null,
        creatorPending: false,
        creatorMemberId: null,
        adminMemberId: null,
        adminAssignment: 'creator',
        adminReconnectUntil: null,
        adminTokenHash: '',
        adminRecoveryHash: '',
        passwordHash: null,
        passwordSalt: null,
      };
      const adminToken = createSecretToken();
      const recoveryCode = createRecoveryCode();
      room.adminTokenHash = hashSecret(adminToken);
      room.adminRecoveryHash = hashSecret(cleanRecoveryCode(recoveryCode));
      room.pendingAdminToken = adminToken;
      room.pendingAdminRecoveryCode = recoveryCode;
      appendAudit(room, 'room_created', { memberId: 'system', memberName: 'System' });
      rooms.set(code, room);
      persistRooms();
    }
    return toPublicRoom(room);
  }

  createRoom(
    roomCode: string,
    roomName?: string,
    requestedCredentials?: AdminCredentials & { recoveryCode: string },
  ): RoomCreationResult | null {
    const code = normalizeRoomCode(roomCode);
    this.expireEmptyRooms();
    const existing = rooms.get(code);
    if (existing) {
      const recoveryHash = hashSecret(cleanRecoveryCode(requestedCredentials?.recoveryCode || ''));
      const samePendingCreator = existing.creatorPending
        && Boolean(requestedCredentials?.adminToken)
        && this.isAdmin(code, requestedCredentials?.adminToken || '')
        && safeEqualHash(existing.adminRecoveryHash, recoveryHash);
      if (!samePendingCreator || !requestedCredentials) return null;
      return { state: toPublicRoom(existing), credentials: requestedCredentials, created: false };
    }
    if (rooms.size >= env.roomMaxActive) return null;
    const state = this.getOrCreateRoom(code, roomName);
    const room = rooms.get(code)!;
    const adminToken = requestedCredentials?.adminToken || room.pendingAdminToken;
    const recoveryCode = requestedCredentials?.recoveryCode || room.pendingAdminRecoveryCode;
    if (!adminToken || !recoveryCode) throw new Error('New room credentials were not initialized');
    room.adminTokenHash = hashSecret(adminToken);
    room.adminRecoveryHash = hashSecret(cleanRecoveryCode(recoveryCode));
    delete room.pendingAdminToken;
    delete room.pendingAdminRecoveryCode;
    room.creatorPending = true;
    persistRooms();
    return { state, credentials: { adminToken, recoveryCode }, created: true };
  }

  getRoom(roomCode: string): RoomState | null {
    this.expireEmptyRooms();
    const room = rooms.get(normalizeRoomCode(roomCode));
    return room ? toPublicRoom(room) : null;
  }

  getJoinDiagnostic(roomCode: string, adminToken?: string): { creatorPending: boolean; adminTokenValid: boolean } {
    const code = normalizeRoomCode(roomCode);
    const room = rooms.get(code);
    return {
      creatorPending: room?.creatorPending === true,
      adminTokenValid: Boolean(room && adminToken && safeEqualHash(room.adminTokenHash, hashSecret(adminToken))),
    };
  }

  async getJoinRejection(
    roomCode: string,
    memberId: string,
    password?: string,
    adminToken?: string,
    reconnectToken?: string,
    socketId?: string,
    clientId?: string,
  ): Promise<JoinRejection | null> {
    this.expireEmptyRooms();
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room) return { code: 'room_not_found', message: '房间不存在或已经销毁，请返回首页重新创建' };
    if (pruneExpiredKicks(room)) persistRooms();
    const now = Date.now();
    pruneExpiredReconnects(room, now);
    const existingMember = room.members.get(memberId);
    const alreadyInRoom = Boolean(existingMember);
    const sameSocket = Boolean(existingMember && socketId && existingMember.socketId === socketId);
    const reconnectWindowOpen = hasReconnectReservation(room, memberId, now);
    const reconnectHash = room.memberReconnectHashes.get(memberId) || '';
    const reconnectTokenValid = Boolean(reconnectHash && reconnectToken)
      && safeEqualHash(reconnectHash, hashSecret(reconnectToken || ''));
    const recognizedReconnect = reconnectTokenValid && !alreadyInRoom && reconnectWindowOpen;
    const adminTokenValid = this.isAdmin(roomCode, adminToken || '');
    const adminMatchesManager = adminTokenValid && room.adminMemberId === memberId;
    const adminMayBindManager = adminTokenValid && !room.adminMemberId
      && (sameSocket || (!alreadyInRoom && !reconnectWindowOpen));
    const adminAllowed = adminMatchesManager || adminMayBindManager;

    const kickedUntil = Math.max(
      room.kickedMembers.get(memberId) || 0,
      room.kickedMembers.get(clientKickKey(clientId || '')) || 0,
    );
    if (kickedUntil > Date.now()) {
      return { code: 'kicked', message: '你已被请出该房间，请稍后再试' };
    }

    if (adminTokenValid && !adminAllowed) {
      return { code: 'admin_member_mismatch', message: '管理凭据与当前成员身份不匹配，请使用恢复码重新绑定管理身份' };
    }

    if (room.creatorPending && !adminAllowed) {
      return { code: 'creator_pending', message: '房间创建者正在完成入房，请稍后再试' };
    }

    if (alreadyInRoom && !sameSocket) {
      return { code: 'member_online_elsewhere', message: '该成员仍在线，新连接不能接管当前身份' };
    }

    if (reconnectWindowOpen && !recognizedReconnect && !adminMatchesManager) {
      return { code: 'reconnect_token_invalid', message: '成员重连凭据无效，请使用新的成员身份加入' };
    }

    const recognizedMember = sameSocket || recognizedReconnect || (adminMatchesManager && reconnectWindowOpen);

    if (!adminAllowed && room.security.locked && !recognizedMember) {
      return { code: 'locked', message: '房间已锁定，暂时不允许新成员加入' };
    }

    if (!adminAllowed && room.passwordHash && !recognizedMember) {
      if (!password) return { code: 'password_required', message: '该房间需要密码' };
      if (!await this.verifyPassword(roomCode, password)) {
        return { code: 'password_invalid', message: '房间密码不正确' };
      }
    }

    if (!adminAllowed && !recognizedMember && countOccupiedMemberSlots(room, now) >= env.roomMaxMembers) {
      return { code: 'room_full', message: `房间人数已达上限（${env.roomMaxMembers} 人）` };
    }

    return null;
  }

  isRecognizedReconnect(roomCode: string, memberId: string, reconnectToken?: string, socketId?: string, now = Date.now()): boolean {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room) return false;
    const existingMember = room.members.get(memberId);
    if (existingMember && socketId && existingMember.socketId === socketId) return true;
    if (!reconnectToken) return false;
    const reconnectAllowed = existingMember
      ? Boolean(socketId && existingMember.socketId === socketId)
      : hasReconnectReservation(room, memberId, now);
    const reconnectHash = room.memberReconnectHashes.get(memberId) || '';
    return reconnectAllowed && Boolean(reconnectHash)
      && safeEqualHash(reconnectHash, hashSecret(reconnectToken));
  }

  joinRoom(params: { roomCode: string; roomName?: string; memberId: string; socketId: string; name?: string; reconnectToken?: string; adminToken?: string; clientId?: string; }): RoomState {
    const code = normalizeRoomCode(params.roomCode);
    this.getOrCreateRoom(code, params.roomName);
    const room = rooms.get(code)!;
    const now = Date.now();
    pruneExpiredReconnects(room, now);
    const existing = room.members.get(params.memberId);
    const sameSocket = existing?.socketId === params.socketId;
    const reconnectWindowOpen = !existing && hasReconnectReservation(room, params.memberId, now);
    const reconnectHash = room.memberReconnectHashes.get(params.memberId) || '';
    const suppliedTokenValid = Boolean(reconnectHash && params.reconnectToken)
      && safeEqualHash(reconnectHash, hashSecret(params.reconnectToken || ''));
    const adminTokenValid = this.isAdmin(code, params.adminToken || '');

    if (adminTokenValid && room.adminMemberId && room.adminMemberId !== params.memberId) {
      throw new Error('Admin credential does not match the bound manager identity');
    }
    if (existing && !sameSocket) {
      throw new Error('Online member identity cannot be replaced by another socket');
    }
    if (reconnectWindowOpen && !suppliedTokenValid && !(adminTokenValid && room.adminMemberId === params.memberId)) {
      throw new Error('Member reconnect credential is invalid');
    }
    if (adminTokenValid && !room.adminMemberId) {
      if ((existing && !sameSocket) || reconnectWindowOpen) throw new Error('Admin credential cannot impersonate an existing member identity');
      room.adminMemberId = params.memberId;
      room.adminAssignment = 'creator';
      if (!room.creatorMemberId) room.creatorMemberId = params.memberId;
    }
    const roomAdmin = adminTokenValid && room.adminMemberId === params.memberId;
    const originalCreatorAdmin = roomAdmin && room.creatorMemberId === params.memberId;
    if (room.creatorPending && !roomAdmin) {
      throw new Error('Room creator admission required');
    }
    if (!existing && !reconnectWindowOpen && !roomAdmin && countOccupiedMemberSlots(room, now) >= env.roomMaxMembers) {
      throw new Error('Room member capacity reached');
    }
    if (room.creatorPending) room.creatorPending = false;
    if (originalCreatorAdmin) {
      reclaimAutomaticHost(room, params.memberId, {
        memberId: params.memberId,
        memberName: params.name || existing?.name,
        socketId: params.socketId,
      });
    }
    const hasHost = Boolean(room.hostMemberId && room.members.has(room.hostMemberId));
    const hostReserved = Boolean(!hasHost && room.hostMemberId && room.hostReconnectUntil && room.hostReconnectUntil > now);
    const isCurrentHost = room.hostMemberId === params.memberId;
    const role: RoomMember['role'] = isCurrentHost || (!hasHost && !hostReserved) ? 'host' : 'follower';

    const member: InternalRoomMember = {
      id: params.memberId,
      socketId: params.socketId,
      clientIdentityHash: params.clientId ? hashSecret(params.clientId) : (existing?.clientIdentityHash || ''),
      name: params.name?.trim() || existing?.name || (role === 'host' ? '房主' : '访客'),
      role,
      joinedAt: existing?.joinedAt || Date.now(),
      latencyMs: existing?.latencyMs ?? null,
    };

    room.members.set(member.id, member);
    if (!sameSocket) {
      const nextReconnectToken = createSecretToken();
      room.memberReconnectHashes.set(member.id, hashSecret(nextReconnectToken));
      room.pendingMemberReconnectTokens.set(member.id, nextReconnectToken);
    }
    room.reconnectUntil.delete(member.id);
    room.emptySince = null;
    if (room.adminMemberId === member.id) room.adminReconnectUntil = null;
    if (role === 'host') {
      room.hostMemberId = member.id;
      room.hostReconnectUntil = null;
      if (originalCreatorAdmin) room.hostAssignment = 'creator';
    }
    touch(room);
    persistRooms();
    return toPublicRoom(room);
  }

  claimPendingMemberReconnectToken(roomCode: string, memberId: string): string | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    const token = room?.pendingMemberReconnectTokens.get(memberId) || null;
    if (token) room?.pendingMemberReconnectTokens.delete(memberId);
    return token;
  }

  claimPendingAdminToken(roomCode: string, memberId: string): string | null {
    return this.claimPendingAdminCredentials(roomCode, memberId)?.adminToken || null;
  }

  claimPendingAdminCredentials(roomCode: string, memberId: string): AdminCredentials | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room || !room.pendingAdminToken) return null;
    if (room.hostMemberId !== memberId) return null;
    if (room.adminMemberId && room.adminMemberId !== memberId) return null;
    if (!room.creatorMemberId) room.creatorMemberId = memberId;
    if (!room.adminMemberId) room.adminMemberId = memberId;
    room.adminAssignment = 'creator';
    room.adminReconnectUntil = null;
    if (room.hostMemberId === memberId) room.hostAssignment = 'creator';
    const credentials: AdminCredentials = {
      adminToken: room.pendingAdminToken,
      recoveryCode: room.pendingAdminRecoveryCode,
    };
    delete room.pendingAdminToken;
    delete room.pendingAdminRecoveryCode;
    touch(room);
    persistRooms();
    return credentials;
  }

  claimPendingAdminRecoveryCode(roomCode: string, memberId: string, adminToken: string): string | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room || !room.pendingAdminRecoveryCode || !this.isCreatorAdmin(roomCode, memberId, adminToken)) return null;
    const recoveryCode = room.pendingAdminRecoveryCode;
    delete room.pendingAdminRecoveryCode;
    return recoveryCode;
  }

  recoverAdminToken(roomCode: string, recoveryCode: string, actor: AuditActor = {}): AdminRecoveryResult | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    const cleanCode = cleanRecoveryCode(recoveryCode);
    const nextCreatorMemberId = actor.memberId || '';
    if (!room || !room.adminRecoveryHash || !cleanCode || !nextCreatorMemberId) return null;
    if (!safeEqualHash(room.adminRecoveryHash, hashSecret(cleanCode))) return null;

    const now = Date.now();
    pruneExpiredReconnects(room, now);
    const targetMember = room.members.get(nextCreatorMemberId);
    if (targetMember && targetMember.socketId !== actor.socketId) return null;
    if (!targetMember && hasReconnectReservation(room, nextCreatorMemberId, now)
      && room.creatorMemberId !== nextCreatorMemberId) return null;
    const previousCreatorMemberId = room.creatorMemberId;
    const previousAdminMemberId = room.adminMemberId;
    const previousAdminAssignment = room.adminAssignment;
    if (previousCreatorMemberId && previousCreatorMemberId !== nextCreatorMemberId) {
      if (room.members.has(previousCreatorMemberId)) return null;
      room.reconnectUntil.delete(previousCreatorMemberId);
      room.memberReconnectHashes.delete(previousCreatorMemberId);
      room.pendingMemberReconnectTokens.delete(previousCreatorMemberId);
      if (room.playback.updatedBy === previousCreatorMemberId) {
        resetPlaybackAuthority(room, nextCreatorMemberId, now);
      }
    }

    if (room.hostMemberId === previousCreatorMemberId) {
      room.hostMemberId = nextCreatorMemberId;
      room.hostAssignment = 'creator';
      room.hostReconnectUntil = null;
      for (const member of room.members.values()) {
        member.role = member.id === nextCreatorMemberId ? 'host' : 'follower';
      }
    } else {
      reclaimAutomaticHost(room, nextCreatorMemberId, actor);
    }

    const adminToken = createSecretToken();
    const nextRecoveryCode = createRecoveryCode();
    room.creatorMemberId = nextCreatorMemberId;
    room.adminMemberId = nextCreatorMemberId;
    room.adminAssignment = 'creator';
    room.adminReconnectUntil = null;
    room.adminTokenHash = hashSecret(adminToken);
    room.adminRecoveryHash = hashSecret(cleanRecoveryCode(nextRecoveryCode));
    if (previousAdminAssignment === 'automatic' && previousAdminMemberId && previousAdminMemberId !== nextCreatorMemberId) {
      appendAudit(
        room,
        'admin_reclaimed',
        actor,
        { targetId: nextCreatorMemberId },
        'Creator reclaimed room management with the recovery code',
      );
    }
    appendAudit(room, 'admin_token_recovered', actor, {}, 'Admin token recovered with recovery code');
    touch(room);
    persistRooms();
    return {
      adminToken,
      recoveryCode: nextRecoveryCode,
      state: toPublicRoom(room),
    };
  }

  leaveBySocket(socketId: string): { roomCode: string; state: RoomState; departedHostId: string | null; departedAdminId: string | null; memberId: string; memberName: string; reconnectUntil: number }[] {
    const changed: { roomCode: string; state: RoomState; departedHostId: string | null; departedAdminId: string | null; memberId: string; memberName: string; reconnectUntil: number }[] = [];

    for (const room of rooms.values()) {
      const leaving = Array.from(room.members.values()).find((member) => member.socketId === socketId);
      if (!leaving) continue;

      const now = Date.now();
      const reconnectUntil = now + env.roomReconnectGraceMs;
      const departedHostId = room.hostMemberId === leaving.id ? leaving.id : null;
      const departedAdminId = room.adminMemberId === leaving.id ? leaving.id : null;
      room.members.delete(leaving.id);
      room.reconnectUntil.set(leaving.id, reconnectUntil);
      if (departedHostId) {
        room.hostReconnectUntil = now + env.roomHostReconnectGraceMs;
      } else if (room.playback.updatedBy === leaving.id) {
        const fallbackController = room.members.get(room.hostMemberId || '') || Array.from(room.members.values())[0] || null;
        resetPlaybackAuthority(room, fallbackController?.id || null, now);
      }
      if (departedAdminId) room.adminReconnectUntil = reconnectUntil;

      room.emptySince = room.members.size === 0 ? now : null;

      touch(room);
      persistRooms();
      changed.push({
        roomCode: room.roomCode,
        state: toPublicRoom(room),
        departedHostId,
        departedAdminId,
        memberId: leaving.id,
        memberName: leaving.name,
        reconnectUntil,
      });
    }

    return changed;
  }

  finalizeMemberDeparture(roomCode: string, memberId: string, memberName: string, expectedReconnectUntil: number, now = Date.now()): RoomState | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room || room.members.has(memberId)) return null;
    const reconnectUntil = room.reconnectUntil.get(memberId);
    if (reconnectUntil && (reconnectUntil !== expectedReconnectUntil || reconnectUntil > now)) return null;
    if (!reconnectUntil && expectedReconnectUntil > now) return null;

    room.reconnectUntil.delete(memberId);
    room.memberReconnectHashes.delete(memberId);
    room.pendingMemberReconnectTokens.delete(memberId);
    room.chat.push({
      id: createId('msg'),
      kind: 'system',
      senderId: 'system',
      senderName: '系统',
      text: `${memberName || '成员'} 离开了房间`,
      createdAt: now,
      memberId,
      systemEvent: 'member_left',
    });
    room.chat = room.chat.slice(-100);
    touch(room);
    persistRooms();
    return toPublicRoom(room);
  }

  finalizeHostDeparture(roomCode: string, departedHostId: string, now = Date.now()): RoomState | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room || room.hostMemberId !== departedHostId || room.members.has(departedHostId)) return null;
    if (room.hostReconnectUntil && room.hostReconnectUntil > now) return null;
    room.hostReconnectUntil = null;
    room.hostAssignment = 'automatic';
    const nextHost = Array.from(room.members.values())[0] || null;
    if (!nextHost) return null;
    room.hostMemberId = nextHost.id;
    for (const member of room.members.values()) member.role = member.id === nextHost.id ? 'host' : 'follower';
    if (room.playback.updatedBy === departedHostId || !room.members.has(room.playback.updatedBy || '')) {
      resetPlaybackAuthority(room, nextHost.id, now);
    }
    appendAudit(
      room,
      'host_failed_over',
      { memberId: 'system', memberName: 'System' },
      { targetId: nextHost.id, targetName: nextHost.name },
      'Host control moved after reconnect grace expired',
    );
    touch(room);
    persistRooms();
    return toPublicRoom(room);
  }

  getHostReconnectRemainingMs(roomCode: string, now = Date.now()): number | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room?.hostMemberId || room.members.has(room.hostMemberId)) return null;
    return Math.max(0, (room.hostReconnectUntil || now) - now);
  }

  finalizeAdminDeparture(roomCode: string, departedAdminId: string, now = Date.now()): AdminFailoverResult | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room || room.adminMemberId !== departedAdminId || room.members.has(departedAdminId)) return null;
    if (room.adminReconnectUntil && room.adminReconnectUntil > now) return null;
    const nextAdmin = room.members.get(room.hostMemberId || '') || Array.from(room.members.values())[0] || null;
    if (!nextAdmin) return null;

    const adminToken = createSecretToken();
    room.adminMemberId = nextAdmin.id;
    room.adminAssignment = 'automatic';
    room.adminReconnectUntil = null;
    room.adminTokenHash = hashSecret(adminToken);
    appendAudit(
      room,
      'admin_failed_over',
      { memberId: 'system', memberName: 'System' },
      { targetId: nextAdmin.id, targetName: nextAdmin.name },
      'Room management moved after the member reconnect grace expired',
    );
    touch(room);
    persistRooms();
    return {
      state: toPublicRoom(room),
      memberId: nextAdmin.id,
      socketId: nextAdmin.socketId,
      adminToken,
    };
  }

  getAdminReconnectRemainingMs(roomCode: string, now = Date.now()): { memberId: string; remainingMs: number } | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room?.adminMemberId || room.members.has(room.adminMemberId)) return null;
    return {
      memberId: room.adminMemberId,
      remainingMs: Math.max(0, (room.adminReconnectUntil || now) - now),
    };
  }

  addPlaylistItem(roomCode: string, item: Omit<PlaylistItem, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): RoomState {
    const code = normalizeRoomCode(roomCode);
    this.getOrCreateRoom(code);
    const room = rooms.get(code)!;
    if (room.playlist.length >= env.roomMaxPlaylistItems) return toPublicRoom(room);
    if (item.sourceType === 'local' && !hasUsableLocalFileMeta(item.localFile)) {
      throw new Error('本地播放项缺少有效文件信息');
    }
    if (item.sourceType !== 'local') {
      for (const value of [item.pageUrl, item.sourceUrl, item.refererUrl, item.finalUrl].filter(Boolean) as string[]) {
        const url = assertPublicHttpUrl(value);
        const port = url.port || (url.protocol === 'https:' ? '443' : '80');
        if ((url.protocol === 'https:' && port !== '443') || (url.protocol === 'http:' && port !== '80')) {
          throw new Error('共享播放项仅允许标准 HTTP/HTTPS 端口');
        }
      }
    }
    const localSourceUrl = item.sourceType === 'local' ? createLocalPlaceholderUrl(item.localFile!) : '';
    const nextItem: PlaylistItem = {
      id: item.id || createId('video'),
      title: item.title || item.pageUrl || item.sourceUrl || '未命名视频',
      pageUrl: localSourceUrl || item.pageUrl || item.sourceUrl,
      sourceUrl: localSourceUrl || item.sourceUrl || item.pageUrl,
      sourceType: item.sourceType || 'page',
      createdAt: item.createdAt || Date.now(),
      addedBy: item.addedBy,
      localFile: item.localFile || null,
      requiresClientParse: Boolean(item.requiresClientParse),
      parseMessage: item.parseMessage || '',
      finalUrl: item.sourceType === 'local' ? '' : (item.finalUrl || ''),
      refererUrl: item.sourceType === 'local' ? '' : (item.refererUrl || item.pageUrl || item.sourceUrl),
      bilibili: item.sourceType !== 'local' && isBilibiliPageUrl(item.pageUrl)
        ? sanitizeBilibiliSourceMeta(item.bilibili)
        : undefined,
    };

    const previousActiveSourceId = room.playback.activeSourceId;
    const previousUpdatedAt = room.updatedAt;
    room.playlist.push(nextItem);
    if (!room.playback.activeSourceId) room.playback.activeSourceId = nextItem.id;
    touch(room);
    try {
      assertRoomFitsStore(room);
    } catch (error) {
      room.playlist.pop();
      room.playback.activeSourceId = previousActiveSourceId;
      room.updatedAt = previousUpdatedAt;
      throw error;
    }
    persistRooms();
    return toPublicRoom(room);
  }

  renamePlaylistItem(roomCode: string, itemId: string, title: string): RoomState | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room) return null;
    const item = room.playlist.find((entry) => entry.id === itemId);
    if (!item) return toPublicRoom(room);
    const previousTitle = item.title;
    const previousUpdatedAt = room.updatedAt;
    item.title = title.trim() || item.title;
    touch(room);
    try {
      assertRoomFitsStore(room);
    } catch (error) {
      item.title = previousTitle;
      room.updatedAt = previousUpdatedAt;
      throw error;
    }
    persistRooms();
    return toPublicRoom(room);
  }

  refreshBilibiliPlaylistSource(
    roomCode: string,
    itemId: string,
    replacement: Omit<PlaylistItem, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
  ): RoomState | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room) return null;
    const index = room.playlist.findIndex((entry) => entry.id === itemId);
    const current = index >= 0 ? room.playlist[index] : null;
    const currentBilibili = sanitizeBilibiliSourceMeta(current?.bilibili);
    const nextBilibili = sanitizeBilibiliSourceMeta(replacement.bilibili);
    if (!current || current.sourceType !== 'video' || replacement.sourceType !== 'video'
      || !currentBilibili || !nextBilibili
      || currentBilibili.bvid !== nextBilibili.bvid
      || currentBilibili.cid !== nextBilibili.cid
      || currentBilibili.page !== nextBilibili.page) {
      return toPublicRoom(room);
    }

    for (const value of [replacement.pageUrl, replacement.sourceUrl, replacement.refererUrl, replacement.finalUrl].filter(Boolean) as string[]) {
      const url = assertPublicHttpUrl(value);
      const port = url.port || (url.protocol === 'https:' ? '443' : '80');
      if ((url.protocol === 'https:' && port !== '443') || (url.protocol === 'http:' && port !== '80')) {
        throw new Error('共享播放项仅允许标准 HTTP/HTTPS 端口');
      }
    }

    const previousUpdatedAt = room.updatedAt;
    const nextItem: PlaylistItem = {
      ...current,
      pageUrl: replacement.pageUrl || current.pageUrl,
      sourceUrl: replacement.sourceUrl || current.sourceUrl,
      sourceType: 'video',
      requiresClientParse: false,
      parseMessage: replacement.parseMessage || current.parseMessage || '',
      finalUrl: replacement.finalUrl || '',
      refererUrl: replacement.refererUrl || replacement.pageUrl || current.pageUrl,
      bilibili: {
        ...nextBilibili,
        danmakuEnabled: currentBilibili.danmakuEnabled,
      },
    };
    room.playlist[index] = nextItem;
    touch(room);
    try {
      assertRoomFitsStore(room);
    } catch (error) {
      room.playlist[index] = current;
      room.updatedAt = previousUpdatedAt;
      throw error;
    }
    persistRooms();
    return toPublicRoom(room);
  }

  updatePlaylistBilibiliDanmaku(roomCode: string, itemId: string, enabled: boolean): RoomState | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room) return null;
    const item = room.playlist.find((entry) => entry.id === itemId);
    if (!item?.bilibili?.danmakuAvailable) return toPublicRoom(room);
    item.bilibili.danmakuEnabled = enabled;
    touch(room);
    persistRooms();
    return toPublicRoom(room);
  }

  deletePlaylistItem(roomCode: string, itemId: string): RoomState | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room) return null;
    const index = room.playlist.findIndex((entry) => entry.id === itemId);
    if (index >= 0) room.playlist.splice(index, 1);
    if (room.playback.activeSourceId === itemId) {
      room.playback.activeSourceId = room.playlist[index]?.id || room.playlist[index - 1]?.id || room.playlist[0]?.id || null;
      room.playback.playing = false;
      room.playback.currentTime = 0;
      resetPlaybackAuthority(room, room.hostMemberId);
    }
    touch(room);
    persistRooms();
    return toPublicRoom(room);
  }

  movePlaylistItem(roomCode: string, itemId: string, direction: -1 | 1): RoomState | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room) return null;
    const index = room.playlist.findIndex((entry) => entry.id === itemId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= room.playlist.length) return toPublicRoom(room);
    const [item] = room.playlist.splice(index, 1);
    room.playlist.splice(target, 0, item);
    touch(room);
    persistRooms();
    return toPublicRoom(room);
  }


  isHost(roomCode: string, memberId: string): boolean {
    const room = rooms.get(normalizeRoomCode(roomCode));
    return Boolean(room && room.hostMemberId === memberId);
  }

  canControlRoom(roomCode: string, memberId: string): boolean {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room || !room.members.has(memberId)) return false;
    return room.hostMemberId === memberId || room.security.controlPolicy === 'everyone';
  }

  hasMember(roomCode: string, memberId: string): boolean {
    const room = rooms.get(normalizeRoomCode(roomCode));
    return Boolean(room && room.members.has(memberId));
  }

  isMemberSocket(roomCode: string, memberId: string, socketId: string): boolean {
    const room = rooms.get(normalizeRoomCode(roomCode));
    return room?.members.get(memberId)?.socketId === socketId;
  }

  renameMember(roomCode: string, memberId: string, name: string): RoomState | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    const member = room?.members.get(memberId);
    if (!room || !member) return room ? toPublicRoom(room) : null;
    const previousName = member.name;
    const nextName = name.trim();
    member.name = nextName;
    room.chat.forEach((message) => {
      if (message.kind === 'user' && message.senderId === memberId) {
        message.senderName = nextName;
        return;
      }
      if (message.kind !== 'system') return;
      if (message.memberId === memberId && message.systemEvent) {
        message.text = formatMemberSystemMessage(message.systemEvent, nextName);
        return;
      }
      if (message.memberId) return;
      const legacyEvents: NonNullable<ChatMessage['systemEvent']>[] = ['member_joined', 'member_left', 'member_kicked'];
      const legacyEvent = legacyEvents.find((event) => message.text === formatMemberSystemMessage(event, previousName));
      if (legacyEvent) {
        message.memberId = memberId;
        message.systemEvent = legacyEvent;
        message.text = formatMemberSystemMessage(legacyEvent, nextName);
      }
    });
    room.audit.forEach((entry) => {
      if (entry.actorId === memberId) entry.actorName = nextName;
      if (entry.targetId === memberId) entry.targetName = nextName;
    });
    touch(room);
    persistRooms();
    return toPublicRoom(room);
  }

  isAdmin(roomCode: string, adminToken: string): boolean {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room || !adminToken) return false;
    return safeEqualHash(room.adminTokenHash, hashSecret(adminToken));
  }

  isCreatorAdmin(roomCode: string, memberId: string, adminToken: string): boolean {
    const room = rooms.get(normalizeRoomCode(roomCode));
    return Boolean(room?.adminMemberId === memberId && this.isAdmin(roomCode, adminToken));
  }

  isOriginalCreator(roomCode: string, memberId: string): boolean {
    const room = rooms.get(normalizeRoomCode(roomCode));
    return Boolean(room?.creatorMemberId === memberId);
  }

  async verifyPassword(roomCode: string, password: string): Promise<boolean> {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room || !room.passwordHash || !room.passwordSalt) return false;
    const storedHash = room.passwordHash;
    const storedSalt = room.passwordSalt;
    const usesScrypt = storedHash.startsWith(PASSWORD_HASH_PREFIX);
    const expectedHash = usesScrypt
      ? await hashPassword(password, storedSalt)
      : hashLegacyPassword(password, storedSalt);
    const currentRoom = rooms.get(normalizeRoomCode(roomCode));
    if (!currentRoom || currentRoom.passwordHash !== storedHash || currentRoom.passwordSalt !== storedSalt) return false;
    const storedDigest = usesScrypt ? storedHash.slice(PASSWORD_HASH_PREFIX.length) : storedHash;
    const expectedDigest = usesScrypt ? expectedHash.slice(PASSWORD_HASH_PREFIX.length) : expectedHash;
    const valid = safeEqualHash(storedDigest, expectedDigest);
    if (valid && !usesScrypt) {
      const upgradedHash = await hashPassword(password, storedSalt);
      const latestRoom = rooms.get(normalizeRoomCode(roomCode));
      if (latestRoom?.passwordHash === storedHash && latestRoom.passwordSalt === storedSalt) {
        latestRoom.passwordHash = upgradedHash;
        touch(latestRoom);
        persistRooms();
      }
    }
    return valid;
  }

  async setRoomPassword(
    roomCode: string,
    password: string,
    actor: AuditActor = {},
    authorization?: { memberId: string; adminToken: string },
  ): Promise<RoomState | null> {
    const normalizedRoomCode = normalizeRoomCode(roomCode);
    let room = rooms.get(normalizedRoomCode);
    if (!room) return null;
    if (authorization && !this.isCreatorAdmin(normalizedRoomCode, authorization.memberId, authorization.adminToken)) return null;
    const cleanPassword = password.trim();
    if (!cleanPassword) {
      room.passwordHash = null;
      room.passwordSalt = null;
      appendAudit(room, 'password_cleared', actor, {}, 'Room password cleared');
    } else {
      const passwordSalt = crypto.randomBytes(16).toString('hex');
      const passwordHash = await hashPassword(cleanPassword, passwordSalt);
      room = rooms.get(normalizedRoomCode);
      if (!room) return null;
      if (authorization && !this.isCreatorAdmin(normalizedRoomCode, authorization.memberId, authorization.adminToken)) return null;
      room.passwordSalt = passwordSalt;
      room.passwordHash = passwordHash;
      appendAudit(room, 'password_set', actor, {}, 'Room password updated');
    }
    room.security.hasPassword = Boolean(room.passwordHash);
    touch(room);
    persistRooms();
    return toPublicRoom(room);
  }

  setRoomLocked(roomCode: string, locked: boolean, actor: AuditActor = {}): RoomState | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room) return null;
    room.security.locked = locked;
    appendAudit(room, locked ? 'room_locked' : 'room_unlocked', actor, {}, locked ? 'Room locked' : 'Room unlocked');
    touch(room);
    persistRooms();
    return toPublicRoom(room);
  }

  setControlPolicy(roomCode: string, controlPolicy: RoomSecurity['controlPolicy'], actor: AuditActor = {}): RoomState | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room) return null;
    const nextPolicy = controlPolicy === 'everyone' ? 'everyone' : 'host_only';
    room.security.controlPolicy = nextPolicy;
    resetPlaybackAuthority(room, room.hostMemberId);
    appendAudit(room, 'control_policy_updated', actor, {}, nextPolicy === 'everyone' ? 'All members can control playback and playlist' : 'Only host can control playback and playlist');
    touch(room);
    persistRooms();
    return toPublicRoom(room);
  }

  setAutoPlayNext(roomCode: string, enabled: boolean, actor: AuditActor = {}): RoomState | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room) return null;
    const nextEnabled = enabled === true;
    if (room.autoPlayNext === nextEnabled) return toPublicRoom(room);
    room.autoPlayNext = nextEnabled;
    appendAudit(room, 'autoplay_next_updated', actor, {}, nextEnabled ? 'Automatic playlist advance enabled' : 'Automatic playlist advance disabled');
    touch(room);
    persistRooms();
    return toPublicRoom(room);
  }

  kickMember(roomCode: string, targetMemberId: string, durationMs = DEFAULT_KICK_DURATION_MS, actor: AuditActor = {}): { state: RoomState; kickedSocketId: string | null } | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room) return null;
    if (room.hostMemberId === targetMemberId) return null;
    const target = room.members.get(targetMemberId);
    if (!target) return { state: toPublicRoom(room), kickedSocketId: null };

    room.members.delete(targetMemberId);
    room.reconnectUntil.delete(targetMemberId);
    room.memberReconnectHashes.delete(targetMemberId);
    room.pendingMemberReconnectTokens.delete(targetMemberId);
    const kickedUntil = Date.now() + Math.max(60 * 1000, durationMs);
    room.kickedMembers.set(targetMemberId, kickedUntil);
    const identityKickKey = clientKickKeyFromHash(target.clientIdentityHash);
    if (identityKickKey) room.kickedMembers.set(identityKickKey, kickedUntil);
    pruneKickedMembers(room);
    if (room.hostMemberId === targetMemberId) {
      const nextHost = Array.from(room.members.values())[0] || null;
      room.hostMemberId = nextHost?.id || null;
      if (nextHost) nextHost.role = 'host';
    }
    room.emptySince = room.members.size === 0 ? Date.now() : null;

    appendAudit(room, 'member_kicked', actor, { targetId: targetMemberId, targetName: target.name }, `Kicked ${target.name || targetMemberId}`);
    room.chat.push({
      id: createId('msg'),
      kind: 'system',
      senderId: 'system',
      senderName: '系统',
      text: `${target.name || '成员'} 被移出了房间`,
      createdAt: Date.now(),
      memberId: targetMemberId,
      systemEvent: 'member_kicked',
    });
    room.chat = room.chat.slice(-100);
    touch(room);
    persistRooms();
    return { state: toPublicRoom(room), kickedSocketId: target.socketId };
  }

  updatePlaybackWithDecision(
    roomCode: string,
    patch: Partial<PlaybackState>,
    options: PlaybackUpdateOptions = {},
  ): PlaybackUpdateDecision {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room) {
      return {
        state: null,
        accepted: false,
        reason: 'room_not_found',
        previousRevision: -1,
        nextRevision: -1,
        sourceMatch: false,
        leaseOwnerChanged: false,
        timelineDeltaSeconds: null,
      };
    }

    const now = Date.now();
    const currentRevision = playbackRevision(room.playback);
    const action = options.action;
    const memberId = options.memberId || patch.updatedBy || null;
    const versioned = Boolean(action);
    const sourceMatch = patch.activeSourceId === undefined || patch.activeSourceId === room.playback.activeSourceId;
    const predictedTime = predictPlaybackTime(room.playback, now);
    const submittedTime = Number(patch.currentTime);
    const timelineDeltaSeconds = Number.isFinite(submittedTime) ? submittedTime - predictedTime : null;
    const previousLeaseOwner = currentPlaybackAuthority(room, now);
    let acceptedReason: PlaybackDecisionReason = 'accepted';
    const reject = (reason: PlaybackDecisionReason): PlaybackUpdateDecision => ({
      state: toPublicRoom(room),
      accepted: false,
      reason,
      previousRevision: currentRevision,
      nextRevision: currentRevision,
      sourceMatch,
      leaseOwnerChanged: false,
      timelineDeltaSeconds,
    });
    if (versioned && (!Number.isSafeInteger(options.baseRevision) || options.baseRevision !== currentRevision)) {
      return reject('stale_revision');
    }

    const nextPatch: Partial<PlaybackState> = { ...patch, updatedBy: memberId };
    if (action === 'source') {
      const requestedSourceId = nextPatch.activeSourceId ?? null;
      if (requestedSourceId !== null && !room.playlist.some((item) => item.id === requestedSourceId)) {
        return reject('source_not_found');
      }
      nextPatch.buffering = false;
    } else if (action === 'periodic') {
      if (!memberId || previousLeaseOwner !== memberId) return reject('lease_not_owner');
      if (room.playback.buffering) return reject('room_buffering');
      if (options.clientReady !== true) return reject('client_not_ready');
      if (options.clientSeeking === true) return reject('client_seeking');
      if (nextPatch.activeSourceId !== undefined && nextPatch.activeSourceId !== room.playback.activeSourceId) return reject('source_mismatch');
      if (room.playback.playing !== true) return reject('room_not_playing');
      const hostMayReanchorStalledTimeline = memberId === room.hostMemberId
        && Number.isFinite(submittedTime)
        && submittedTime < predictedTime - PLAYBACK_PERIODIC_BACKWARD_TOLERANCE_SECONDS;
      if (!Number.isFinite(submittedTime)
        || (!hostMayReanchorStalledTimeline && submittedTime < predictedTime - PLAYBACK_PERIODIC_BACKWARD_TOLERANCE_SECONDS)
        || submittedTime > predictedTime + PLAYBACK_PERIODIC_FORWARD_TOLERANCE_SECONDS) {
        return reject('timeline_outlier');
      }
      if (hostMayReanchorStalledTimeline) acceptedReason = 'timeline_reanchored';
      nextPatch.activeSourceId = room.playback.activeSourceId;
      nextPatch.playing = room.playback.playing;
      nextPatch.buffering = false;
    } else if (action === 'play' || action === 'pause' || action === 'rate') {
      nextPatch.activeSourceId = room.playback.activeSourceId;
      nextPatch.currentTime = predictedTime;
      nextPatch.playing = action === 'play' ? true : action === 'pause' ? false : room.playback.playing;
      if (action !== 'rate') nextPatch.buffering = false;
      if (action !== 'rate') nextPatch.playbackRate = room.playback.playbackRate;
    } else if (action === 'seek') {
      if (options.clientReady !== true) return reject('client_not_ready');
      if (nextPatch.activeSourceId !== undefined && nextPatch.activeSourceId !== room.playback.activeSourceId) {
        return reject('source_mismatch');
      }
      nextPatch.activeSourceId = room.playback.activeSourceId;
      nextPatch.buffering = false;
    } else if (action === 'buffering') {
      if (!memberId || previousLeaseOwner !== memberId) return reject('lease_not_owner');
      if (nextPatch.activeSourceId !== undefined && nextPatch.activeSourceId !== room.playback.activeSourceId) {
        return reject('source_mismatch');
      }
      if (!Number.isFinite(submittedTime)) return reject('timeline_outlier');
      nextPatch.activeSourceId = room.playback.activeSourceId;
      nextPatch.playing = room.playback.playing;
      nextPatch.playbackRate = room.playback.playbackRate;
      nextPatch.buffering = patch.buffering === true;
    }

    room.playback = {
      ...room.playback,
      ...nextPatch,
      revision: currentRevision + 1,
      controlLeaseUntil: room.security.controlPolicy === 'everyone' && memberId
        ? now + PLAYBACK_CONTROL_LEASE_MS
        : null,
      updatedAt: now,
    };
    touch(room);
    persistRooms();
    const state = toPublicRoom(room);
    return {
      state,
      accepted: true,
      reason: acceptedReason,
      previousRevision: currentRevision,
      nextRevision: state.playback.revision,
      sourceMatch,
      leaseOwnerChanged: previousLeaseOwner !== currentPlaybackAuthority(room, now),
      timelineDeltaSeconds,
    };
  }

  updatePlayback(roomCode: string, patch: Partial<PlaybackState>, options: PlaybackUpdateOptions = {}): RoomState | null {
    return this.updatePlaybackWithDecision(roomCode, patch, options).state;
  }

  transferHost(roomCode: string, memberId: string, actor: AuditActor = {}): RoomState | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room) return null;
    if (!room.members.has(memberId)) return toPublicRoom(room);

    room.hostMemberId = memberId;
    room.hostAssignment = 'manual';
    room.hostReconnectUntil = null;
    resetPlaybackAuthority(room, memberId);
    for (const member of room.members.values()) {
      member.role = member.id === memberId ? 'host' : 'follower';
    }
    appendAudit(room, 'host_transferred', actor, { targetId: memberId }, `Host transferred to ${memberName(room, memberId)}`);
    touch(room);
    persistRooms();
    return toPublicRoom(room);
  }

  addChat(roomCode: string, message: Omit<ChatMessage, 'id' | 'createdAt'>): RoomState | null {
    const room = rooms.get(normalizeRoomCode(roomCode));
    if (!room) return null;
    room.chat.push({
      id: createId('msg'),
      kind: message.kind === 'system' ? 'system' : 'user',
      senderId: message.senderId,
      senderName: message.senderName,
      text: message.text,
      createdAt: Date.now(),
      memberId: message.memberId,
      systemEvent: message.systemEvent,
    });
    room.chat = room.chat.slice(-100);
    touch(room);
    persistRooms();
    return toPublicRoom(room);
  }
}

export const roomService = new RoomService();

const roomExpiryTimer = setInterval(
  () => roomService.expireEmptyRooms(),
  Math.min(60_000, Math.max(1_000, Math.floor(env.roomEmptyTtlMs / 4))),
);
roomExpiryTimer.unref?.();
