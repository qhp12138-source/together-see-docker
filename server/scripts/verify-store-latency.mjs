import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const storeFile = path.join(os.tmpdir(), `together-see-store-latency-${process.pid}-${Date.now()}.json`);
const maxSnapshotBytes = 64 * 1024 * 1024;

Object.assign(process.env, {
  NODE_ENV: 'test',
  ROOM_STORE_ENABLED: 'true',
  ROOM_STORE_FILE: storeFile,
  ROOM_STORE_WRITE_DELAY_MS: '10',
  ROOM_STORE_MAX_BYTES: String(maxSnapshotBytes),
  ROOM_STORE_MAX_ROOM_BYTES: String(3 * 1024 * 1024),
  ROOM_STORE_MAX_ROOMS: '500',
  ROOM_MAX_ACTIVE: '20',
  ROOM_MAX_PLAYLIST_ITEMS: '200',
});

function playlistFixture(roomIndex) {
  return Array.from({ length: 200 }, (_, itemIndex) => {
    const suffix = `${roomIndex}-${itemIndex}-${'x'.repeat(1750)}`;
    const url = `https://media.example.com/video/${suffix}.mp4`;
    return {
      id: `video-${roomIndex}-${itemIndex}`,
      title: `Video ${roomIndex}-${itemIndex}`,
      pageUrl: url,
      sourceUrl: url,
      sourceType: 'video',
      createdAt: 1,
      refererUrl: url,
      finalUrl: url,
    };
  });
}

function roomFixture(index) {
  const roomCode = `CAP${String(index).padStart(2, '0')}`;
  return {
    roomCode,
    roomName: roomCode,
    hostMemberId: null,
    hostAssignment: 'creator',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    emptySince: Date.now(),
    playlist: playlistFixture(index),
    playback: {
      activeSourceId: `video-${index}-0`,
      playing: false,
      currentTime: 0,
      duration: null,
      playbackRate: 1,
      revision: 0,
      controlLeaseUntil: null,
      updatedAt: Date.now(),
      updatedBy: null,
    },
    chat: [],
    audit: [],
    security: { locked: false, hasPassword: false, controlPolicy: 'host_only' },
    autoPlayNext: false,
    kickedMembers: {},
    reconnectMembers: {},
    hostReconnectUntil: null,
    creatorPending: false,
    creatorMemberId: null,
    adminMemberId: null,
    adminAssignment: 'creator',
    adminReconnectUntil: null,
    adminTokenHash: 'a'.repeat(64),
    adminRecoveryHash: 'b'.repeat(64),
    passwordHash: null,
    passwordSalt: null,
  };
}

fs.writeFileSync(storeFile, JSON.stringify({
  version: 1,
  savedAt: Date.now(),
  rooms: Array.from({ length: 20 }, (_, index) => roomFixture(index)),
}));

const { flushRoomPersistence, roomService } = await import('../dist/services/room.service.js');
const { roomStore } = await import('../dist/services/room-store.service.js');
assert.equal(roomService.getRoom('CAP00')?.playlist.length, 200, 'the test must hydrate a maximum-size real playlist');

const lagSamples = [];
let lastTick = performance.now();
const timer = setInterval(() => {
  const now = performance.now();
  lagSamples.push(Math.max(0, now - lastTick - 5));
  lastTick = now;
}, 5);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, percentileValue) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentileValue))];
}

// Warm the serializer and filesystem before measuring. The deterministic
// generation/write assertions below remain release blockers; wall-clock lag is
// normalized against an idle baseline because shared hosts can be preempted.
await flushRoomPersistence();
lagSamples.length = 0;
await sleep(300);
const baselineP99Ms = percentile(lagSamples, 0.99);
lagSamples.length = 0;

for (let revision = 1; revision <= 1000; revision += 1) {
  roomService.updatePlayback('CAP00', {
    currentTime: revision,
    updatedBy: 'latency-controller',
  });
}
let heartbeatCount = 0;
let heartbeatActive = true;
const heartbeat = () => {
  if (!heartbeatActive) return;
  heartbeatCount += 1;
  setImmediate(heartbeat);
};
setImmediate(heartbeat);

const concurrentFlush = flushRoomPersistence();
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
roomService.updatePlayback('CAP00', {
  currentTime: 1001,
  updatedBy: 'latency-controller',
});
roomService.updatePlayback('CAP01', {
  currentTime: 42,
  updatedBy: 'latency-controller',
});
await concurrentFlush;
heartbeatActive = false;
await sleep(40);
clearInterval(timer);

const diagnostics = roomStore.getWriteDiagnostics();
const fileBytes = fs.statSync(storeFile).size;
const persisted = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
assert.equal(persisted.rooms[0].playback.revision, 1001, 'the newest RoomService generation must reach disk');
assert.equal(persisted.rooms[1].playback.revision, 1, 'a concurrent mutation in another room must reach the same committed generation');
assert.equal(diagnostics.committedGeneration, diagnostics.pendingGeneration);
assert.ok(diagnostics.writesStarted <= 3, `1002 RoomService updates should form at most three physical attempts, saw ${diagnostics.writesStarted}`);
assert.equal(diagnostics.writesCompleted, diagnostics.writesStarted);
assert.equal(diagnostics.lastSnapshotBytes, fileBytes);
assert.equal(diagnostics.lastSnapshotRooms, 20, 'the latest generation must include every loaded room');
assert.ok(diagnostics.lastSnapshotYields >= diagnostics.lastSnapshotRooms, 'snapshot preparation must yield before every room');
assert.ok(heartbeatCount >= diagnostics.lastSnapshotRooms, 'an independent event-loop heartbeat must progress while the snapshot is written');
assert.ok(fileBytes > 25 * 1024 * 1024, `realistic maximum playlists should exceed 25 MiB, saw ${fileBytes}`);
assert.ok(fileBytes < maxSnapshotBytes);
const maxLagMs = Math.max(0, ...lagSamples);
const sustainedLagLimitMs = Math.max(100, baselineP99Ms + 100);
const severeLagSamples = lagSamples.filter((lag) => lag >= sustainedLagLimitMs);
const absoluteLagLimitMs = Math.max(350, Math.min(500, baselineP99Ms + 250));
assert.ok(
  severeLagSamples.length <= 2,
  `event loop lag remained above ${sustainedLagLimitMs.toFixed(1)}ms for ${severeLagSamples.length} samples (max ${maxLagMs.toFixed(1)}ms)`,
);
assert.ok(
  maxLagMs < absoluteLagLimitMs,
  `event loop lag exceeded the absolute ${absoluteLagLimitMs.toFixed(1)}ms safety bound (max ${maxLagMs.toFixed(1)}ms)`,
);
assert.deepEqual(roomStore.getHealth(), { ok: true, enabled: true });

let sustainedRevision = 0;
const sustainedUpdates = setInterval(() => {
  sustainedRevision += 1;
  roomService.updatePlayback('CAP02', {
    currentTime: sustainedRevision,
    updatedBy: 'sustained-controller',
  });
}, 1);
const sustainedFlushCompleted = await Promise.race([
  flushRoomPersistence().then(() => true),
  sleep(2000).then(() => false),
]);
clearInterval(sustainedUpdates);
assert.equal(sustainedFlushCompleted, true, 'flush must make bounded progress while playback updates continue');
await flushRoomPersistence();
const sustainedPersisted = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
assert.equal(
  sustainedPersisted.rooms[2].playback.revision,
  roomService.getRoom('CAP02')?.playback.revision,
  'the final quiet generation must contain the latest sustained update',
);

fs.rmSync(storeFile, { force: true });
fs.rmSync(`${storeFile}.tmp`, { force: true });
console.log(`store latency verification passed through RoomService: ${(fileBytes / 1024 / 1024).toFixed(1)} MiB, observed max lag ${maxLagMs.toFixed(1)}ms, baseline p99 ${baselineP99Ms.toFixed(1)}ms, severe samples ${severeLagSamples.length}, attempts ${diagnostics.writesStarted}, sustained flush bounded`);
