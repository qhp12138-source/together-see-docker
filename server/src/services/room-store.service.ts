import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import type { ChatMessage, PlaybackState, PlaylistItem, RoomAuditEntry, RoomSecurity } from '../types/room.js';
import { isBilibiliPageUrl, sanitizeBilibiliSourceMeta } from '../utils/bilibili.js';
import { normalizeRoomCode } from '../utils/id.js';
import { createLocalPlaceholderUrl } from '../utils/local-media.js';
import { assertPublicHttpUrl } from '../utils/remote-url.js';
import { bytesBucket, countBucket, elapsedBucket, logStructuredEvent } from '../utils/structured-log.js';

export interface PersistedRoomState {
  roomCode: string;
  roomName: string;
  hostMemberId: string | null;
  hostAssignment: 'creator' | 'manual' | 'automatic';
  createdAt: number;
  updatedAt: number;
  emptySince: number | null;
  playlist: PlaylistItem[];
  playback: PlaybackState;
  chat: ChatMessage[];
  audit: RoomAuditEntry[];
  security: RoomSecurity;
  autoPlayNext: boolean;
  kickedMembers: Record<string, number>;
  reconnectMembers: Record<string, { tokenHash: string; expiresAt: number }>;
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
}

interface StoreFile {
  version: 1;
  savedAt: number;
  rooms: PersistedRoomState[];
}

export type PersistedRoomSnapshotEntry = PersistedRoomState | string;
export type PersistedRoomSnapshotSource = Iterable<PersistedRoomSnapshotEntry> | AsyncIterable<PersistedRoomSnapshotEntry>;

export type RoomStoreErrorCode =
  | 'room_store_invalid'
  | 'room_store_too_large'
  | 'room_store_read_failed'
  | 'room_store_write_failed';

class RoomStoreFailure extends Error {
  constructor(readonly code: RoomStoreErrorCode) {
    super(code);
    this.name = 'RoomStoreFailure';
  }
}

function storeErrorCode(error: unknown, fallback: RoomStoreErrorCode): RoomStoreErrorCode {
  return error instanceof RoomStoreFailure ? error.code : fallback;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function resolveStoreFile(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizePlayback(value: unknown): PlaybackState {
  const raw = isPlainObject(value) ? value : {};
  const wasBuffering = raw.buffering === true;
  return {
    activeSourceId: typeof raw.activeSourceId === 'string' ? raw.activeSourceId : null,
    playing: raw.playing === true && !wasBuffering,
    buffering: false,
    currentTime: isNumber(raw.currentTime) ? Math.max(0, raw.currentTime) : 0,
    duration: isNumber(raw.duration) ? Math.max(0, raw.duration) : null,
    playbackRate: isNumber(raw.playbackRate) ? Math.min(3, Math.max(0.25, raw.playbackRate)) : 1,
    revision: isNumber(raw.revision) ? Math.max(0, Math.floor(raw.revision)) : 0,
    controlLeaseUntil: isNumber(raw.controlLeaseUntil) ? raw.controlLeaseUntil : null,
    updatedAt: isNumber(raw.updatedAt) ? raw.updatedAt : Date.now(),
    updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : null,
  };
}

function normalizePlaylist(value: unknown): PlaylistItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).map((item) => {
    const title = isString(item.title) ? item.title : '未命名视频';
    const sourceType = isString(item.sourceType) ? item.sourceType as PlaylistItem['sourceType'] : 'unknown';
    const parsedLocalFile = isPlainObject(item.localFile) ? {
      name: isString(item.localFile.name) ? item.localFile.name : '本地视频',
      size: isNumber(item.localFile.size) ? item.localFile.size : 0,
      type: isString(item.localFile.type) ? item.localFile.type : 'video/*',
      lastModified: isNumber(item.localFile.lastModified) ? item.localFile.lastModified : 0,
    } : null;
    const localFile = sourceType === 'local' ? (parsedLocalFile || {
      name: title,
      size: 0,
      type: 'video/*',
      lastModified: 0,
    }) : parsedLocalFile;
    const localSourceUrl = sourceType === 'local' ? createLocalPlaceholderUrl(localFile!) : '';
    const pageUrl = localSourceUrl || (isString(item.pageUrl) ? item.pageUrl : '');
    const sourceUrl = localSourceUrl || (isString(item.sourceUrl) ? item.sourceUrl : '');
    return {
      id: isString(item.id) ? item.id : '',
      title,
      pageUrl,
      sourceUrl,
      sourceType,
      createdAt: isNumber(item.createdAt) ? item.createdAt : Date.now(),
      addedBy: typeof item.addedBy === 'string' ? item.addedBy : undefined,
      localFile,
      requiresClientParse: item.requiresClientParse === true,
      parseMessage: typeof item.parseMessage === 'string' ? item.parseMessage : '',
      finalUrl: sourceType === 'local' ? '' : (typeof item.finalUrl === 'string' ? item.finalUrl : ''),
      refererUrl: sourceType === 'local' ? '' : (typeof item.refererUrl === 'string' ? item.refererUrl : pageUrl),
      bilibili: sourceType !== 'local' && isBilibiliPageUrl(pageUrl)
        ? sanitizeBilibiliSourceMeta(item.bilibili)
        : undefined,
    };
  }).filter((item) => {
    if (!item.id) return false;
    if (item.sourceType === 'local') return true;
    try {
      for (const value of [item.pageUrl, item.sourceUrl, item.refererUrl, item.finalUrl].filter(Boolean) as string[]) {
        const url = assertPublicHttpUrl(value);
        const port = url.port || (url.protocol === 'https:' ? '443' : '80');
        if ((url.protocol === 'https:' && port !== '443') || (url.protocol === 'http:' && port !== '80')) return false;
      }
      return Boolean(item.pageUrl && item.sourceUrl);
    } catch {
      return false;
    }
  });
}

function normalizeSystemEvent(value: unknown): ChatMessage['systemEvent'] {
  if (value === 'member_joined' || value === 'member_left' || value === 'member_kicked') return value;
  return undefined;
}

function normalizeChat(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).map((message) => ({
    id: isString(message.id) ? message.id : '',
    kind: message.kind === 'system' ? 'system' as const : 'user' as const,
    senderId: isString(message.senderId) ? message.senderId : '',
    senderName: isString(message.senderName) ? message.senderName : '访客',
    text: isString(message.text) ? message.text : '',
    createdAt: isNumber(message.createdAt) ? message.createdAt : Date.now(),
    memberId: isString(message.memberId) ? message.memberId : undefined,
    systemEvent: normalizeSystemEvent(message.systemEvent),
  })).filter((message) => message.id && message.text).slice(-100);
}

function normalizeAudit(value: unknown): RoomAuditEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).map((entry) => ({
    id: isString(entry.id) ? entry.id : '',
    action: isString(entry.action) ? entry.action as RoomAuditEntry['action'] : 'room_created',
    actorId: isString(entry.actorId) ? entry.actorId : '',
    actorName: isString(entry.actorName) ? entry.actorName : 'System',
    targetId: isString(entry.targetId) ? entry.targetId : undefined,
    targetName: isString(entry.targetName) ? entry.targetName : undefined,
    detail: typeof entry.detail === 'string' ? entry.detail.slice(0, 240) : undefined,
    createdAt: isNumber(entry.createdAt) ? entry.createdAt : Date.now(),
  })).filter((entry) => entry.id && entry.action && entry.actorId).slice(-100);
}

function normalizeSecurity(value: unknown): RoomSecurity {
  const raw = isPlainObject(value) ? value : {};
  const controlPolicy = raw.controlPolicy === 'everyone' ? 'everyone' : 'host_only';
  return {
    locked: raw.locked === true,
    hasPassword: raw.hasPassword === true,
    controlPolicy,
  };
}

function normalizeKickedMembers(value: unknown): Record<string, number> {
  if (!isPlainObject(value)) return {};
  const now = Date.now();
  return Object.fromEntries(Object.entries(value)
    .filter(([memberId, kickedUntil]) => isString(memberId) && isNumber(kickedUntil) && kickedUntil > now)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, env.roomMaxKickedEntries)
    .map(([memberId, kickedUntil]) => [memberId, kickedUntil as number]));
}

function normalizeReconnectMembers(value: unknown): Record<string, { tokenHash: string; expiresAt: number }> {
  if (!isPlainObject(value)) return {};
  const now = Date.now();
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => isPlainObject(entry)
      && isString(entry.tokenHash)
      && isNumber(entry.expiresAt)
      && entry.expiresAt > now)
    .sort((left, right) => Number((right[1] as Record<string, unknown>).expiresAt) - Number((left[1] as Record<string, unknown>).expiresAt))
    .slice(0, env.roomMaxReconnectEntries)
    .map(([memberId, entry]) => [memberId, {
      tokenHash: (entry as Record<string, unknown>).tokenHash as string,
      expiresAt: (entry as Record<string, unknown>).expiresAt as number,
    }]));
}

function normalizeRoom(value: unknown): PersistedRoomState | null {
  if (!isPlainObject(value) || !isString(value.roomCode)) return null;
  if (typeof value.roomName === 'string' && value.roomName.length > 64) {
    throw new RoomStoreFailure('room_store_too_large');
  }
  if (Array.isArray(value.playlist) && value.playlist.length > env.roomMaxPlaylistItems) {
    throw new RoomStoreFailure('room_store_too_large');
  }
  if (Array.isArray(value.chat) && value.chat.length > 100) {
    throw new RoomStoreFailure('room_store_too_large');
  }
  if (Array.isArray(value.audit) && value.audit.length > 100) {
    throw new RoomStoreFailure('room_store_too_large');
  }
  const now = Date.now();
  const updatedAt = isNumber(value.updatedAt) ? value.updatedAt : now;
  const hostMemberId = typeof value.hostMemberId === 'string' ? value.hostMemberId : null;
  const creatorMemberId = typeof value.creatorMemberId === 'string' ? value.creatorMemberId : null;
  const adminMemberId = typeof value.adminMemberId === 'string' ? value.adminMemberId : creatorMemberId;
  const audit = normalizeAudit(value.audit);
  const latestHostAssignment = [...audit].reverse().find((entry) => (
    entry.action === 'host_transferred'
    || entry.action === 'host_failed_over'
    || entry.action === 'host_reclaimed'
  ));
  const hostAssignment = value.hostAssignment === 'manual' || value.hostAssignment === 'creator' || value.hostAssignment === 'automatic'
    ? value.hostAssignment
    : (latestHostAssignment?.action === 'host_transferred' && latestHostAssignment.targetId === hostMemberId
      ? 'manual'
      : (hostMemberId && hostMemberId === creatorMemberId ? 'creator' : 'automatic'));
  return {
    roomCode: value.roomCode,
    roomName: isString(value.roomName) ? value.roomName : value.roomCode,
    hostMemberId,
    hostAssignment,
    createdAt: isNumber(value.createdAt) ? value.createdAt : now,
    updatedAt,
    emptySince: value.emptySince === null ? null : (isNumber(value.emptySince) ? value.emptySince : updatedAt),
    playlist: normalizePlaylist(value.playlist),
    playback: normalizePlayback(value.playback),
    chat: normalizeChat(value.chat),
    audit,
    security: normalizeSecurity(value.security),
    autoPlayNext: value.autoPlayNext === true,
    kickedMembers: normalizeKickedMembers(value.kickedMembers),
    reconnectMembers: normalizeReconnectMembers(value.reconnectMembers),
    hostReconnectUntil: isNumber(value.hostReconnectUntil) ? value.hostReconnectUntil : null,
    creatorPending: value.creatorPending === true,
    creatorMemberId,
    adminMemberId,
    adminAssignment: value.adminAssignment === 'automatic' ? 'automatic' : 'creator',
    adminReconnectUntil: isNumber(value.adminReconnectUntil) ? value.adminReconnectUntil : null,
    adminTokenHash: typeof value.adminTokenHash === 'string' ? value.adminTokenHash : '',
    adminRecoveryHash: typeof value.adminRecoveryHash === 'string' ? value.adminRecoveryHash : '',
    passwordHash: typeof value.passwordHash === 'string' ? value.passwordHash : null,
    passwordSalt: typeof value.passwordSalt === 'string' ? value.passwordSalt : null,
  };
}

export class RoomStoreService {
  private readonly filePath = resolveStoreFile(env.roomStoreFile);
  private writeTimer: NodeJS.Timeout | null = null;
  private snapshotProvider: (() => PersistedRoomSnapshotSource) | null = null;
  private pendingGeneration = 0;
  private attemptedGeneration = 0;
  private committedGeneration = 0;
  private writePromise: Promise<void> | null = null;
  private writesStarted = 0;
  private writesCompleted = 0;
  private lastSnapshotBytes = 0;
  private lastSnapshotRooms = 0;
  private lastSnapshotYields = 0;
  private loadBlocked = false;
  private lastErrorCode: RoomStoreErrorCode | null = null;

  getHealth(): { ok: boolean; enabled: boolean; errorCode?: RoomStoreErrorCode } {
    const health: { ok: boolean; enabled: boolean; errorCode?: RoomStoreErrorCode } = {
      ok: !this.loadBlocked && !this.lastErrorCode,
      enabled: env.roomStoreEnabled,
    };
    if (this.lastErrorCode) health.errorCode = this.lastErrorCode;
    return health;
  }

  getWriteDiagnostics(): {
    pendingGeneration: number;
    attemptedGeneration: number;
    committedGeneration: number;
    writesStarted: number;
    writesCompleted: number;
    lastSnapshotBytes: number;
    lastSnapshotRooms: number;
    lastSnapshotYields: number;
    writing: boolean;
  } {
    return {
      pendingGeneration: this.pendingGeneration,
      attemptedGeneration: this.attemptedGeneration,
      committedGeneration: this.committedGeneration,
      writesStarted: this.writesStarted,
      writesCompleted: this.writesCompleted,
      lastSnapshotBytes: this.lastSnapshotBytes,
      lastSnapshotRooms: this.lastSnapshotRooms,
      lastSnapshotYields: this.lastSnapshotYields,
      writing: Boolean(this.writePromise),
    };
  }

  setSnapshotProvider(provider: () => PersistedRoomSnapshotSource): void {
    this.snapshotProvider = provider;
  }

  loadRooms(): PersistedRoomState[] {
    if (!env.roomStoreEnabled) return [];
    const startedAt = performance.now();
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const fileSize = fs.statSync(this.filePath).size;
      if (fileSize > env.roomStoreMaxBytes) throw new RoomStoreFailure('room_store_too_large');
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (byteLength(raw) > env.roomStoreMaxBytes) throw new RoomStoreFailure('room_store_too_large');
      const parsed = JSON.parse(raw) as unknown;
      if (!isPlainObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.rooms)) {
        throw new RoomStoreFailure('room_store_invalid');
      }
      if (parsed.rooms.length > env.roomStoreMaxRooms) throw new RoomStoreFailure('room_store_too_large');
      this.loadBlocked = false;
      this.lastErrorCode = null;
      const normalizedRooms: PersistedRoomState[] = [];
      const roomCodes = new Set<string>();
      for (let index = 0; index < parsed.rooms.length; index += 1) {
        if (byteLength(JSON.stringify(parsed.rooms[index])) > env.roomStoreMaxRoomBytes) {
          throw new RoomStoreFailure('room_store_too_large');
        }
        const room = normalizeRoom(parsed.rooms[index]);
        if (!room || normalizeRoomCode(room.roomCode) !== room.roomCode || roomCodes.has(room.roomCode)) {
          throw new RoomStoreFailure('room_store_invalid');
        }
        if (room.playlist.length > env.roomMaxPlaylistItems) throw new RoomStoreFailure('room_store_too_large');
        roomCodes.add(room.roomCode);
        normalizedRooms.push(room);
      }
      logStructuredEvent('room_store_decision', {
        operation: 'load',
        decision: 'accepted',
        reason: 'loaded',
        roomCountBucket: countBucket(normalizedRooms.length),
        bytesBucket: bytesBucket(fileSize),
        elapsedBucket: elapsedBucket(performance.now() - startedAt),
      });
      return normalizedRooms;
    } catch (error) {
      this.loadBlocked = true;
      this.lastErrorCode = error instanceof SyntaxError
        ? 'room_store_invalid'
        : storeErrorCode(error, 'room_store_read_failed');
      this.logFailure('load', this.lastErrorCode);
      return [];
    }
  }

  saveRooms(): void {
    if (!env.roomStoreEnabled || this.loadBlocked) return;
    this.queueGeneration();
    if (this.writeTimer || this.writePromise) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.drainWrites();
    }, env.roomStoreWriteDelayMs);
    this.writeTimer.unref?.();
  }

  async flush(): Promise<void> {
    if (!env.roomStoreEnabled) return;
    if (this.loadBlocked) throw new RoomStoreFailure(this.lastErrorCode || 'room_store_read_failed');
    this.queueGeneration();
    const targetGeneration = this.pendingGeneration;
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    while (this.committedGeneration < targetGeneration) {
      if (this.writeTimer) {
        clearTimeout(this.writeTimer);
        this.writeTimer = null;
      }
      await this.drainWrites();
      if (this.lastErrorCode) throw new RoomStoreFailure(this.lastErrorCode);
    }
  }

  private queueGeneration(): void {
    this.pendingGeneration += 1;
  }

  private drainWrites(): Promise<void> {
    if (this.writePromise) return this.writePromise;
    this.writePromise = this.runWriter().finally(() => {
      this.writePromise = null;
      if (this.pendingGeneration > this.attemptedGeneration && !this.writeTimer) {
        this.writeTimer = setTimeout(() => {
          this.writeTimer = null;
          void this.drainWrites();
        }, env.roomStoreWriteDelayMs);
        this.writeTimer.unref?.();
      }
    });
    return this.writePromise;
  }

  private async runWriter(): Promise<void> {
    let writesThisDrain = 0;
    while (this.attemptedGeneration < this.pendingGeneration && writesThisDrain < 2) {
      const generation = this.pendingGeneration;
      this.attemptedGeneration = generation;
      this.writesStarted += 1;
      writesThisDrain += 1;
      let rooms: PersistedRoomSnapshotSource;
      try {
        if (!this.snapshotProvider) throw new RoomStoreFailure('room_store_write_failed');
        rooms = this.snapshotProvider();
      } catch (error) {
        this.lastErrorCode = storeErrorCode(error, 'room_store_write_failed');
        this.logFailure('write', this.lastErrorCode, { generation, bytes: 0 });
        return;
      }
      const success = await this.writeGeneration(rooms, generation);
      if (!success) return;
      this.committedGeneration = generation;
      this.writesCompleted += 1;
    }
  }

  private async writeGeneration(rooms: PersistedRoomSnapshotSource, generation: number): Promise<boolean> {
    const startedAt = performance.now();
    const dir = path.dirname(this.filePath);
    const tempFile = `${this.filePath}.tmp`;
    let handle: FileHandle | null = null;
    let bytesWritten = 0;
    let roomsWritten = 0;
    let snapshotYields = 0;
    let phase = 'prepare_directory';
    try {
      await fsPromises.mkdir(dir, { recursive: true });
      phase = 'open_temp';
      handle = await fsPromises.open(tempFile, 'w');
      const writeText = async (value: string): Promise<void> => {
        const buffer = Buffer.from(value, 'utf8');
        const nextBytes = buffer.byteLength;
        if (bytesWritten + nextBytes > env.roomStoreMaxBytes) throw new RoomStoreFailure('room_store_too_large');
        let offset = 0;
        while (offset < buffer.byteLength) {
          const result = await handle!.write(buffer, offset, buffer.byteLength - offset, null);
          if (result.bytesWritten <= 0) throw new RoomStoreFailure('room_store_write_failed');
          offset += result.bytesWritten;
        }
        bytesWritten += nextBytes;
      };

      phase = 'write_header';
      await writeText(`{"version":1,"savedAt":${Date.now()},"rooms":[`);
      const asyncRooms = rooms as AsyncIterable<PersistedRoomSnapshotEntry>;
      const iterator: AsyncIterator<PersistedRoomSnapshotEntry> | Iterator<PersistedRoomSnapshotEntry> =
        typeof asyncRooms[Symbol.asyncIterator] === 'function'
          ? asyncRooms[Symbol.asyncIterator]()
          : (rooms as Iterable<PersistedRoomSnapshotEntry>)[Symbol.iterator]();
      while (true) {
        await yieldToEventLoop();
        snapshotYields += 1;
        phase = 'prepare_room';
        const result = await iterator.next();
        if (result.done) break;
        roomsWritten += 1;
        if (roomsWritten > env.roomStoreMaxRooms) throw new RoomStoreFailure('room_store_too_large');
        const roomJson = typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
        if (byteLength(roomJson) > env.roomStoreMaxRoomBytes) throw new RoomStoreFailure('room_store_too_large');
        phase = 'write_room';
        await writeText(`${roomsWritten === 1 ? '' : ','}${roomJson}`);
      }
      phase = 'write_footer';
      await writeText(']}\n');
      phase = 'sync_file';
      await handle.sync();
      await handle.close();
      handle = null;
      phase = 'replace_file';
      await fsPromises.rename(tempFile, this.filePath);
      if (process.platform !== 'win32') {
        phase = 'sync_directory';
        const directoryHandle = await fsPromises.open(dir, 'r');
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
      this.lastSnapshotBytes = bytesWritten;
      this.lastSnapshotRooms = roomsWritten;
      this.lastSnapshotYields = snapshotYields;
      this.lastErrorCode = null;
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs >= 100 || bytesWritten >= 16 * 1024 * 1024) {
        const reason = elapsedMs >= 100 ? 'slow_write' : 'large_snapshot';
        logStructuredEvent('room_store_decision', {
          operation: 'write',
          decision: 'accepted',
          reason,
          generation,
          generationLag: Math.max(0, this.pendingGeneration - generation),
          roomCountBucket: countBucket(roomsWritten),
          bytesBucket: bytesBucket(bytesWritten),
          elapsedBucket: elapsedBucket(elapsedMs),
        }, {
          suppressKey: `write:${reason}:${countBucket(roomsWritten)}:${bytesBucket(bytesWritten)}`,
          suppressWindowMs: 60_000,
        });
      }
      return true;
    } catch (error) {
      this.lastErrorCode = storeErrorCode(error, 'room_store_write_failed');
      this.logFailure('write', this.lastErrorCode, { generation, bytes: bytesWritten, phase });
      try {
        await handle?.close();
      } catch {
        // The cleanup below still attempts to remove the incomplete file.
      }
      await fsPromises.unlink(tempFile).catch(() => undefined);
      return false;
    }
  }

  private logFailure(
    operation: 'load' | 'write',
    errorCode: RoomStoreErrorCode,
    details: { generation?: number; bytes?: number; phase?: string } = {},
  ): void {
    logStructuredEvent('room_store_decision', {
      operation,
      decision: 'rejected',
      reason: details.phase || errorCode,
      errorCode,
      generation: details.generation,
      generationLag: Number.isFinite(details.generation)
        ? Math.max(0, this.pendingGeneration - Number(details.generation))
        : undefined,
      bytesBucket: Number.isFinite(details.bytes) ? bytesBucket(Number(details.bytes)) : undefined,
    }, { level: 'warn' });
  }
}

export const roomStore = new RoomStoreService();
