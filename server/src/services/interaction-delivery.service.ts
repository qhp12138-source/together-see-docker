import type { Server, Socket } from 'socket.io';
import { interactionCatalog } from './interaction.service.js';
import { roomService } from './room.service.js';
import type { RoomState } from '../types/room.js';

export interface InteractionEvent {
  id: string;
  assetId: string;
  assetRevision: string;
  sourceId: string;
  x: number;
  y: number;
  sentAt: number;
  durationMs: number;
}

const MAX_EVENTS = 8;
const MAX_BYTES = 8 * 1024;
const RETRY_MS = 25;

interface PendingEvent {
  payload: Readonly<InteractionEvent>;
  bytes: number;
  expiresAt: number;
  monotonicDeadline: number;
}

interface SocketQueue {
  roomCode: string;
  memberId: string;
  events: PendingEvent[];
  bytes: number;
}

export class InteractionDeliveryService {
  private readonly queues = new Map<Socket, SocketQueue>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly io: Server) {}

  get pending() {
    return {
      sockets: this.queues.size,
      events: [...this.queues.values()].reduce((sum, queue) => sum + queue.events.length, 0),
      bytes: [...this.queues.values()].reduce((sum, queue) => sum + queue.bytes, 0),
      timerActive: this.timer !== undefined,
    };
  }

  broadcast(roomCode: string, event: InteractionEvent): void {
    if (this.closed) return;
    const monotonicStart = performance.now();
    const expiresAt = event.sentAt + event.durationMs;
    const remaining = expiresAt - Date.now();
    if (!Number.isFinite(remaining) || event.durationMs <= 0 || event.durationMs > 3000
      || remaining <= 0 || remaining > event.durationMs) return;
    const bytes = Buffer.byteLength(JSON.stringify(['interaction_play', event]), 'utf8');
    if (bytes > MAX_BYTES) return;
    const pending: PendingEvent = {
      payload: Object.freeze({ ...event }), bytes, expiresAt,
      // A wall-clock rollback must not extend an already queued event's TTL.
      monotonicDeadline: monotonicStart + remaining,
    };
    for (const id of this.io.sockets.adapter.rooms.get(roomCode) || []) {
      const socket = this.io.sockets.sockets.get(id);
      const memberId = socket?.data.memberId;
      if (!socket?.connected || typeof memberId !== 'string' || socket.data.roomCode !== roomCode
        || !roomService.isMemberSocket(roomCode, memberId, socket.id)) continue;
      let queue = this.queues.get(socket);
      if (!queue || queue.roomCode !== roomCode || queue.memberId !== memberId) {
        queue = { roomCode, memberId, events: [], bytes: 0 };
        this.queues.set(socket, queue);
      }
      while (queue.events.length >= MAX_EVENTS || queue.bytes + bytes > MAX_BYTES) {
        queue.bytes -= queue.events.shift()!.bytes;
      }
      queue.events.push(pending);
      queue.bytes += bytes;
    }
    this.flush();
  }

  drop(socket: Socket): void {
    this.queues.delete(socket);
    if (!this.queues.size) this.stopTimer();
  }

  dropRoom(roomCode: string): void {
    for (const [socket, queue] of this.queues) if (queue.roomCode === roomCode) this.queues.delete(socket);
    if (!this.queues.size) this.stopTimer();
  }

  close(): void {
    this.closed = true;
    this.queues.clear();
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private flush(): void {
    this.stopTimer();
    if (this.closed || !this.queues.size) return;
    // Share validation snapshots across recipients; no per-event filesystem reads.
    const assets = new Map(interactionCatalog.getCatalog().items.map(asset => [asset.id, asset.revision]));
    const rooms = new Map<string, RoomState | null>();
    for (const [socket, queue] of this.queues) {
      if (!socket.connected || this.io.sockets.sockets.get(socket.id) !== socket
        || !socket.rooms.has(queue.roomCode) || socket.data.roomCode !== queue.roomCode
        || socket.data.memberId !== queue.memberId
        || !roomService.isMemberSocket(queue.roomCode, queue.memberId, socket.id)) {
        this.queues.delete(socket);
        continue;
      }
      if (!rooms.has(queue.roomCode)) rooms.set(queue.roomCode, roomService.getRoom(queue.roomCode));
      const room = rooms.get(queue.roomCode);
      queue.events = queue.events.filter(item => Date.now() < item.expiresAt
        && performance.now() < item.monotonicDeadline
        && room?.playback.activeSourceId === item.payload.sourceId
        && room.playlist.some(source => source.id === item.payload.sourceId)
        && assets.get(item.payload.assetId) === item.payload.assetRevision);
      queue.bytes = queue.events.reduce((sum, item) => sum + item.bytes, 0);
      while (queue.events.length && socket.conn.transport.writable) {
        const item = queue.events.shift()!;
        queue.bytes -= item.bytes;
        if (Date.now() >= item.expiresAt || performance.now() >= item.monotonicDeadline) continue;
        // No await between readiness and volatile emission. Busy transports never
        // receive this channel in Engine.IO's unbounded write buffer.
        socket.volatile.emit('interaction_play', item.payload);
      }
      if (!queue.events.length) this.queues.delete(socket);
    }
    if (this.queues.size) {
      this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, RETRY_MS);
      this.timer.unref();
    }
  }
}
