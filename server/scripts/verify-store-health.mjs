import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const serverRoot = process.cwd();

async function isPortClosed(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`);
    return false;
  } catch {
    return true;
  }
}

async function pickTestPort() {
  const base = 41000 + Math.floor(Math.random() * 10000);
  for (let offset = 0; offset < 20; offset += 1) {
    const port = base + offset;
    if (await isPortClosed(port)) return port;
  }
  throw new Error('failed to find a closed local test port');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyRejectedSnapshot(snapshot, label, expectedErrorCode = 'room_store_invalid', extraEnv = {}, forbiddenOutput = '') {
  const port = await pickTestPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const storeFile = path.join(os.tmpdir(), `together-see-store-health-${label}-${process.pid}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  fs.writeFileSync(storeFile, snapshot, 'utf8');

  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      PUBLIC_ORIGIN: '*',
      ROOM_STORE_FILE: storeFile,
      ROOM_STORE_WRITE_DELAY_MS: '10',
      ROOM_STORE_MAX_BYTES: String(1024 * 1024),
      ROOM_STORE_MAX_ROOM_BYTES: String(256 * 1024),
      PARSE_RATE_LIMIT_PER_MINUTE: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let childExitCode = null;
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  child.once('exit', (code, signal) => { childExitCode = signal || code; });

  try {
    let health = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (childExitCode !== null) throw new Error(`server exited before degraded health check: ${childExitCode}\n${output}`);
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        health = { response, body: await response.json() };
        break;
      } catch {
        await sleep(150);
      }
    }
    if (!health) throw new Error(`degraded server did not expose its health endpoint\n${output}`);
    assert.equal(health.response.status, 503);
    assert.equal(health.body.ok, false);
    assert.equal(health.body.persistence?.ok, false);
    assert.equal(health.body.persistence?.errorCode, expectedErrorCode);
    assert.deepEqual(Object.keys(health.body.persistence).sort(), ['enabled', 'errorCode', 'ok']);
    assert.equal(JSON.stringify(health.body).includes(label), false, 'health response must not expose snapshot details');
    if (forbiddenOutput) assert.equal(output.includes(forbiddenOutput), false, 'store logs must not expose snapshot content');
    await sleep(100);
    assert.equal(fs.readFileSync(storeFile, 'utf8'), snapshot, `${label} snapshot must not be overwritten`);
  } finally {
    if (childExitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(3000)]);
    }
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

async function verifyAcceptedSnapshot(snapshot, label, extraEnv = {}) {
  const port = await pickTestPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const storeFile = path.join(os.tmpdir(), `together-see-store-health-${label}-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(storeFile, snapshot, 'utf8');
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      PUBLIC_ORIGIN: '*',
      ROOM_STORE_FILE: storeFile,
      ROOM_STORE_WRITE_DELAY_MS: '10',
      ROOM_STORE_MAX_BYTES: String(8 * 1024 * 1024),
      ROOM_STORE_MAX_ROOM_BYTES: String(256 * 1024),
      ROOM_STORE_MAX_ROOMS: '500',
      ROOM_MAX_ACTIVE: '20',
      ROOM_MAX_RECONNECT_ENTRIES: '100',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  try {
    let health = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        health = { response, body: await response.json() };
        break;
      } catch {
        await sleep(100);
      }
    }
    if (!health) throw new Error(`compatible server did not start\n${output}`);
    assert.equal(health.response.status, 200);
    assert.deepEqual(health.body.persistence, { ok: true, enabled: true });
  } finally {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(3000)]);
    child.stdout.destroy();
    child.stderr.destroy();
    fs.rmSync(storeFile, { force: true });
    fs.rmSync(`${storeFile}.tmp`, { force: true });
  }
}

await verifyRejectedSnapshot('{"version":1,"rooms":[', 'corrupt-json');
await verifyRejectedSnapshot(JSON.stringify({
  version: 1,
  savedAt: Date.now(),
  rooms: [
    { roomCode: 'VALID-ROOM', roomName: 'Valid Room', createdAt: Date.now(), updatedAt: Date.now() },
    { roomName: 'Missing room code must reject the whole snapshot' },
  ],
}), 'partial-invalid-room');
const oversizedSecret = 'oversized-store-secret-must-not-leak';
await verifyRejectedSnapshot(
  `${oversizedSecret}${'x'.repeat(1024 * 1024 + 1)}`,
  'oversized-secret-sentinel',
  'room_store_too_large',
  {},
  oversizedSecret,
);
await verifyRejectedSnapshot(JSON.stringify({
  version: 1,
  savedAt: Date.now(),
  rooms: [{ roomCode: 'LONGNAME', roomName: 'n'.repeat(65) }],
}), 'oversized-room-name', 'room_store_too_large');
await verifyRejectedSnapshot(JSON.stringify({
  version: 1,
  savedAt: Date.now(),
  rooms: [{ roomCode: 'LONGPLAYLIST', playlist: Array.from({ length: 201 }, () => ({})) }],
}), 'oversized-playlist', 'room_store_too_large');
await verifyRejectedSnapshot(JSON.stringify({
  version: 1,
  savedAt: Date.now(),
  rooms: Array.from({ length: 21 }, (_, index) => ({ roomCode: `ROOM${index}` })),
}), 'oversized-room-count', 'room_store_too_large', { ROOM_STORE_MAX_ROOMS: '20' });

const now = Date.now();
await verifyAcceptedSnapshot(JSON.stringify({
  version: 1,
  savedAt: now,
  rooms: Array.from({ length: 21 }, (_, index) => ({
    roomCode: `LEGACY${index}`,
    roomName: `Legacy ${index}`,
    createdAt: now,
    updatedAt: now,
    emptySince: now,
    reconnectMembers: Object.fromEntries(Array.from({ length: 120 }, (__, reconnectIndex) => [
      `member-${reconnectIndex}`,
      { tokenHash: 'a'.repeat(64), expiresAt: reconnectIndex < 70 ? now - 1 : now + 60_000 },
    ])),
  })),
}), 'legacy-room-and-reconnect-capacity');

const blockedParent = path.join(os.tmpdir(), `together-see-store-write-blocked-${process.pid}-${Date.now()}`);
const writeSecret = 'write-failure-secret-must-not-leak';
fs.writeFileSync(blockedParent, writeSecret, 'utf8');
Object.assign(process.env, {
  NODE_ENV: 'test',
  ROOM_STORE_ENABLED: 'true',
  ROOM_STORE_FILE: path.join(blockedParent, 'rooms.json'),
  ROOM_STORE_WRITE_DELAY_MS: '10',
  ROOM_STORE_MAX_BYTES: String(1024 * 1024),
  ROOM_STORE_MAX_ROOM_BYTES: String(256 * 1024),
});
const { RoomStoreService } = await import(`../dist/services/room-store.service.js?write-failure=${Date.now()}`);
const failedStore = new RoomStoreService();
failedStore.setSnapshotProvider(() => []);
let warningOutput = '';
const originalWarn = console.warn;
console.warn = (message) => { warningOutput += String(message); };
try {
  failedStore.saveRooms();
  await assert.rejects(failedStore.flush(), /room_store_write_failed/);
} finally {
  console.warn = originalWarn;
  fs.rmSync(blockedParent, { force: true });
}
assert.deepEqual(failedStore.getHealth(), {
  ok: false,
  enabled: true,
  errorCode: 'room_store_write_failed',
});
assert.equal(warningOutput.includes(writeSecret), false, 'write failure diagnostics must not expose store content');

console.log('store health verification passed');
