import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const serverRoot = process.cwd();
const projectRoot = path.resolve(serverRoot, '..');

async function isPortClosed(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`);
    return false;
  } catch (error) {
    return true;
  }
}

async function pickTestPort() {
  if (process.env.VERIFY_HTTP_SMOKE_PORT) return Number(process.env.VERIFY_HTTP_SMOKE_PORT);
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

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body };
}

async function waitForHealth(baseUrl, getExitCode) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const exitCode = getExitCode();
    if (exitCode !== null) throw new Error(`server process exited before health check passed: ${exitCode}`);
    try {
      const { response, body } = await fetchJson(`${baseUrl}/api/health`);
      if (response.ok && body.ok === true) return body;
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw lastError || new Error('server health check did not become ready');
}

function findLocalAssetRefs(fileName) {
  const html = fs.readFileSync(path.join(projectRoot, fileName), 'utf8');
  const refs = new Set();
  const pattern = /\b(?:src|href)=["']([^"']+)["']/g;
  let match;
  while ((match = pattern.exec(html))) {
    const ref = match[1].split('?')[0].replace(/^\.\//, '');
    if (ref.startsWith('/assets/')) refs.add(ref.slice(1));
    else if (ref.startsWith('assets/')) refs.add(ref);
  }
  return Array.from(refs);
}

function verifyStaticAssetRefs() {
  const refs = [...findLocalAssetRefs('index.html'), ...findLocalAssetRefs('room.html')];
  assert.ok(refs.length > 0, 'expected local static asset references in HTML files');
  refs.forEach((ref) => {
    const filePath = path.join(projectRoot, ref);
    assert.ok(fs.existsSync(filePath), `missing static asset referenced by HTML: ${ref}`);
  });
  return refs.length;
}

const port = await pickTestPort();
const baseUrl = `http://127.0.0.1:${port}`;
const storeFile = path.join(serverRoot, 'data', `verify-http-smoke-${Date.now()}.json`);
const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: serverRoot,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    PUBLIC_ORIGIN: '*',
    ROOM_STORE_FILE: storeFile,
    ROOM_STORE_WRITE_DELAY_MS: '10',
    ROOM_MAX_ACTIVE: '3',
    ROOM_CREATE_RATE_LIMIT_PER_MINUTE: '20',
    PARSE_RATE_LIMIT_PER_MINUTE: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let childExitCode = null;
child.stdout.on('data', (chunk) => { output += chunk.toString(); });
child.stderr.on('data', (chunk) => { output += chunk.toString(); });
child.once('exit', (code, signal) => {
  childExitCode = signal || code;
});

try {
  const health = await waitForHealth(baseUrl, () => childExitCode);
  assert.equal(health.service, 'together-see-server');

  const roomName = `HTTP Smoke ${Date.now()}`;
  const creationCredentials = {
    adminToken: 'A'.repeat(32),
    recoveryCode: 'ABCDE-FGHIJ-KLMNO-PQRST',
  };
  const missingRoom = await fetchJson(`${baseUrl}/api/rooms/${encodeURIComponent(roomName)}`);
  assert.equal(missingRoom.response.status, 200);
  assert.equal(missingRoom.body.exists, false, 'room lookup must not create a missing room');
  assert.equal(missingRoom.body.room, null);

  const createRoom = await fetchJson(`${baseUrl}/api/rooms/${encodeURIComponent(roomName)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName, ...creationCredentials }),
  });
  assert.equal(createRoom.response.status, 201);
  assert.equal(createRoom.body.success, true);
  assert.equal(createRoom.body.room.roomName, roomName);
  assert.ok(createRoom.body.adminToken, 'room creation should return a private admin token to the creator');
  assert.ok(createRoom.body.recoveryCode, 'room creation should return a private recovery code to the creator');
  assert.equal(createRoom.body.room.members, undefined, 'room HTTP API must not expose members before Socket.IO admission');
  assert.equal(createRoom.body.room.playlist, undefined, 'room HTTP API must not expose the playlist before admission');
  assert.equal(createRoom.body.room.chat, undefined, 'room HTTP API must not expose chat before admission');
  assert.equal(createRoom.body.room.playback, undefined, 'room HTTP API must not expose playback before admission');
  assert.equal(createRoom.body.room.audit, undefined, 'room HTTP API must not expose audit history before admission');

  const idempotentRoom = await fetchJson(`${baseUrl}/api/rooms/${encodeURIComponent(roomName)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName, ...creationCredentials }),
  });
  assert.equal(idempotentRoom.response.status, 200, 'the same pending creator should be able to retry a lost creation response');
  assert.equal(idempotentRoom.body.adminToken, creationCredentials.adminToken);

  const duplicateRoom = await fetchJson(`${baseUrl}/api/rooms/${encodeURIComponent(roomName)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName, adminToken: 'B'.repeat(32), recoveryCode: 'UVWXY-Z1234-56789-ABCDE' }),
  });
  assert.equal(duplicateRoom.response.status, 409);
  assert.equal(duplicateRoom.body.code, 'room_exists');
  assert.equal(duplicateRoom.body.adminToken, undefined, 'duplicate creation must not disclose the existing admin token');

  const protectedRoomName = `${roomName} Protected`;
  const protectedRoom = await fetchJson(`${baseUrl}/api/rooms/${encodeURIComponent(protectedRoomName)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      roomName: protectedRoomName,
      password: 'test-password',
      adminToken: 'C'.repeat(32),
      recoveryCode: 'FGHIJ-KLMNO-PQRST-UVWXY',
    }),
  });
  assert.equal(protectedRoom.response.status, 201);
  assert.ok(protectedRoom.body.adminToken);
  assert.ok(protectedRoom.body.recoveryCode);
  assert.equal(protectedRoom.body.room.security.hasPassword, true, 'create dialog password should protect the room before Socket.IO admission');
  assert.equal(JSON.stringify(protectedRoom.body).includes('test-password'), false, 'room creation response must not expose plaintext password');

  const shortPasswordRoom = await fetchJson(`${baseUrl}/api/rooms/${encodeURIComponent(`${roomName} Short`)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      password: '123',
      adminToken: 'D'.repeat(32),
      recoveryCode: 'Z1234-56789-ABCDE-FGHIJ',
    }),
  });
  assert.equal(shortPasswordRoom.response.status, 400);
  assert.equal(shortPasswordRoom.body.code, 'password_too_short');

  const thirdRoomName = `${roomName} Third`;
  const thirdRoom = await fetchJson(`${baseUrl}/api/rooms/${encodeURIComponent(thirdRoomName)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      roomName: thirdRoomName,
      adminToken: 'E'.repeat(32),
      recoveryCode: 'KLMNO-PQRST-UVWXY-Z1234',
    }),
  });
  assert.equal(thirdRoom.response.status, 201);
  const overLimitRoom = await fetchJson(`${baseUrl}/api/rooms/${encodeURIComponent(`${roomName} Over Limit`)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      adminToken: 'F'.repeat(32),
      recoveryCode: '56789-ABCDE-FGHIJ-KLMNO',
    }),
  });
  assert.equal(overLimitRoom.response.status, 503);
  assert.equal(overLimitRoom.body.code, 'room_limit_reached');

  const getRoom = await fetchJson(`${baseUrl}/api/rooms/${encodeURIComponent(roomName)}`);
  assert.equal(getRoom.response.status, 200);
  assert.equal(getRoom.body.success, true);
  assert.equal(getRoom.body.exists, true);
  assert.equal(getRoom.body.room.roomCode, createRoom.body.room.roomCode);
  assert.deepEqual(Object.keys(getRoom.body.room).sort(), ['roomCode', 'roomName', 'security']);

  const privateDirectVideo = await fetchJson(`${baseUrl}/api/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://127.0.0.1/private.mp4' }),
  });
  assert.equal(privateDirectVideo.response.status, 403, 'private direct media URLs must be rejected by the HTTP API');
  assert.equal(privateDirectVideo.body.success, false);
  assert.equal(privateDirectVideo.body.src, '');

  const nonStandardPortVideo = await fetchJson(`${baseUrl}/api/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com:8443/video.mp4' }),
  });
  assert.equal(nonStandardPortVideo.response.status, 403, 'the parser must reject non-standard public ports');

  const nonHttpVideo = await fetchJson(`${baseUrl}/api/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'file:///etc/passwd.mp4' }),
  });
  assert.equal(nonHttpVideo.response.status, 400, 'the HTTP parser must reject non-http(s) media inputs');
  assert.equal(nonHttpVideo.body.success, false);

  const missingApi = await fetch(`${baseUrl}/api/not-found`);
  assert.equal(missingApi.status, 404);

  const socketClient = await fetch(`${baseUrl}/socket.io/socket.io.js`);
  assert.equal(socketClient.status, 200);
  assert.match(socketClient.headers.get('content-type') || '', /javascript|text\/plain/i);
  const socketSource = await socketClient.text();
  assert.match(socketSource, /socket\.io/i);

  const assetCount = verifyStaticAssetRefs();
  console.log(`http smoke verification passed: ${baseUrl} (${assetCount} static assets checked)`);
} catch (error) {
  console.error(output);
  throw error;
} finally {
  if (childExitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(3000)]);
  }
  child.stdout.destroy();
  child.stderr.destroy();
}
