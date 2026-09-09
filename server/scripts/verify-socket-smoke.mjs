import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const serverRoot = process.cwd();
const { BoundedSlidingWindowRateLimiter } = await import('../dist/utils/rate-limit.js');
const boundedLimiter = new BoundedSlidingWindowRateLimiter(4);
for (let index = 0; index < 20; index += 1) boundedLimiter.allow(`random-key-${index}`, 2, 60_000, 1_000);
assert.equal(boundedLimiter.bucketCount, 4, 'rate-limit buckets must stay within their hard LRU key cap');

async function isPortClosed(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`);
    return false;
  } catch (error) {
    return true;
  }
}

async function pickTestPort() {
  if (process.env.VERIFY_SOCKET_SMOKE_PORT) return Number(process.env.VERIFY_SOCKET_SMOKE_PORT);
  const base = 45670;
  for (let offset = 0; offset < 80; offset += 1) {
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
      if (response.ok && body.ok === true) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw lastError || new Error('server health check did not become ready');
}

function parseEnginePayload(text) {
  return text.split('\x1e').filter(Boolean);
}

function decodeSocketPacket(packet) {
  if (packet === '2') return { type: 'ping' };
  if (packet === '40' || packet.startsWith('40{')) return { type: 'connect' };
  if (packet.startsWith('43')) {
    const match = packet.match(/^43(\d+)(.*)$/);
    if (!match) return { type: 'other', raw: packet };
    const payload = JSON.parse(match[2] || '[]');
    return { type: 'ack', id: Number(match[1]), data: payload[0] };
  }
  if (!packet.startsWith('42')) return { type: 'other', raw: packet };
  const payload = JSON.parse(packet.slice(2));
  return { type: 'event', name: payload[0], data: payload[1] };
}

class PollingSocket {
  constructor(baseUrl, label, headers = {}) {
    this.baseUrl = baseUrl;
    this.label = label;
    this.headers = headers;
    this.sid = '';
    this.events = [];
    this.acks = [];
    this.counter = 0;
    this.ackCounter = 0;
  }

  url(extra = '') {
    const glue = extra ? `&${extra}` : '';
    return `${this.baseUrl}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(this.sid)}&t=${Date.now()}-${this.counter += 1}${glue}`;
  }

  async connect() {
    const handshakeUrl = `${this.baseUrl}/socket.io/?EIO=4&transport=polling&t=${Date.now()}-${this.counter += 1}`;
    let response;
    try {
      response = await fetch(handshakeUrl, { headers: this.headers });
    } catch (error) {
      throw new Error(`${this.label} handshake failed; server exit=${childExitCode}\n${output.slice(-8000)}`, { cause: error });
    }
    assert.equal(response.status, 200, `${this.label} handshake should succeed`);
    const packets = parseEnginePayload(await response.text());
    const openPacket = packets.find((packet) => packet.startsWith('0'));
    assert.ok(openPacket, `${this.label} should receive an Engine.IO open packet`);
    this.sid = JSON.parse(openPacket.slice(1)).sid;
    assert.ok(this.sid, `${this.label} should receive a sid`);
    await this.post('40');
    await this.pollUntil((packet) => packet.type === 'connect', 1500);
  }

  async post(packet) {
    let response;
    try {
      response = await fetch(this.url(), {
        method: 'POST',
        headers: { ...this.headers, 'content-type': 'text/plain;charset=UTF-8' },
        body: packet,
      });
    } catch (error) {
      throw new Error(`${this.label} POST failed; server exit=${childExitCode}\n${output.slice(-8000)}`, { cause: error });
    }
    assert.ok(response.ok, `${this.label} POST should succeed: ${response.status}`);
  }

  async emit(name, payload) {
    await this.post(`42${JSON.stringify([name, payload])}`);
  }

  async emitWithAck(name, payload, timeoutMs = 3000) {
    const ackId = this.ackCounter += 1;
    await this.post(`42${ackId}${JSON.stringify([name, payload])}`);
    const packet = await this.pollUntil((candidate) => candidate.type === 'ack' && candidate.id === ackId, timeoutMs);
    return packet.data;
  }

  async pollOnce() {
    let response;
    try {
      response = await fetch(this.url(), { headers: this.headers });
    } catch (error) {
      throw new Error(`${this.label} poll failed; server exit=${childExitCode}\n${output.slice(-8000)}`, { cause: error });
    }
    assert.ok(response.ok, `${this.label} poll should succeed: ${response.status}`);
    const packets = parseEnginePayload(await response.text()).map(decodeSocketPacket);
    for (const packet of packets) {
      if (packet.type === 'ping') await this.post('3');
      if (packet.type === 'event') this.events.push(packet);
      if (packet.type === 'ack') this.acks.push(packet);
    }
    return packets;
  }

  async pollUntil(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const cached = [...this.events, ...this.acks].find(predicate);
      if (cached) return cached;
      const packets = await this.pollOnce();
      const match = packets.find(predicate);
      if (match) return match;
    }
    throw new Error(`${this.label} timed out waiting for Socket.IO packet`);
  }

  async waitForEvent(name, predicate = () => true, timeoutMs = 3000) {
    return this.pollUntil((packet) => packet.type === 'event' && packet.name === name && predicate(packet.data), timeoutMs);
  }

  async close() {
    if (!this.sid) return;
    await this.post('41').catch(() => {});
  }
}

const port = await pickTestPort();
const baseUrl = `http://127.0.0.1:${port}`;
const storeFile = path.join(serverRoot, 'data', `verify-socket-smoke-${Date.now()}.json`);
const verifiedDirectPreload = pathToFileURL(path.join(serverRoot, 'scripts', 'fixtures', 'preload-verified-direct.mjs')).href;
const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: serverRoot,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    PUBLIC_ORIGIN: '*',
    ROOM_STORE_FILE: storeFile,
    ROOM_STORE_WRITE_DELAY_MS: '10',
    ROOM_MAX_MEMBERS: '2',
    ROOM_MAX_PLAYLIST_ITEMS: '12',
    ROOM_RECONNECT_GRACE_MS: '4000',
    ROOM_HOST_RECONNECT_GRACE_MS: '1000',
    PARSE_RATE_LIMIT_PER_MINUTE: '0',
    HLS_PROXY_ALLOWED_HOSTS: 'media.example.com,*.bilivideo.com',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${verifiedDirectPreload}`].filter(Boolean).join(' '),
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

const host = new PollingSocket(baseUrl, 'host');
const guest = new PollingSocket(baseUrl, 'guest');
const overflowGuest = new PollingSocket(baseUrl, 'overflow guest');
const blockedGuest = new PollingSocket(baseUrl, 'blocked guest', { 'x-forwarded-for': '198.51.100.10' });
const independentPasswordGuest = new PollingSocket(baseUrl, 'independent password guest', { 'x-forwarded-for': '198.51.100.11' });
const reconnectedHost = new PollingSocket(baseUrl, 'reconnected host');
const reconnectedGuest = new PollingSocket(baseUrl, 'reconnected guest');
const capacityCreator = new PollingSocket(baseUrl, 'capacity creator');
const capacityReserved = new PollingSocket(baseUrl, 'capacity reserved member');
const capacityOverflow = new PollingSocket(baseUrl, 'capacity overflow member');
const capacityReconnect = new PollingSocket(baseUrl, 'capacity reconnect member');
const authorityCreator = new PollingSocket(baseUrl, 'authority creator reclaim');
const adminOwner = new PollingSocket(baseUrl, 'admin failover owner');
const adminSuccessor = new PollingSocket(baseUrl, 'admin failover successor');
const adminReclaimer = new PollingSocket(baseUrl, 'admin failover reclaimer');
const proxyScopeMember = new PollingSocket(baseUrl, 'proxy scope member');
const playlistCapacityHost = new PollingSocket(baseUrl, 'playlist capacity host');
const playlistCapacityGuest = new PollingSocket(baseUrl, 'playlist capacity guest');
const globalJoinRateGuest = new PollingSocket(baseUrl, 'global join rate guest', { 'x-forwarded-for': '198.51.100.55' });
const roomCode = `SOCKET${Date.now().toString(36).slice(-5).toUpperCase()}`;
const chatText = `socket chat ${Date.now()}`;
const hostChatText = `host socket chat ${Date.now()}`;
const hostDanmakuText = `host danmaku ${Date.now()}`;
const guestDanmakuText = `guest danmaku ${Date.now()}`;
const roomCreationCredentials = {
  adminToken: 'S'.repeat(32),
  recoveryCode: 'SOCKE-TTEST-RECOV-ERY12',
};

try {
  await waitForHealth(baseUrl, () => childExitCode);
  await host.connect();
  await guest.connect();
  await overflowGuest.connect();
  await blockedGuest.connect();
  await independentPasswordGuest.connect();
  await globalJoinRateGuest.connect();

  await blockedGuest.emit('join_room', { roomCode, memberId: 'missing-room-member', name: 'Missing' });
  const missingRoomEvent = await blockedGuest.waitForEvent('room_error', (payload) => payload.code === 'room_not_found');
  assert.equal(missingRoomEvent.data.state, undefined, 'missing-room rejection must not expose or create room state');

  const createdRoom = await fetchJson(`${baseUrl}/api/rooms/${encodeURIComponent(roomCode)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName: 'Socket Smoke', ...roomCreationCredentials }),
  });
  assert.equal(createdRoom.response.status, 201, 'Socket room must be explicitly created before joining');
  assert.ok(createdRoom.body.adminToken);
  assert.ok(createdRoom.body.recoveryCode);

  await blockedGuest.emit('join_room', { roomCode, memberId: 'race-attacker', name: 'Race Attacker' });
  const creatorPendingEvent = await blockedGuest.waitForEvent('room_error', (payload) => payload.code === 'creator_pending');
  assert.equal(creatorPendingEvent.data.state, undefined, 'a pre-creator rejection must not expose protected room state');
  await sleep(50);
  const diagnosticLine = output.split(/\r?\n/).find((line) => line.includes('[together-see-server] join_rejected') && line.includes('"rejectionCode":"creator_pending"'));
  assert.ok(diagnosticLine, 'creator admission rejection should emit a structured diagnostic');
  const diagnostic = JSON.parse(diagnosticLine.slice(diagnosticLine.indexOf('{')));
  assert.deepEqual(
    Object.keys(diagnostic).sort(),
    ['adminTokenPresent', 'adminTokenValid', 'clientType', 'creatorPending', 'event', 'rejectionCode', 'roomFingerprint'].sort(),
    'join diagnostics should expose only the approved non-secret fields',
  );
  assert.equal(diagnostic.creatorPending, true);
  assert.equal(diagnostic.adminTokenPresent, false);
  assert.equal(diagnostic.adminTokenValid, false);
  assert.equal(diagnostic.rejectionCode, 'creator_pending');
  assert.match(diagnostic.roomFingerprint, /^[a-f0-9]{12}$/);
  assert.doesNotMatch(diagnosticLine, new RegExp(roomCode), 'join diagnostics must not log the room code');
  assert.doesNotMatch(diagnosticLine, new RegExp(roomCreationCredentials.adminToken), 'join diagnostics must not log admin tokens');
  assert.doesNotMatch(diagnosticLine, new RegExp(roomCreationCredentials.recoveryCode), 'join diagnostics must not log recovery codes');

  await host.emit('join_room', {
    roomCode,
    roomName: 'Socket Smoke',
    memberId: 'host-a',
    name: 'Alice',
    adminToken: createdRoom.body.adminToken,
  });
  const hostMemberTokenEvent = await host.waitForEvent('room_member_token', (payload) => payload.roomCode === roomCode && payload.memberId === 'host-a' && payload.reconnectToken);
  const hostPermissionEvent = await host.waitForEvent('room_permissions', (payload) => payload.roomCode === roomCode && payload.memberId === 'host-a');
  assert.equal(hostPermissionEvent.data.canManage, true, 'the server should privately confirm creator management permission');
  const tokenEvent = { data: { adminToken: createdRoom.body.adminToken, recoveryCode: createdRoom.body.recoveryCode } };
  assert.ok(tokenEvent.data.adminToken, 'host should receive an admin token');
  assert.ok(tokenEvent.data.recoveryCode, 'host should receive an admin recovery code');

  const verifiedVideoUrl = 'https://93.184.216.34/verified-room-video.mp4?token=exact';
  const verifiedHlsUrl = 'https://93.184.216.34/verified-room-stream.m3u8?token=exact';
  const bilibiliPageUrl = 'https://www.bilibili.com/video/BV1182FBRExJ';
  const expiredBilibiliUrl = 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/socket-expired.mp4?deadline=expired';
  const refreshedBilibiliUrl = 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/socket-refreshed.mp4?deadline=fresh';
  await host.emit('proxy_token_request', {
    requestId: 'proxy-verified-not-in-playlist',
    roomCode,
    routeName: 'media',
    url: verifiedVideoUrl,
  });
  const verifiedButUnscopedGrant = await host.waitForEvent('proxy_token_created', (payload) => payload.requestId === 'proxy-verified-not-in-playlist');
  assert.equal(verifiedButUnscopedGrant.data.success, false, 'a verified direct URL must not grant access before it belongs to the current room playlist');
  assert.equal(verifiedButUnscopedGrant.data.code, 'parse_source_denied');

  const proxyScopeRoomCode = `PROXY${Date.now().toString(36).slice(-5).toUpperCase()}`;
  const proxyScopeRoom = await fetchJson(`${baseUrl}/api/rooms/${encodeURIComponent(proxyScopeRoomCode)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      roomName: 'Proxy Scope Isolation',
      adminToken: 'P'.repeat(32),
      recoveryCode: 'PROXY-SCOPE-RECOV-ERY12',
    }),
  });
  assert.equal(proxyScopeRoom.response.status, 201);
  await proxyScopeMember.connect();
  await proxyScopeMember.emit('join_room', {
    roomCode: proxyScopeRoomCode,
    memberId: 'proxy-scope-member',
    name: 'Proxy Scope Member',
    adminToken: proxyScopeRoom.body.adminToken,
  });
  await proxyScopeMember.waitForEvent('room_state', (state) => state.roomCode === proxyScopeRoomCode);
  await proxyScopeMember.emit('proxy_token_request', {
    requestId: 'proxy-verified-cross-room',
    roomCode: proxyScopeRoomCode,
    routeName: 'media',
    url: verifiedVideoUrl,
  });
  const crossRoomGrant = await proxyScopeMember.waitForEvent('proxy_token_created', (payload) => payload.requestId === 'proxy-verified-cross-room');
  assert.equal(crossRoomGrant.data.success, false, 'a global verification record must not authorize another room without the exact playlist item');
  assert.equal(crossRoomGrant.data.code, 'parse_source_denied');

  await host.emit('playlist_add', {
    roomCode,
    item: {
      title: 'Verified Direct Room Video',
      pageUrl: verifiedVideoUrl,
      sourceUrl: verifiedVideoUrl,
      sourceType: 'video',
    },
  });
  await host.waitForEvent('room_state', (state) => state.roomCode === roomCode
    && state.playlist?.some((item) => item.sourceUrl === verifiedVideoUrl));
  await host.emit('proxy_token_request', {
    requestId: 'proxy-verified-in-playlist',
    roomCode,
    routeName: 'media',
    url: verifiedVideoUrl,
  });
  const roomScopedVideoGrant = await host.waitForEvent('proxy_token_created', (payload) => payload.requestId === 'proxy-verified-in-playlist');
  assert.equal(roomScopedVideoGrant.data.success, true, 'an exact verified direct URL in the current room playlist should receive a grant');
  assert.match(roomScopedVideoGrant.data.proxyUrl, /^\/api\/proxy\/media\?token=[A-Za-z0-9_-]+$/);
  await host.emit('proxy_token_request', {
    requestId: 'proxy-verified-query-mismatch',
    roomCode,
    routeName: 'media',
    url: `${verifiedVideoUrl}-changed`,
  });
  const changedQueryGrant = await host.waitForEvent('proxy_token_created', (payload) => payload.requestId === 'proxy-verified-query-mismatch');
  assert.equal(changedQueryGrant.data.success, false, 'a changed query must not reuse another exact URL verification or room entry');
  assert.equal(changedQueryGrant.data.code, 'parse_source_denied');

  await host.emit('playlist_add', {
    roomCode,
    item: {
      title: 'Verified Direct Room HLS',
      pageUrl: verifiedHlsUrl,
      sourceUrl: verifiedHlsUrl,
      sourceType: 'hls',
    },
  });
  await host.waitForEvent('room_state', (state) => state.roomCode === roomCode
    && state.playlist?.some((item) => item.sourceUrl === verifiedHlsUrl));
  await host.emit('proxy_token_request', {
    requestId: 'proxy-verified-hls-in-playlist',
    roomCode,
    routeName: 'hls',
    url: verifiedHlsUrl,
  });
  const roomScopedHlsGrant = await host.waitForEvent('proxy_token_created', (payload) => payload.requestId === 'proxy-verified-hls-in-playlist');
  assert.equal(roomScopedHlsGrant.data.success, true, 'an exact verified HLS URL in the current room playlist should receive a grant');
  assert.match(roomScopedHlsGrant.data.proxyUrl, /^\/api\/proxy\/hls\?token=[A-Za-z0-9_-]+$/);

  await host.emit('proxy_token_request', {
    requestId: 'proxy-public-source',
    roomCode,
    routeName: 'hls',
    url: 'https://media.example.com/video.m3u8?signature=private-value',
    refUrl: 'https://media.example.com/watch/private-page',
  });
  const proxyGrant = await host.waitForEvent('proxy_token_created', (payload) => payload.requestId === 'proxy-public-source');
  assert.equal(proxyGrant.data.success, false, 'allowlisted media must still belong to the current room playlist before a member receives a grant');
  assert.equal(proxyGrant.data.code, 'parse_source_denied');
  await host.emit('proxy_token_request', {
    requestId: 'proxy-unlisted-unverified-source',
    roomCode,
    routeName: 'media',
    url: 'https://unlisted.example.com/video.mp4',
  });
  const unverifiedProxyGrant = await host.waitForEvent('proxy_token_created', (payload) => payload.requestId === 'proxy-unlisted-unverified-source');
  assert.equal(unverifiedProxyGrant.data.success, false, 'an unlisted host must not receive a generic proxy grant without a verified direct-media record');
  assert.equal(unverifiedProxyGrant.data.code, 'parse_source_denied');
  await host.emit('proxy_token_request', {
    requestId: 'proxy-private-source',
    roomCode,
    routeName: 'media',
    url: 'http://127.0.0.1/private.mp4',
  });
  const privateProxyGrant = await host.waitForEvent('proxy_token_created', (payload) => payload.requestId === 'proxy-private-source');
  assert.equal(privateProxyGrant.data.success, false, 'private network media must not receive proxy grants');
  assert.equal(privateProxyGrant.data.code, 'parse_source_denied');
  assert.equal(privateProxyGrant.data.message, '当前视频源不在可解析范围');
  assert.equal(/代理|HLS_PROXY_ALLOWED_HOSTS|生产环境/.test(privateProxyGrant.data.message), false, 'public grant failures must hide deployment details');
  await independentPasswordGuest.emit('proxy_token_request', {
    requestId: 'proxy-not-joined',
    roomCode,
    routeName: 'media',
    url: 'https://media.example.com/video.mp4',
  });
  const deniedProxyGrant = await independentPasswordGuest.waitForEvent('proxy_token_created', (payload) => payload.requestId === 'proxy-not-joined');
  assert.equal(deniedProxyGrant.data.success, false, 'sockets outside the room must not receive proxy grants');
  assert.equal(deniedProxyGrant.data.code, 'room_access_required');

  await host.emit('recover_admin_token', { roomCode, recoveryCode: tokenEvent.data.recoveryCode, memberId: 'host-a', name: 'Alice' });
  const recoveredTokenEvent = await host.waitForEvent('room_admin_token', (payload) => payload.roomCode === roomCode && payload.recovered === true && payload.adminToken && payload.recoveryCode);
  assert.notEqual(recoveredTokenEvent.data.adminToken, tokenEvent.data.adminToken, 'recovery should rotate the admin token');
  const recoveredPermissionEvent = await host.waitForEvent('room_permissions', (payload) => payload.roomCode === roomCode && payload.memberId === 'host-a' && payload.canManage === true);
  assert.equal(recoveredPermissionEvent.data.canManage, true, 'management recovery should immediately refresh the private permission status');
  await host.waitForEvent('room_state', (state) => state.roomCode === roomCode && state.audit?.some((entry) => entry.action === 'admin_token_recovered'));

  await guest.emit('join_room', { roomCode, memberId: 'guest-b', name: 'Bob' });
  const guestJoinSystemEvent = await host.waitForEvent('chat_message_created', (message) => message.kind === 'system' && /Bob.*加入了房间/.test(message.text || ''));
  assert.equal(guestJoinSystemEvent.data.senderId, 'system');
  const guestMemberTokenEvent = await guest.waitForEvent('room_member_token', (payload) => payload.roomCode === roomCode && payload.memberId === 'guest-b' && payload.reconnectToken);
  const guestPermissionEvent = await guest.waitForEvent('room_permissions', (payload) => payload.roomCode === roomCode && payload.memberId === 'guest-b');
  assert.equal(guestPermissionEvent.data.canManage, false, 'ordinary members must receive an explicit read-only management status');

  await host.emit('playlist_add', {
    roomCode,
    item: {
      id: 'bilibili-expiring-source',
      title: 'Expiring Bilibili Source',
      pageUrl: bilibiliPageUrl,
      sourceUrl: expiredBilibiliUrl,
      sourceType: 'video',
      refererUrl: bilibiliPageUrl,
      finalUrl: bilibiliPageUrl,
      bilibili: {
        bvid: 'BV1182FBRExJ',
        cid: 33755434897,
        page: 1,
        quality: 64,
        qualityLabel: '720P 高清',
        danmakuAvailable: true,
        danmakuEnabled: true,
      },
    },
  });
  const expiringBilibiliState = await guest.waitForEvent('room_state', (state) => state.roomCode === roomCode
    && state.playlist?.some((item) => item.id === 'bilibili-expiring-source' && item.sourceUrl === expiredBilibiliUrl));
  const playbackBeforeBilibiliRefresh = { ...expiringBilibiliState.data.playback };
  const refreshedBilibiliState = await guest.emitWithAck('playlist_bilibili_source_refresh', {
    roomCode,
    itemId: 'bilibili-expiring-source',
  }, 12_000);
  const refreshedBilibiliItem = refreshedBilibiliState?.playlist?.find((item) => item.id === 'bilibili-expiring-source');
  assert.equal(refreshedBilibiliItem?.sourceUrl, refreshedBilibiliUrl, 'an ordinary admitted member should be able to trigger a server-verified refresh of an expired Bilibili URL');
  assert.equal(refreshedBilibiliItem?.bilibili?.danmakuEnabled, true, 'Bilibili source refresh must preserve the shared danmaku setting');
  assert.deepEqual(refreshedBilibiliState?.playback, playbackBeforeBilibiliRefresh, 'Bilibili source refresh must not change playback revision, time or intent');
  await guest.emit('proxy_token_request', {
    requestId: 'proxy-refreshed-bilibili-source',
    roomCode,
    routeName: 'media',
    url: refreshedBilibiliUrl,
  });
  const refreshedBilibiliGrant = await guest.waitForEvent('proxy_token_created', (payload) => payload.requestId === 'proxy-refreshed-bilibili-source');
  assert.equal(refreshedBilibiliGrant.data.success, true, 'the refreshed authoritative Bilibili URL should receive a room-bound proxy grant');
  await proxyScopeMember.emit('proxy_token_request', {
    requestId: 'proxy-refreshed-bilibili-cross-room',
    roomCode: proxyScopeRoomCode,
    routeName: 'media',
    url: refreshedBilibiliUrl,
  });
  const refreshedCrossRoomGrant = await proxyScopeMember.waitForEvent('proxy_token_created', (payload) => payload.requestId === 'proxy-refreshed-bilibili-cross-room');
  assert.equal(refreshedCrossRoomGrant.data.success, false, 'a refreshed Bilibili URL must remain scoped to the room containing the exact playlist item');
  assert.equal(refreshedCrossRoomGrant.data.code, 'parse_source_denied');
  const joinedRoomState = await host.waitForEvent('room_state', (state) => state.roomCode === roomCode && state.members?.length === 2);
  assert.ok(joinedRoomState.data.members.every((member) => !Object.hasOwn(member, 'socketId')), 'public Socket.IO room state must not expose internal socket ids');
  await guest.waitForEvent('room_state', (state) => state.roomCode === roomCode && state.members?.length === 2);

  await reconnectedHost.connect();
  await reconnectedHost.emit('join_room', {
    roomCode,
    memberId: 'host-a',
    name: 'Online Host Replay',
    reconnectToken: hostMemberTokenEvent.data.reconnectToken,
  });
  await reconnectedHost.waitForEvent('room_error', (payload) => payload.code === 'member_online_elsewhere' && /仍在线/.test(payload.message || ''));

  host.events = [];
  await host.emit('join_room', {
    roomCode,
    memberId: 'host-a',
    name: 'Alice',
    adminToken: recoveredTokenEvent.data.adminToken,
    reconnectToken: hostMemberTokenEvent.data.reconnectToken,
  });
  await host.waitForEvent('room_state', (state) => state.roomCode === roomCode
    && state.members?.some((member) => member.id === 'host-a' && member.name === 'Alice'));

  await guest.emit('join_room', { roomCode, memberId: 'guest-shadow', name: 'Shadow' });
  await guest.waitForEvent('room_error', (payload) => payload.code === 'socket_already_joined');
  await host.emit('join_room', { roomCode: `${roomCode}-OTHER`, memberId: 'host-a', name: 'Alice' });
  await host.waitForEvent('room_error', (payload) => payload.code === 'socket_already_joined');

  await overflowGuest.emit('join_room', {
    roomCode,
    memberId: 'guest-b',
    name: 'Impersonated Bob',
    adminToken: recoveredTokenEvent.data.adminToken,
  });
  await overflowGuest.waitForEvent('room_error', (payload) => payload.code === 'admin_member_mismatch');

  await host.emit('transfer_host', { roomCode, memberId: 'guest-b' });
  await guest.waitForEvent('room_state', (state) => state.roomCode === roomCode && state.hostMemberId === 'guest-b');
  overflowGuest.events = [];
  await overflowGuest.emit('join_room', {
    roomCode,
    memberId: 'guest-b',
    name: 'Transferred Host Impersonation',
    adminToken: recoveredTokenEvent.data.adminToken,
  });
  await overflowGuest.waitForEvent('room_error', (payload) => payload.code === 'admin_member_mismatch');
  host.events = [];
  await host.emit('kick_member', { roomCode, memberId: 'guest-b', adminToken: recoveredTokenEvent.data.adminToken });
  await host.waitForEvent('room_error', (payload) => /不能踢出当前房主/.test(payload.message || ''));
  await guest.emit('transfer_host', { roomCode, memberId: 'host-a' });
  await host.waitForEvent('room_state', (state) => state.roomCode === roomCode && state.hostMemberId === 'host-a');

  await guest.emit('member_rename', { roomCode, name: 'Bob Mobile' });
  await host.waitForEvent('room_state', (state) => state.roomCode === roomCode
    && state.members?.some((member) => member.id === 'guest-b' && member.name === 'Bob Mobile')
    && state.chat?.some((message) => message.memberId === 'guest-b'
      && message.systemEvent === 'member_joined'
      && message.text === 'Bob Mobile 加入了房间'));

  await overflowGuest.emit('join_room', { roomCode, memberId: 'guest-c', name: 'Carol' });
  const roomFullEvent = await overflowGuest.waitForEvent('room_error', (payload) => payload.code === 'room_full');
  assert.equal(roomFullEvent.data.state, undefined, 'rejected joins must not receive protected room state');

  await host.emit('playlist_add', {
    roomCode,
    item: {
      title: 'Private Referer Video',
      pageUrl: 'https://93.184.216.34/watch/private-referer',
      sourceUrl: 'https://93.184.216.34/private-referer.mp4',
      refererUrl: 'http://127.0.0.1/private-referrer',
      finalUrl: 'http://169.254.169.254/latest/meta-data',
      sourceType: 'video',
    },
  });
  await host.waitForEvent('room_error', (payload) => /播放项参数无效|公网安全校验/.test(payload.message || ''));

  await host.emit('playlist_add', {
    roomCode,
    item: {
      title: 'Socket Smoke Video',
      pageUrl: 'https://93.184.216.34/socket-video',
      sourceUrl: 'https://93.184.216.34/socket-video.mp4',
      sourceType: 'video',
    },
  });
  const playlistStateEvent = await guest.waitForEvent('room_state', (state) => state.roomCode === roomCode && state.playlist?.some((item) => item.title === 'Socket Smoke Video'));
  const activeItemId = playlistStateEvent.data.playlist.find((item) => item.title === 'Socket Smoke Video')?.id;
  assert.ok(activeItemId, 'host playlist item should have an id');

  const localFile = {
    name: 'Family Movie 01.mp4',
    size: 8_765_432,
    type: 'video/mp4',
    lastModified: 1_720_000_000_000,
  };
  await host.emit('playlist_add', {
    roomCode,
    item: {
      id: 'local-socket-video',
      title: localFile.name,
      pageUrl: 'blob:https://host.example/private-page-token',
      sourceUrl: 'blob:https://host.example/private-source-token',
      sourceType: 'local',
      localFile,
    },
  });
  const localPlaylistState = await guest.waitForEvent('room_state', (state) => state.roomCode === roomCode
    && state.playlist?.some((item) => item.id === 'local-socket-video'));
  const sharedLocalItem = localPlaylistState.data.playlist.find((item) => item.id === 'local-socket-video');
  assert.equal(sharedLocalItem.sourceUrl, 'local://together-see/Family%20Movie%2001.mp4?size=8765432', 'local source URLs must be canonical shared placeholders');
  assert.equal(sharedLocalItem.pageUrl, sharedLocalItem.sourceUrl, 'local page and source placeholders should stay identical');
  assert.equal(sharedLocalItem.refererUrl, '', 'local files must not carry a referer');
  assert.equal(sharedLocalItem.finalUrl, '', 'local files must not carry a final remote URL');
  assert.deepEqual(sharedLocalItem.localFile, localFile, 'local file metadata should be shared without file bytes');
  assert.doesNotMatch(JSON.stringify(sharedLocalItem), /blob:/, 'tab-local blob URLs must never enter shared room state');

  await host.emit('playback_update', {
    roomCode,
    action: 'source',
    baseRevision: localPlaylistState.data.playback.revision,
    client: { ready: true, seeking: false },
    patch: {
      activeSourceId: sharedLocalItem.id,
      playing: false,
      currentTime: 37.5,
      duration: 600,
      playbackRate: 1,
    },
  });
  const pausedLocalPlayback = await guest.waitForEvent('playback_state', (playback) => playback.activeSourceId === sharedLocalItem.id && playback.currentTime === 37.5);
  assert.equal(pausedLocalPlayback.data.playing, false, 'paused local-video state should still synchronize');

  await host.emit('playlist_add', {
    roomCode,
    item: {
      title: 'Private Network Video',
      pageUrl: 'http://127.0.0.1/private.mp4',
      sourceUrl: 'http://127.0.0.1/private.mp4',
      sourceType: 'video',
    },
  });
  await host.waitForEvent('room_error', (payload) => /播放项参数无效/.test(payload.message || ''));

  await host.emit('playback_update', {
    roomCode,
    action: 'source',
    baseRevision: pausedLocalPlayback.data.revision,
    client: { ready: true, seeking: false },
    patch: {
      activeSourceId: activeItemId,
      playing: true,
      currentTime: 18.5,
      duration: 120,
      playbackRate: 1,
    },
  });
  await guest.waitForEvent('playback_state', (playback) => playback.activeSourceId === activeItemId && playback.playing === true);

  overflowGuest.events = [];
  await overflowGuest.emit('join_room', {
    roomCode,
    memberId: 'creator-recovery',
    name: 'Creator Recovery',
    adminToken: recoveredTokenEvent.data.adminToken,
  });
  await overflowGuest.waitForEvent('room_error', (payload) => payload.code === 'admin_member_mismatch' && /管理凭据/.test(payload.message || ''));

  const rejectedPlaylistAck = await guest.emitWithAck('playlist_add', {
    roomCode,
    item: {
      title: 'Guest Should Be Rejected',
      pageUrl: 'https://example.com/rejected',
      sourceUrl: 'https://cdn.example.com/rejected.mp4',
      sourceType: 'video',
    },
  });
  assert.equal(rejectedPlaylistAck.security.controlPolicy, 'host_only');
  assert.equal(
    rejectedPlaylistAck.playlist.some((item) => item.title === 'Guest Should Be Rejected'),
    false,
    'a rejected playlist ACK must return the unchanged authoritative list',
  );
  await guest.waitForEvent('room_error', (payload) => /房主/.test(payload.message || ''));

  guest.events = [];
  await guest.emit('room_autoplay_next_update', { roomCode, enabled: true });
  const rejectedAutoPlay = await guest.waitForEvent('room_error', (payload) => payload.state?.autoPlayNext === false);
  assert.equal(rejectedAutoPlay.data.state.autoPlayNext, false, 'a follower must not change shared autoplay in host-only mode');

  await host.emit('room_autoplay_next_update', { roomCode, enabled: true });
  const hostAutoPlayState = await guest.waitForEvent('room_state', (state) => state.roomCode === roomCode && state.autoPlayNext === true);
  assert.ok(hostAutoPlayState.data.audit.some((entry) => entry.action === 'autoplay_next_updated'), 'shared autoplay changes should be audited');

  await host.emit('room_control_policy_update', { roomCode, controlPolicy: 'everyone', adminToken: recoveredTokenEvent.data.adminToken });
  const everyoneState = await guest.waitForEvent('room_state', (state) => state.roomCode === roomCode && state.security?.controlPolicy === 'everyone');

  await guest.emit('room_autoplay_next_update', { roomCode, enabled: false });
  const collaborativeAutoPlayState = await host.waitForEvent('room_state', (state) => state.roomCode === roomCode && state.autoPlayNext === false);
  assert.equal(collaborativeAutoPlayState.data.autoPlayNext, false, 'everyone mode should let a collaborator update shared autoplay');

  const collaborativeListAck = await guest.emitWithAck('playlist_add', {
    roomCode,
    item: {
      title: 'Guest Collaborative Video',
      pageUrl: 'https://93.184.216.34/guest-collab',
      sourceUrl: 'https://93.184.216.34/guest-collab.mp4',
      sourceType: 'video',
    },
  });
  assert.ok(
    collaborativeListAck.playlist.some((item) => item.title === 'Guest Collaborative Video'),
    'an accepted playlist ACK must include the authoritative item',
  );
  const collaborativeListState = await host.waitForEvent('room_state', (state) => state.roomCode === roomCode && state.playlist?.some((item) => item.title === 'Guest Collaborative Video'));
  const collaborativeItemId = collaborativeListState.data.playlist.find((item) => item.title === 'Guest Collaborative Video')?.id;
  assert.ok(collaborativeItemId, 'the collaborative playlist item should receive an authoritative id');

  await guest.emit('playback_update', {
    roomCode,
    action: 'seek',
    baseRevision: everyoneState.data.playback.revision,
    client: { ready: true, seeking: false },
    patch: {
      activeSourceId: activeItemId,
      playing: false,
      currentTime: 42.25,
      playbackRate: 1.25,
    },
  });
  const collaborativePlayback = await host.waitForEvent('playback_state', (playback) => playback.updatedBy === 'guest-b' && playback.currentTime === 42.25);
  assert.equal(collaborativePlayback.data.playbackRate, 1.25, 'everyone policy should allow a member to take playback control');
  assert.ok(collaborativePlayback.data.controlLeaseUntil > Date.now(), 'collaborative playback control should publish a short lease');

  const playingState = await guest.emitWithAck('playback_update', {
    roomCode,
    action: 'play',
    baseRevision: collaborativePlayback.data.revision,
    client: { ready: true, seeking: false },
    patch: {
      activeSourceId: activeItemId,
      playing: true,
      currentTime: 42.25,
      playbackRate: 1.25,
    },
  });
  assert.equal(playingState.playback.playing, true, 'the collaborative authority should be playing before buffering begins');
  assert.equal(playingState.playback.buffering, false, 'explicit playback should clear stale buffering state');

  const bufferingState = await guest.emitWithAck('playback_update', {
    roomCode,
    action: 'buffering',
    baseRevision: playingState.playback.revision,
    client: { ready: false, seeking: false },
    patch: {
      activeSourceId: activeItemId,
      buffering: true,
      currentTime: 43,
    },
  });
  assert.equal(bufferingState.playback.buffering, true, 'the current authority should publish sustained buffering');
  assert.equal(bufferingState.playback.playing, true, 'buffering must preserve the intended playing state');
  assert.equal(bufferingState.playback.currentTime, 43, 'buffering should anchor the shared clock at the actual media time');

  guest.events = [];
  const rejectedBufferingState = await guest.emitWithAck('playback_update', {
    roomCode,
    action: 'periodic',
    baseRevision: bufferingState.playback.revision,
    client: { ready: true, seeking: false },
    patch: {
      activeSourceId: activeItemId,
      playing: true,
      currentTime: 5,
      playbackRate: 1,
    },
  });
  assert.equal(rejectedBufferingState.playback.revision, bufferingState.playback.revision, 'periodic progress must not advance a buffering room');
  assert.equal(rejectedBufferingState.playback.currentTime, 43, 'a buffering collaborator must not rewind the authoritative timeline');
  const rejectedBufferingPlayback = await guest.waitForEvent('playback_state', (playback) => playback.revision === bufferingState.playback.revision);
  assert.equal(rejectedBufferingPlayback.data.buffering, true, 'a rejected periodic update should return the frozen buffering state');

  const resumedState = await guest.emitWithAck('playback_update', {
    roomCode,
    action: 'buffering',
    baseRevision: bufferingState.playback.revision,
    client: { ready: true, seeking: false },
    patch: {
      activeSourceId: activeItemId,
      buffering: false,
      currentTime: 43.25,
    },
  });
  assert.equal(resumedState.playback.buffering, false, 'the authority should explicitly resume the shared clock after buffering');
  assert.equal(resumedState.playback.playing, true, 'buffering recovery must preserve the intended playing state');

  await host.emit('playback_update', {
    roomCode,
    action: 'source',
    baseRevision: resumedState.playback.revision,
    client: { ready: true, seeking: false },
    patch: {
      activeSourceId: collaborativeItemId,
      playing: false,
      currentTime: 0,
      playbackRate: 1,
    },
  });
  const switchedPlayback = await guest.waitForEvent('playback_state', (playback) => playback.activeSourceId === collaborativeItemId);

  guest.events = [];
  const rejectedOldSourceSeekAck = await guest.emitWithAck('playback_update', {
    roomCode,
    action: 'seek',
    baseRevision: switchedPlayback.data.revision,
    client: { ready: true, seeking: false },
    patch: {
      activeSourceId: activeItemId,
      playing: false,
      currentTime: 17,
      playbackRate: 1,
    },
  });
  assert.equal(rejectedOldSourceSeekAck.playback.activeSourceId, collaborativeItemId, 'a rejected playback ACK must return the authoritative source');
  assert.equal(rejectedOldSourceSeekAck.playback.revision, switchedPlayback.data.revision, 'a rejected playback ACK must not advance revision');
  const rejectedOldSourceSeek = await guest.waitForEvent('playback_state', (playback) => playback.revision === switchedPlayback.data.revision);
  assert.equal(rejectedOldSourceSeek.data.activeSourceId, collaborativeItemId, 'a seek emitted by an old media element must not switch the room back to its source');
  assert.equal(rejectedOldSourceSeek.data.currentTime, switchedPlayback.data.currentTime, 'an old-source seek must leave the authoritative timeline unchanged');

  const playlistCapacityRoomCode = `${roomCode}-LIST-CAP`;
  const playlistCapacityRoom = await fetchJson(`${baseUrl}/api/rooms/${encodeURIComponent(playlistCapacityRoomCode)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      roomName: 'Concurrent Playlist Capacity',
      adminToken: 'L'.repeat(32),
      recoveryCode: 'PLAYL-ISTCA-PACIT-Y1234',
    }),
  });
  assert.equal(playlistCapacityRoom.response.status, 201);
  await playlistCapacityHost.connect();
  await playlistCapacityGuest.connect();
  await playlistCapacityHost.emit('join_room', {
    roomCode: playlistCapacityRoomCode,
    memberId: 'playlist-capacity-host',
    name: 'Playlist Capacity Host',
    adminToken: playlistCapacityRoom.body.adminToken,
  });
  await playlistCapacityHost.waitForEvent('room_permissions', (payload) => payload.roomCode === playlistCapacityRoomCode && payload.canManage === true);
  await playlistCapacityGuest.emit('join_room', {
    roomCode: playlistCapacityRoomCode,
    memberId: 'playlist-capacity-guest',
    name: 'Playlist Capacity Guest',
  });
  await playlistCapacityGuest.waitForEvent('room_state', (state) => state.roomCode === playlistCapacityRoomCode && state.members?.length === 2);
  await playlistCapacityHost.emit('room_control_policy_update', {
    roomCode: playlistCapacityRoomCode,
    controlPolicy: 'everyone',
    adminToken: playlistCapacityRoom.body.adminToken,
  });
  await playlistCapacityGuest.waitForEvent('room_state', (state) => state.roomCode === playlistCapacityRoomCode
    && state.security?.controlPolicy === 'everyone');
  for (let index = 0; index < 11; index += 1) {
    const localName = `Capacity ${index}.mp4`;
    const state = await playlistCapacityHost.emitWithAck('playlist_add', {
      roomCode: playlistCapacityRoomCode,
      item: {
        title: localName,
        sourceType: 'local',
        localFile: {
          name: localName,
          size: 1_000 + index,
          type: 'video/mp4',
          lastModified: 1_720_000_000_000 + index,
        },
      },
    });
    assert.equal(state.playlist.length, index + 1);
  }
  const [capacityHostAck, capacityGuestAck] = await Promise.all([
    playlistCapacityHost.emitWithAck('playlist_add', {
      roomCode: playlistCapacityRoomCode,
      item: {
        title: 'Concurrent Host Candidate',
        pageUrl: 'https://93.184.216.34/capacity-host',
        sourceUrl: 'https://93.184.216.34/capacity-host.mp4',
        sourceType: 'video',
      },
    }),
    playlistCapacityGuest.emitWithAck('playlist_add', {
      roomCode: playlistCapacityRoomCode,
      item: {
        title: 'Concurrent Guest Candidate',
        pageUrl: 'https://93.184.216.34/capacity-guest',
        sourceUrl: 'https://93.184.216.34/capacity-guest.mp4',
        sourceType: 'video',
      },
    }),
  ]);
  for (const state of [capacityHostAck, capacityGuestAck]) {
    assert.equal(state.playlist.length, 12, 'concurrent async additions must not exceed the authoritative capacity');
    assert.equal(
      state.playlist.filter((item) => item.title.startsWith('Concurrent ')).length,
      1,
      'only one request may claim the final playlist slot',
    );
  }

  await guest.emit('room_lock_update', { roomCode, locked: true, adminToken: '' });
  await guest.waitForEvent('room_error', (payload) => /房间管理员/.test(payload.message || ''));

  await host.emit('chat_message', { roomCode, text: hostChatText, senderName: 'Spoofed Host' });
  const hostChatEvent = await guest.waitForEvent('chat_message_created', (message) => message.text === hostChatText && message.senderId === 'host-a');
  assert.equal(hostChatEvent.data.senderName, 'Alice', 'chat sender name should come from joined member state');
  assert.equal(hostChatEvent.data.kind, 'user');
  await guest.waitForEvent('danmaku_message_created', (message) => message.text === hostChatText && message.senderId === 'host-a');

  await guest.emit('chat_message', { roomCode, text: chatText, senderName: 'Spoofed Guest' });
  const guestChatEvent = await host.waitForEvent('chat_message_created', (message) => message.text === chatText && message.senderId === 'guest-b');
  assert.equal(guestChatEvent.data.senderName, 'Bob Mobile', 'renamed member should own subsequent chat messages');
  await host.waitForEvent('danmaku_message_created', (message) => message.text === chatText && message.senderId === 'guest-b');
  await host.waitForEvent('room_state', (state) => state.roomCode === roomCode
    && state.chat?.some((message) => message.text === hostChatText)
    && state.chat?.some((message) => message.text === chatText));

  await host.emit('danmaku_message', { roomCode, text: hostDanmakuText });
  const hostDanmakuChatEvent = await guest.waitForEvent('chat_message_created', (message) => message.text === hostDanmakuText && message.senderId === 'host-a');
  assert.equal(hostDanmakuChatEvent.data.kind, 'user', 'danmaku should be persisted in the shared chat stream');
  const hostDanmakuEvent = await guest.waitForEvent('danmaku_message_created', (message) => message.text === hostDanmakuText && message.senderId === 'host-a');
  assert.ok(hostDanmakuEvent.data.id, 'host danmaku should have an id');
  assert.equal(hostDanmakuEvent.data.roomCode, roomCode, 'host danmaku should stay in the joined room');

  await guest.emit('danmaku_message', { roomCode, text: guestDanmakuText });
  await host.waitForEvent('chat_message_created', (message) => message.text === guestDanmakuText && message.senderId === 'guest-b');
  const guestDanmakuEvent = await host.waitForEvent('danmaku_message_created', (message) => message.text === guestDanmakuText && message.senderId === 'guest-b');
  assert.ok(guestDanmakuEvent.data.id, 'guest danmaku should have an id');
  await host.waitForEvent('room_state', (state) => state.roomCode === roomCode
    && state.chat?.some((message) => message.text === hostDanmakuText)
    && state.chat?.some((message) => message.text === guestDanmakuText));

  await guest.emit('danmaku_message', { roomCode: `${roomCode}-OTHER`, text: 'cross room danmaku' });
  await guest.waitForEvent('room_error', (payload) => /请先加入当前房间/.test(payload.message || ''));

  await host.emit('room_password_update', {
    roomCode,
    password: 'socket  reconnect password',
    adminToken: recoveredTokenEvent.data.adminToken,
  });
  await guest.waitForEvent('room_state', (state) => state.roomCode === roomCode && state.security?.hasPassword === true);
  await blockedGuest.emit('join_room', { roomCode, memberId: 'blocked-no-password', name: 'Blocked' });
  const passwordGateEvent = await blockedGuest.waitForEvent('room_error', (payload) => payload.code === 'password_required');
  assert.equal(passwordGateEvent.data.state, undefined, 'password rejection must not expose room state');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    blockedGuest.events = [];
    await blockedGuest.emit('join_room', {
      roomCode,
      memberId: `blocked-password-${attempt}`,
      name: 'Blocked Password',
      password: 'socket reconnect password',
    });
    await blockedGuest.waitForEvent('room_error', (payload) => payload.code === 'password_invalid');
  }
  blockedGuest.events = [];
  await blockedGuest.emit('join_room', {
    roomCode,
    memberId: 'blocked-password-limited',
    name: 'Blocked Password',
    password: 'still-wrong',
  });
  await blockedGuest.waitForEvent('room_error', (payload) => payload.code === 'password_rate_limited');
  independentPasswordGuest.events = [];
  await independentPasswordGuest.emit('join_room', {
    roomCode,
    memberId: 'independent-password-attempt',
    name: 'Independent Password Attempt',
    password: 'still-wrong',
  });
  await independentPasswordGuest.waitForEvent('room_error', (payload) => payload.code === 'password_invalid');
  await host.emit('room_lock_update', { roomCode, locked: true, adminToken: recoveredTokenEvent.data.adminToken });
  await guest.waitForEvent('room_state', (state) => state.roomCode === roomCode && state.security?.locked === true);
  await blockedGuest.emit('join_room', { roomCode, memberId: 'blocked-locked', name: 'Blocked Locked' });
  const lockedGateEvent = await blockedGuest.waitForEvent('room_error', (payload) => payload.code === 'locked');
  assert.equal(lockedGateEvent.data.state, undefined, 'locked-room rejection must not expose room state');

  await host.close();
  await guest.waitForEvent('room_state', (state) => state.roomCode === roomCode
    && state.hostMemberId === 'host-a'
    && !state.members?.some((member) => member.id === 'host-a'));
  reconnectedHost.events = [];
  await reconnectedHost.emit('join_room', {
    roomCode,
    memberId: 'host-a',
    name: 'Alice',
    reconnectToken: hostMemberTokenEvent.data.reconnectToken,
  });
  const rotatedHostMemberTokenEvent = await reconnectedHost.waitForEvent('room_member_token', (payload) => payload.roomCode === roomCode && payload.memberId === 'host-a' && payload.reconnectToken);
  assert.notEqual(rotatedHostMemberTokenEvent.data.reconnectToken, hostMemberTokenEvent.data.reconnectToken, 'legal host reconnect should rotate its token');
  await reconnectedHost.waitForEvent('room_state', (state) => state.roomCode === roomCode
    && state.security?.locked === true
    && state.security?.hasPassword === true
    && state.members?.some((member) => member.id === 'host-a' && member.role === 'host'));

  await guest.close();
  await reconnectedHost.waitForEvent('room_state', (state) => state.roomCode === roomCode
    && !state.members?.some((member) => member.id === 'guest-b'));
  await overflowGuest.emit('join_room', { roomCode, memberId: 'guest-b', name: 'Impersonated Guest' });
  await overflowGuest.waitForEvent('room_error', (payload) => payload.code === 'reconnect_token_invalid');
  await reconnectedGuest.connect();
  await reconnectedGuest.emit('join_room', {
    roomCode,
    memberId: 'guest-b',
    name: 'Bob Mobile',
    reconnectToken: guestMemberTokenEvent.data.reconnectToken,
  });
  const rotatedGuestMemberTokenEvent = await reconnectedGuest.waitForEvent('room_member_token', (payload) => payload.roomCode === roomCode && payload.memberId === 'guest-b' && payload.reconnectToken);
  assert.notEqual(rotatedGuestMemberTokenEvent.data.reconnectToken, guestMemberTokenEvent.data.reconnectToken, 'legal guest reconnect should rotate its token');
  await reconnectedGuest.waitForEvent('room_state', (state) => state.roomCode === roomCode
    && state.security?.locked === true
    && state.members?.some((member) => member.id === 'guest-b'));

  reconnectedHost.events = [];
  await reconnectedGuest.close();
  await reconnectedHost.waitForEvent('room_state', (state) => state.roomCode === roomCode
    && !state.members?.some((member) => member.id === 'guest-b'));
  overflowGuest.events = [];
  await overflowGuest.emit('join_room', {
    roomCode,
    memberId: 'guest-b',
    name: 'Old Token Replay',
    reconnectToken: guestMemberTokenEvent.data.reconnectToken,
  });
  await overflowGuest.waitForEvent('room_error', (payload) => payload.code === 'reconnect_token_invalid');
  overflowGuest.events = [];
  await overflowGuest.emit('join_room', {
    roomCode,
    memberId: 'guest-b',
    name: 'Bob Mobile',
    reconnectToken: rotatedGuestMemberTokenEvent.data.reconnectToken,
  });
  const twiceRotatedGuestToken = await overflowGuest.waitForEvent('room_member_token', (payload) => payload.roomCode === roomCode && payload.memberId === 'guest-b' && payload.reconnectToken);
  assert.notEqual(twiceRotatedGuestToken.data.reconnectToken, rotatedGuestMemberTokenEvent.data.reconnectToken, 'each disconnected reconnect should rotate the token again');
  await overflowGuest.waitForEvent('room_state', (state) => state.roomCode === roomCode
    && state.members?.length === 2
    && state.members.every((member) => !Object.hasOwn(member, 'socketId')));

  const capacityRoomCode = `${roomCode}-CAPACITY`;
  const capacityRoom = await fetchJson(`${baseUrl}/api/rooms/${encodeURIComponent(capacityRoomCode)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      roomName: 'Socket Capacity Reservation',
      adminToken: 'C'.repeat(32),
      recoveryCode: 'CAPAC-ITYRE-CONNE-CT123',
    }),
  });
  assert.equal(capacityRoom.response.status, 201);
  await capacityCreator.connect();
  await capacityReserved.connect();
  await capacityOverflow.connect();
  await capacityReconnect.connect();
  await capacityCreator.emit('join_room', {
    roomCode: capacityRoomCode,
    memberId: 'capacity-creator',
    name: 'Capacity Creator',
    adminToken: capacityRoom.body.adminToken,
  });
  await capacityCreator.waitForEvent('room_member_token', (payload) => payload.roomCode === capacityRoomCode && payload.memberId === 'capacity-creator');
  await capacityReserved.emit('join_room', { roomCode: capacityRoomCode, memberId: 'capacity-reserved', name: 'Reserved Member' });
  const reservedTokenEvent = await capacityReserved.waitForEvent('room_member_token', (payload) => payload.roomCode === capacityRoomCode && payload.memberId === 'capacity-reserved' && payload.reconnectToken);
  await capacityCreator.waitForEvent('room_state', (state) => state.roomCode === capacityRoomCode && state.members?.length === 2);
  capacityCreator.events = [];
  await capacityReserved.close();
  await capacityCreator.waitForEvent('room_state', (state) => state.roomCode === capacityRoomCode
    && state.members?.length === 1
    && state.members[0]?.id === 'capacity-creator');
  await capacityOverflow.emit('join_room', { roomCode: capacityRoomCode, memberId: 'capacity-hoarded-second', name: 'Second Reserved Identity' });
  await capacityOverflow.waitForEvent('room_error', (payload) => payload.code === 'room_full');
  await capacityReconnect.emit('join_room', {
    roomCode: capacityRoomCode,
    memberId: 'capacity-reserved',
    name: 'Reserved Member',
    reconnectToken: reservedTokenEvent.data.reconnectToken,
  });
  const rotatedReservedTokenEvent = await capacityReconnect.waitForEvent('room_member_token', (payload) => payload.roomCode === capacityRoomCode && payload.memberId === 'capacity-reserved' && payload.reconnectToken);
  assert.notEqual(rotatedReservedTokenEvent.data.reconnectToken, reservedTokenEvent.data.reconnectToken);
  const capacityReturnedState = await capacityCreator.waitForEvent('room_state', (state) => state.roomCode === capacityRoomCode && state.members?.length === 2);
  assert.ok(capacityReturnedState.data.members.every((member) => !Object.hasOwn(member, 'socketId')));
  capacityReconnect.events = [];
  await capacityReconnect.emit('join_room', {
    roomCode: capacityRoomCode,
    memberId: 'capacity-reserved',
    name: 'Reserved Idempotent',
    reconnectToken: rotatedReservedTokenEvent.data.reconnectToken,
  });
  await capacityReconnect.waitForEvent('room_state', (state) => state.roomCode === capacityRoomCode
    && state.members?.some((member) => member.id === 'capacity-reserved' && member.name === 'Reserved Idempotent'));
  capacityOverflow.events = [];
  await capacityOverflow.emit('join_room', {
    roomCode: capacityRoomCode,
    memberId: 'capacity-reserved',
    name: 'Online Replay',
    reconnectToken: rotatedReservedTokenEvent.data.reconnectToken,
  });
  await capacityOverflow.waitForEvent('room_error', (payload) => payload.code === 'member_online_elsewhere' && /仍在线/.test(payload.message || ''));
  capacityCreator.events = [];
  await capacityReconnect.close();
  await capacityCreator.waitForEvent('room_state', (state) => state.roomCode === capacityRoomCode && state.members?.length === 1);
  capacityOverflow.events = [];
  await capacityOverflow.emit('join_room', {
    roomCode: capacityRoomCode,
    memberId: 'capacity-reserved',
    name: 'Old Reserved Token',
    reconnectToken: reservedTokenEvent.data.reconnectToken,
  });
  await capacityOverflow.waitForEvent('room_error', (payload) => payload.code === 'reconnect_token_invalid');
  capacityOverflow.events = [];
  await capacityOverflow.emit('join_room', {
    roomCode: capacityRoomCode,
    memberId: 'capacity-reserved',
    name: 'Reserved Member Restored',
    reconnectToken: rotatedReservedTokenEvent.data.reconnectToken,
  });
  await capacityOverflow.waitForEvent('room_member_token', (payload) => payload.roomCode === capacityRoomCode && payload.memberId === 'capacity-reserved' && payload.reconnectToken);
  await capacityOverflow.waitForEvent('room_state', (state) => state.roomCode === capacityRoomCode && state.members?.length === 2);

  capacityOverflow.events = [];
  await capacityCreator.close();
  const automaticFailoverState = await capacityOverflow.waitForEvent(
    'room_state',
    (state) => state.roomCode === capacityRoomCode
      && state.hostMemberId === 'capacity-reserved'
      && state.audit?.some((entry) => entry.action === 'host_failed_over'),
    8000,
  );
  assert.equal(automaticFailoverState.data.security?.controlPolicy, 'host_only');

  await authorityCreator.connect();
  await authorityCreator.emit('join_room', {
    roomCode: capacityRoomCode,
    memberId: 'capacity-creator',
    name: 'Capacity Creator',
    adminToken: capacityRoom.body.adminToken,
  });
  const reclaimedPermission = await authorityCreator.waitForEvent(
    'room_permissions',
    (payload) => payload.roomCode === capacityRoomCode && payload.memberId === 'capacity-creator',
  );
  assert.equal(reclaimedPermission.data.canManage, true, 'rejoining creator should retain room management permission');
  const reclaimedState = await capacityOverflow.waitForEvent(
    'room_state',
    (state) => state.roomCode === capacityRoomCode
      && state.hostMemberId === 'capacity-creator'
      && state.audit?.some((entry) => entry.action === 'host_reclaimed'),
  );
  assert.equal(
    reclaimedState.data.members.find((member) => member.id === 'capacity-reserved')?.role,
    'follower',
    'automatic host should return to follower after the creator reclaims playback control',
  );

  capacityOverflow.events = [];
  await capacityOverflow.emit('playlist_add', {
    roomCode: capacityRoomCode,
    item: {
      title: 'Stale Temporary Host Item',
      pageUrl: 'https://example.com/stale-temporary-host',
      sourceUrl: 'https://example.com/stale-temporary-host.mp4',
      sourceType: 'video',
    },
  });
  await capacityOverflow.waitForEvent('room_error', (payload) => /房主/.test(payload.message || ''));

  await authorityCreator.emit('playlist_add', {
    roomCode: capacityRoomCode,
    item: {
      title: 'Creator Reclaimed Item',
      pageUrl: 'https://93.184.216.34/creator-reclaimed',
      sourceUrl: 'https://93.184.216.34/creator-reclaimed.mp4',
      sourceType: 'video',
    },
  });
  await capacityOverflow.waitForEvent('room_state', (state) => state.roomCode === capacityRoomCode
    && state.playlist?.some((item) => item.title === 'Creator Reclaimed Item'));

  await capacityOverflow.emit('room_control_policy_update', {
    roomCode: capacityRoomCode,
    controlPolicy: 'everyone',
    adminToken: '',
  });
  await capacityOverflow.waitForEvent('room_error', (payload) => /房间管理员/.test(payload.message || ''));
  await authorityCreator.emit('room_control_policy_update', {
    roomCode: capacityRoomCode,
    controlPolicy: 'everyone',
    adminToken: capacityRoom.body.adminToken,
  });
  await capacityOverflow.waitForEvent('room_state', (state) => state.roomCode === capacityRoomCode
    && state.security?.controlPolicy === 'everyone');

  const adminRoomCode = `${roomCode}-ADMIN`;
  const adminRoom = await fetchJson(`${baseUrl}/api/rooms/${encodeURIComponent(adminRoomCode)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      roomName: 'Socket Admin Failover',
      adminToken: 'A'.repeat(32),
      recoveryCode: 'ADMIN-RECOV-ERY88-CODE8',
    }),
  });
  assert.equal(adminRoom.response.status, 201);
  await adminOwner.connect();
  await adminSuccessor.connect();
  await adminReclaimer.connect();
  await adminOwner.emit('join_room', {
    roomCode: adminRoomCode,
    memberId: 'admin-owner',
    name: 'Admin Owner',
    adminToken: adminRoom.body.adminToken,
  });
  await adminOwner.waitForEvent('room_permissions', (payload) => payload.roomCode === adminRoomCode && payload.canManage === true && payload.isCreator === true);
  await adminSuccessor.emit('join_room', { roomCode: adminRoomCode, memberId: 'admin-successor', name: 'Admin Successor' });
  await adminSuccessor.waitForEvent('room_permissions', (payload) => payload.roomCode === adminRoomCode && payload.canManage === false);
  await adminOwner.close();
  await adminSuccessor.waitForEvent(
    'room_state',
    (state) => state.roomCode === adminRoomCode && state.hostMemberId === 'admin-successor' && state.audit?.some((entry) => entry.action === 'host_failed_over'),
    5000,
  );
  const delegatedAdminEvent = await adminSuccessor.waitForEvent(
    'room_admin_token',
    (payload) => payload.roomCode === adminRoomCode && payload.delegated === true && payload.adminToken,
    7000,
  );
  assert.equal(delegatedAdminEvent.data.recoveryCode, undefined, 'the automatic manager must never receive the creator recovery code');
  const delegatedPermission = await adminSuccessor.waitForEvent(
    'room_permissions',
    (payload) => payload.roomCode === adminRoomCode && payload.canManage === true,
    3000,
  );
  assert.equal(delegatedPermission.data.isCreator, false, 'the successor should manage without becoming the recovery-code owner');
  await adminSuccessor.emit('room_lock_update', {
    roomCode: adminRoomCode,
    locked: true,
    adminToken: delegatedAdminEvent.data.adminToken,
  });
  await adminSuccessor.waitForEvent('room_state', (state) => state.roomCode === adminRoomCode && state.security?.locked === true);

  adminSuccessor.events = [];
  await adminReclaimer.emit('recover_admin_token', {
    roomCode: adminRoomCode,
    recoveryCode: adminRoom.body.recoveryCode,
    memberId: 'admin-owner-returned',
    name: 'Admin Owner Returned',
  });
  const reclaimedAdminEvent = await adminReclaimer.waitForEvent(
    'room_admin_token',
    (payload) => payload.roomCode === adminRoomCode && payload.recovered === true && payload.adminToken && payload.recoveryCode,
  );
  await adminSuccessor.waitForEvent('room_permissions', (payload) => payload.roomCode === adminRoomCode && payload.canManage === false);
  await adminReclaimer.emit('join_room', {
    roomCode: adminRoomCode,
    memberId: 'admin-owner-returned',
    name: 'Admin Owner Returned',
    adminToken: reclaimedAdminEvent.data.adminToken,
  });
  await adminReclaimer.waitForEvent('room_permissions', (payload) => payload.roomCode === adminRoomCode && payload.canManage === true && payload.isCreator === true);
  await adminReclaimer.waitForEvent('room_state', (state) => state.roomCode === adminRoomCode
    && state.hostMemberId === 'admin-owner-returned'
    && state.audit?.some((entry) => entry.action === 'admin_reclaimed'));
  await adminSuccessor.emit('room_lock_update', {
    roomCode: adminRoomCode,
    locked: false,
    adminToken: delegatedAdminEvent.data.adminToken,
  });
  await adminSuccessor.waitForEvent('room_error', (payload) => /房间管理员/.test(payload.message || ''));
  await adminReclaimer.emit('room_lock_update', {
    roomCode: adminRoomCode,
    locked: false,
    adminToken: reclaimedAdminEvent.data.adminToken,
  });
  await adminReclaimer.waitForEvent('room_state', (state) => state.roomCode === adminRoomCode && state.security?.locked === false);

  adminReclaimer.events = [];
  for (let attempt = 0; attempt < 31; attempt += 1) {
    await adminReclaimer.emit('playback_update', {
      roomCode: adminRoomCode,
      action: 'periodic',
      baseRevision: -1,
      patch: { currentTime: attempt },
      client: { ready: true, seeking: false },
    });
  }
  await adminReclaimer.waitForEvent('room_error', (payload) => /播放操作太频繁/.test(payload.message || ''));

  adminReclaimer.events = [];
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await adminReclaimer.emit('playlist_rename', {
      roomCode: adminRoomCode,
      itemId: `missing-rate-item-${attempt}`,
      title: `Rate ${attempt}`,
    });
  }
  await adminReclaimer.waitForEvent('room_error', (payload) => /播放列表操作太频繁/.test(payload.message || ''));

  blockedGuest.events = [];
  await blockedGuest.emit('join_room', {
    roomCode: proxyScopeRoomCode,
    memberId: 'kick-device-original',
    clientId: 'persistent-anonymous-device',
    name: 'Kick Device',
  });
  await proxyScopeMember.waitForEvent('room_state', (state) => state.roomCode === proxyScopeRoomCode
    && state.members?.some((member) => member.id === 'kick-device-original'));
  const kickLifecycleUrl = verifiedHlsUrl;
  await proxyScopeMember.emit('playlist_add', {
    roomCode: proxyScopeRoomCode,
    item: {
      title: 'Kick Lifecycle HLS',
      pageUrl: kickLifecycleUrl,
      sourceUrl: kickLifecycleUrl,
      sourceType: 'hls',
    },
  });
  await blockedGuest.waitForEvent('room_state', (state) => state.roomCode === proxyScopeRoomCode
    && state.playlist?.some((item) => item.sourceUrl === kickLifecycleUrl));
  await blockedGuest.emit('proxy_token_request', {
    requestId: 'proxy-kick-lifecycle',
    roomCode: proxyScopeRoomCode,
    routeName: 'hls',
    url: kickLifecycleUrl,
  });
  const kickLifecycleGrant = await blockedGuest.waitForEvent('proxy_token_created', (payload) => payload.requestId === 'proxy-kick-lifecycle');
  assert.equal(kickLifecycleGrant.data.success, true);
  await proxyScopeMember.emit('kick_member', {
    roomCode: proxyScopeRoomCode,
    memberId: 'kick-device-original',
    adminToken: proxyScopeRoom.body.adminToken,
  });
  await blockedGuest.waitForEvent('room_kicked', (payload) => /请出/.test(payload.message || ''));
  const revokedKickGrantResponse = await fetch(`${baseUrl}${kickLifecycleGrant.data.proxyUrl}`);
  assert.equal(revokedKickGrantResponse.status, 401, 'kicking a member must immediately revoke that member media grants');
  await blockedGuest.connect();
  blockedGuest.events = [];
  await blockedGuest.emit('join_room', {
    roomCode: proxyScopeRoomCode,
    memberId: 'kick-device-rotated',
    clientId: 'persistent-anonymous-device',
    name: 'Rotated Identity',
  });
  await blockedGuest.waitForEvent('room_error', (payload) => payload.code === 'kicked');

  const missingRateRoomCode = `${roomCode}-JOIN-RATE`;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    blockedGuest.events = [];
    await blockedGuest.emit('join_room', {
      roomCode: missingRateRoomCode,
      memberId: `join-rate-${attempt}`,
      clientId: 'join-rate-device',
      name: 'Join Rate',
    });
    await blockedGuest.waitForEvent('room_error', (payload) => payload.code === 'room_not_found');
  }
  blockedGuest.events = [];
  await blockedGuest.emit('join_room', {
    roomCode: missingRateRoomCode,
    memberId: 'join-rate-limited',
    clientId: 'join-rate-device',
    name: 'Join Rate',
  });
  await blockedGuest.waitForEvent('room_error', (payload) => payload.code === 'join_rate_limited');

  for (let attempt = 0; attempt < 120; attempt += 1) {
    globalJoinRateGuest.events = [];
    await globalJoinRateGuest.emit('join_room', {
      roomCode: `GLOBAL-RATE-${attempt}-${Date.now().toString(36)}`,
      memberId: `global-join-rate-${attempt}`,
      clientId: 'global-join-rate-device',
      name: 'Global Join Rate',
    });
    await globalJoinRateGuest.waitForEvent('room_error', (payload) => payload.code === 'room_not_found');
  }
  globalJoinRateGuest.events = [];
  await globalJoinRateGuest.emit('join_room', {
    roomCode: `GLOBAL-RATE-LIMITED-${Date.now().toString(36)}`,
    memberId: 'global-join-rate-limited',
    clientId: 'global-join-rate-device',
    name: 'Global Join Rate',
  });
  await globalJoinRateGuest.waitForEvent('room_error', (payload) => payload.code === 'join_rate_limited');

  await sleep(100);
  const structuredRecords = output.split(/\r?\n/).flatMap((line) => {
    const start = line.indexOf('{');
    if (start < 0) return [];
    try {
      const parsed = JSON.parse(line.slice(start));
      return parsed && typeof parsed.event === 'string' ? [parsed] : [];
    } catch {
      return [];
    }
  });
  const findDecision = (event, predicate) => structuredRecords.find((record) => record.event === event && predicate(record));
  assert.ok(findDecision('playback_decision', (record) => record.action === 'source' && record.decision === 'accepted'));
  assert.ok(findDecision('playback_decision', (record) => record.action === 'buffering' && record.decision === 'accepted'));
  assert.ok(findDecision('playback_decision', (record) => record.reason === 'source_mismatch' && record.decision === 'rejected'));
  assert.ok(findDecision('playback_decision', (record) => record.reason === 'room_buffering' && record.decision === 'rejected'));
  assert.ok(findDecision('playlist_decision', (record) => record.action === 'add' && record.decision === 'accepted'));
  assert.ok(findDecision('playlist_decision', (record) => record.reason === 'not_controller' && record.decision === 'rejected'));
  assert.ok(findDecision('proxy_grant_decision', (record) => record.reason === 'granted' && record.playlistMatched === true));
  assert.ok(findDecision('proxy_grant_decision', (record) => record.reason === 'parse_source_denied' && record.playlistMatched === false));
  const approvedDecisionFields = {
    playback_decision: new Set(['event', 'roomFingerprint', 'actorFingerprint', 'clientType', 'action', 'decision', 'reason', 'baseRevision', 'currentRevision', 'nextRevision', 'sourceMatch', 'clientReady', 'clientSeeking', 'leaseOwnerChanged', 'previousSourceFingerprint', 'nextSourceFingerprint', 'deltaBucket', 'suppressedCount']),
    playlist_decision: new Set(['event', 'roomFingerprint', 'actorFingerprint', 'clientType', 'action', 'decision', 'reason', 'sourceFingerprint', 'sourceType', 'countBefore', 'countAfter', 'activeSourceChanged', 'suppressedCount']),
    proxy_grant_decision: new Set(['event', 'roomFingerprint', 'actorFingerprint', 'sourceFingerprint', 'clientType', 'routeName', 'decision', 'reason', 'playlistMatched', 'grantMode', 'revalidationAttempted', 'suppressedCount']),
  };
  for (const record of structuredRecords.filter((entry) => approvedDecisionFields[entry.event])) {
    for (const key of Object.keys(record)) {
      assert.equal(approvedDecisionFields[record.event].has(key), true, `${record.event} exposed unexpected field ${key}`);
    }
  }
  for (const secret of [roomCode, roomCreationCredentials.adminToken, roomCreationCredentials.recoveryCode, verifiedVideoUrl, verifiedHlsUrl, 'host-a', 'guest-b', 'persistent-anonymous-device']) {
    assert.equal(output.includes(secret), false, 'decision diagnostics must not expose room, member, URL, credential, or client identity data');
  }

  await overflowGuest.close();
  await blockedGuest.close();
  await independentPasswordGuest.close();
  await reconnectedHost.close();
  await reconnectedGuest.close();
  await capacityCreator.close();
  await capacityReserved.close();
  await capacityOverflow.close();
  await capacityReconnect.close();
  await authorityCreator.close();
  await adminOwner.close();
  await adminSuccessor.close();
  await adminReclaimer.close();
  await proxyScopeMember.close();
  await playlistCapacityHost.close();
  await playlistCapacityGuest.close();
  await globalJoinRateGuest.close();
  console.log(`socket smoke verification passed: ${roomCode}`);
} catch (error) {
  console.error(output);
  throw error;
} finally {
  await host.close();
  await guest.close();
  await overflowGuest.close();
  await blockedGuest.close();
  await independentPasswordGuest.close();
  await reconnectedHost.close();
  await reconnectedGuest.close();
  await capacityCreator.close();
  await capacityReserved.close();
  await capacityOverflow.close();
  await capacityReconnect.close();
  await authorityCreator.close();
  await adminOwner.close();
  await adminSuccessor.close();
  await adminReclaimer.close();
  await proxyScopeMember.close();
  await playlistCapacityHost.close();
  await playlistCapacityGuest.close();
  await globalJoinRateGuest.close();
  if (childExitCode === null) child.kill('SIGTERM');
}
