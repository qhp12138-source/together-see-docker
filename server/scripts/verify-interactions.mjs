import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import express from 'express';

// Run after the main build: node scripts/verify-interactions.mjs.
// All catalog mutations are isolated in a temporary directory, never repo assets.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'together-see-interactions-'));
const assets = path.join(temporary, 'assets');
fs.mkdirSync(assets);
process.env.NODE_ENV = 'test';
process.env.ROOM_STORE_ENABLED = 'false';
process.env.ROOM_MAX_ACTIVE = '50';
process.env.ROOM_MAX_MEMBERS = '100';
process.env.INTERACTION_ASSET_DIR = assets;
const clients = [];
const deliveryCleanups = [];
let deliveryProbe;
let io;
let server;
let catalogTick = Date.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const empty = { version: 1, items: [] };
const image = { id: 'spark', label: 'Spark', type: 'image', src: 'spark.png', durationMs: 1800 };
const video = { id: 'clip', label: 'Clip', type: 'video', src: 'clip.webm', poster: 'spark.png',
  audio: 'sound.ogg', durationMs: 3000, width: 320, height: 180 };
const sprite = { id: 'sprite', label: 'Sprite', type: 'sprite', src: 'spark.png',
  durationMs: 2400, width: 64, height: 64, columns: 4, frames: 8 };
const builtin = { id: 'heart', label: 'Heart', type: 'builtin', effect: 'heart', durationMs: 2400 };
function writeCatalog(value) {
  const filename = path.join(assets, 'catalog.json');
  fs.writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify(value));
  const time = new Date(catalogTick += 10);
  fs.utimesSync(filename, time, time);
}

// Real Engine.IO/Socket.IO over Node's WebSocket, without a new client dependency.
class Client {
  constructor(baseURL) {
    this.events = [];
    this.acks = new Map();
    this.sequence = 0;
    this.ws = new WebSocket(baseURL.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket');
    this.ws.addEventListener('error', () => { this.failed = true; });
    this.ws.addEventListener('message', ({ data }) => {
      const packet = String(data);
      if (packet.startsWith('0')) this.ws.send('40');
      else if (packet === '2') this.ws.send('3');
      else if (packet.startsWith('40')) this.id = JSON.parse(packet.slice(2)).sid;
      else if (packet.startsWith('42')) {
        const [name, value] = JSON.parse(packet.slice(2));
        this.events.push({ name, value });
      } else if (packet.startsWith('43')) {
        const match = /^43(\d+)(.*)$/.exec(packet);
        this.acks.set(Number(match[1]), JSON.parse(match[2])[0]);
      }
    });
    clients.push(this);
  }
  async until(predicate) {
    const until = Date.now() + 4000;
    while (!predicate()) {
      assert.ok(!this.failed && Date.now() < until, 'Socket response deadline exceeded');
      await sleep(5);
    }
  }
  async connect() { await this.until(() => Boolean(this.id)); return this; }
  async send(name, value) {
    const id = ++this.sequence;
    this.ws.send(`42${id}${JSON.stringify([name, value])}`);
    await this.until(() => this.acks.has(id));
    const result = this.acks.get(id);
    this.acks.delete(id);
    return result;
  }
  async flush() { await this.send('ping_latency', {}); }
}

try {
  // File bytes are metadata-validation fixtures, not media decoding tests.
  for (const name of ['spark.png', 'clip.webm', 'sound.ogg']) fs.writeFileSync(path.join(assets, name), 'fixture');
  const { InteractionCatalogService, interactionCatalog } = await import('../dist/services/interaction.service.js');
  const { createApp } = await import('../dist/app.js');
  const { attachSocketServer } = await import('../dist/sockets/index.js');
  const { InteractionDeliveryService } = await import('../dist/services/interaction-delivery.service.js');
  const { roomService } = await import('../dist/services/room.service.js');
  // Read the shipped snapshot without mutating it; malformed/missing media fails closed.
  const publicAssets = fileURLToPath(new URL('../../assets/interactions/', import.meta.url));
  const publicCatalog = new InteractionCatalogService(publicAssets).getCatalog();
  const publicBuiltins = ['heart', 'fireworks', 'sakura', 'birthday'];
  assert.deepEqual(publicCatalog.items.map(item => item.id).sort(), [...publicBuiltins, 'question'].sort(),
    'public snapshot contains exactly four builtins and the question sprite');
  for (const id of publicBuiltins) {
    const item = publicCatalog.items.find(item => item.id === id);
    assert.equal(item.type, 'builtin');
    assert.equal(item.effect, id);
    assert.equal(item.group, 'builtin');
    for (const key of ['src', 'poster', 'audio']) assert.equal(item[key], undefined);
  }
  const question = publicCatalog.items.find(item => item.id === 'question');
  assert.equal(question.type, 'sprite');
  assert.equal(question.group, 'other');
  for (const [key, filename] of Object.entries({ src: 'spritesheet.png', poster: 'poster.png', audio: 'audio.wav' })) {
    assert.equal(question[key], `/assets/interactions/question/${filename}`);
    assert.ok(fs.statSync(path.join(publicAssets, 'question', filename)).isFile());
  }
  const catalog = new InteractionCatalogService(assets);
  assert.deepEqual(catalog.getCatalog(), empty, 'missing catalog fails closed');
  for (const effect of ['heart', 'fireworks', 'sakura', 'birthday']) {
    writeCatalog({ version: 1, items: [{ ...builtin, effect, group: 'forged', visualBytes: 999999 }] });
    const item = catalog.getCatalog().items[0];
    assert.equal(item.effect, effect);
    assert.equal(item.group, 'builtin', 'group is derived from validated type');
    assert.equal(item.visualBytes, 0, 'procedural effects never advertise external resource bytes');
    assert.equal(item.src, undefined);
    assert.match(item.revision, /^[a-f0-9]{16}$/);
  }
  for (const patch of [{ effect: 'script' }, { effect: null }, { effect: {} },
    { src: 'spark.png' }, { src: 'https://evil.test/a.js' }, { poster: 'spark.png' },
    { audio: 'sound.ogg' }, { width: 100 }, { columns: 1 }, { durationMs: 3001 }]) {
    writeCatalog({ version: 1, items: [{ ...builtin, ...patch }] });
    assert.deepEqual(catalog.getCatalog(), empty, 'builtins accept only known effects without media or drawing code');
  }
  for (const [asset, key, filename, limit] of [
    [image, 'src', 'spark.png', 8 * 1024 * 1024],
    [sprite, 'src', 'spark.png', 8 * 1024 * 1024],
    [video, 'src', 'clip.webm', 8 * 1024 * 1024],
    [video, 'poster', 'spark.png', 8 * 1024 * 1024],
    [video, 'audio', 'sound.ogg', 1024 * 1024],
  ]) {
    const filenamePath = path.join(assets, filename);
    fs.truncateSync(filenamePath, limit);
    writeCatalog({ version: 1, items: [asset] });
    assert.equal(catalog.getCatalog().items.length, 1, `${asset.type}.${key}: exact byte budget accepted`);
    fs.truncateSync(filenamePath, limit + 1);
    assert.deepEqual(catalog.getCatalog(Date.now() + 1100), empty,
      `${asset.type}.${key}: resource-only growth beyond budget fails closed after revalidation`);
    fs.writeFileSync(filenamePath, 'fixture');
    writeCatalog({ version: 1, items: [asset] });
    assert.equal(catalog.getCatalog().items.length, 1, 'valid replacement restores the catalog');
  }
  writeCatalog({ version: 1, items: [image, video, sprite] });
  const validated = catalog.getCatalog();
  assert.equal(validated.items.length, 3);
  assert.equal(validated.items[0].src, '/assets/interactions/spark.png');
  assert.equal(validated.items[0].group, 'other', 'old media catalogs retain the other group by default');
  assert.equal(validated.items[1].audio, '/assets/interactions/sound.ogg');
  assert.equal(Object.isFrozen(validated.items[0]), true);
  assert.equal(catalog.getCatalog(), validated, 'unchanged catalog reuses the validated object');
  for (const item of validated.items) assert.match(item.revision, /^[a-f0-9]{16}$/);
  assert.throws(() => { validated.items[0].revision = 'forged'; }, TypeError);

  writeCatalog({ version: 1, privatePath: temporary, items: [{
    durationMs: image.durationMs, src: '/assets/interactions/spark.png', type: image.type,
    label: '  Spark  ', id: image.id, revision: 'ffffffffffffffff', privatePath: temporary,
  }] });
  assert.deepEqual(catalog.getCatalog().items, [validated.items[0]],
    'canonical fields and resource stats, not JSON key order/private fields/supplied revision, determine revision');
  for (const patch of [{ label: 'Updated' }, { durationMs: 1600 }, { width: 100 }, { audio: 'sound.ogg' }]) {
    writeCatalog({ version: 1, items: [{ ...image, ...patch }] });
    const changed = catalog.getCatalog().items[0];
    assert.equal(changed.id, image.id);
    assert.notEqual(changed.revision, validated.items[0].revision, 'same-ID public metadata changes revise the asset');
  }
  writeCatalog({ version: 1, items: [video] });
  let checkedAt = Date.now();
  let lastRevision = catalog.getCatalog(checkedAt).items[0].revision;
  for (const filename of ['clip.webm', 'spark.png', 'sound.ogg']) {
    fs.appendFileSync(path.join(assets, filename), '-updated');
    const time = new Date(catalogTick += 10);
    fs.utimesSync(path.join(assets, filename), time, time);
    assert.equal(catalog.getCatalog(checkedAt + 999).items[0].revision, lastRevision,
      'resource-only edits preserve the one-second metadata cache');
    checkedAt += 1000;
    const nextRevision = catalog.getCatalog(checkedAt).items[0].revision;
    assert.notEqual(nextRevision, lastRevision, `${filename}: src/poster/audio edits change the same-ID revision`);
    lastRevision = nextRevision;
  }
  const touched = path.join(assets, 'clip.webm');
  const time = new Date(catalogTick += 1000);
  fs.utimesSync(touched, time, time);
  checkedAt += 1000;
  const touchedRevision = catalog.getCatalog(checkedAt).items[0].revision;
  assert.notEqual(touchedRevision, lastRevision, 'timestamp-only changes also invalidate revision');
  assert.equal(catalog.getCatalog(checkedAt + 1000).items[0].revision, touchedRevision,
    'unchanged resource metadata remains stable after revalidation');

  for (const src of ['../spark.png', '/etc/spark.png', '//evil.test/a.png', 'https://evil.test/a.png',
    'data:image/png;base64,AA', 'file:///a.png', 'C:\\a.png', 'a\\spark.png', 'a/../spark.png',
    '%2e%2e/spark.png', 'a%2fspark.png', '/assets/interactions/../spark.png',
    'spark.png?token=secret', 'spark.png#fragment', '.hidden.png', 'a//spark.png', 'spark.svg',
    'CON.png', 'file:stream.png', 'missing.png']) {
    writeCatalog({ version: 1, items: [{ ...image, src }] });
    assert.deepEqual(catalog.getCatalog(), empty, `unsafe path rejected: ${src}`);
  }
  for (const patch of [
    { id: '' }, { id: '../x' }, { label: '' }, { label: 'x'.repeat(65) }, { label: 'a\nb' },
    { durationMs: 0 }, { durationMs: 3001 }, { durationMs: '1000' }, { durationMs: 1.2 },
    { type: 'script' }, { type: ['image'] }, { type: 'video' }, { audio: 'spark.png' },
    { effect: 'heart' },
    { poster: '../spark.png' }, { width: 2049 }, { height: -1 }, { frames: 1 },
    { type: 'sprite', width: 64, height: 64, columns: 4, frames: 3 },
    { type: 'sprite', columns: 4, frames: 8 },
  ]) {
    writeCatalog({ version: 1, items: [{ ...image, ...patch }] });
    assert.deepEqual(catalog.getCatalog(), empty, `invalid metadata rejected: ${JSON.stringify(patch)}`);
  }
  for (const value of ['{broken', ' '.repeat(65537), { version: 2, items: [] },
    { version: 1, items: [image, image] }, { version: 1, items: [image, { ...video, src: '../bad.webm' }] },
    { version: 1, items: Array.from({ length: 65 }, (_, index) => ({ ...image, id: `x${index}` })) }]) {
    writeCatalog(value);
    assert.deepEqual(catalog.getCatalog(), empty, 'invalid catalogs are not partially published');
  }
  const outside = path.join(temporary, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'external.png'), 'fixture');
  fs.symlinkSync(outside, path.join(assets, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  writeCatalog({ version: 1, items: [{ ...image, src: 'escape/external.png' }] });
  assert.deepEqual(catalog.getCatalog(), empty, 'symlink/junction escape rejected');
  writeCatalog({ version: 1, items: [image] });
  const publicImage = catalog.getCatalog().items[0];
  writeCatalog({ version: 1, items: [{ ...image, src: '/assets/interactions/spark.png', privatePath: temporary }] });
  assert.deepEqual(catalog.getCatalog().items, [publicImage], 'private fields are neither returned nor hashed');
  fs.unlinkSync(path.join(assets, 'spark.png'));
  assert.deepEqual(catalog.getCatalog(Date.now() + 1100), empty, 'deleted file invalidates unchanged catalog within one second');
  fs.writeFileSync(path.join(assets, 'spark.png'), 'fixture');
  writeCatalog({ version: 1, items: [image, video, sprite] });

  const app = createApp();
  app.use('/assets/interactions', express.static(assets, { index: false }));
  server = createServer(app);
  io = attachSocketServer(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  async function getCatalog() {
    const response = await fetch(baseURL + '/api/interactions', { signal: AbortSignal.timeout(4000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(JSON.stringify(body).includes(temporary), false, 'no absolute file paths exposed');
    assert.deepEqual(body, interactionCatalog.getCatalog(), 'HTTP uses the same validated catalog as Socket');
    return body;
  }
  const initialCatalog = await getCatalog();
  assert.equal(initialCatalog.items.length, 3);
  for (const pathname of [
    '/assets/interactions/catalog.json', '/assets/interactions/catalog.json?v=secret',
    '/ASSETS/INTERACTIONS/CATALOG.JSON', '/assets/interactions/%63atalog%2ejson',
    '/assets/interactions%2fcatalog.json', '/assets//interactions/catalog.json',
    '/assets/interactions/catalog.json/extra', '/assets/interactions/catalog.json.%20',
    '/assets/interactions.%20/catalog.json', '/assets/interactions%5ccatalog.json',
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(baseURL + pathname, { method, signal: AbortSignal.timeout(4000) });
      assert.equal(response.status, 404, `${method} ${pathname}: raw catalog must not reach static middleware`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(await response.text(), '');
    }
  }
  const mediaResponse = await fetch(baseURL + '/assets/interactions/spark.png?v=fixture');
  assert.equal(mediaResponse.status, 200, 'catalog guard leaves public media available');
  assert.equal(await mediaResponse.text(), 'fixture');
  writeCatalog({ version: 1, privatePath: temporary,
    items: [image, video, sprite].map(item => ({ ...item, privatePath: temporary, revision: 'forged' })) });
  assert.deepEqual(await getCatalog(), initialCatalog, 'HTTP does not leak unknown private fields or trust supplied revision');

  async function join(roomCode, memberId, adminToken) {
    const client = await new Client(baseURL).connect();
    const state = await client.send('join_room', { roomCode, memberId, clientId: `client-${memberId}`, adminToken });
    assert.ok(state?.members.some(member => member.id === memberId));
    client.roomCode = roomCode;
    client.memberId = memberId;
    return client;
  }
  async function makeRoom(code, memberCount = 2) {
    const created = roomService.createRoom(code, code);
    assert.ok(created);
    roomService.addPlaylistItem(code, { id: `source-${code}`, title: 'Fixture', sourceType: 'video',
      pageUrl: 'https://93.184.216.34/fixture.webm', sourceUrl: 'https://93.184.216.34/fixture.webm' });
    const members = [];
    for (let index = 0; index < memberCount; index++) {
      members.push(await join(code, `${code}-member-${index}`, index === 0 ? created.credentials.adminToken : undefined));
    }
    return members;
  }
  const [host, guest] = await makeRoom('INTERACTION');
  roomService.addPlaylistItem('INTERACTION', { id: 'old-source', title: 'Non-current source', sourceType: 'video',
    pageUrl: 'https://93.184.216.34/old.webm', sourceUrl: 'https://93.184.216.34/old.webm' });
  const [other] = await makeRoom('OTHER');
  const unjoined = await new Client(baseURL).connect();
  for (const client of clients) { await client.flush(); client.events = []; }
  const stateBefore = structuredClone(roomService.getRoom('INTERACTION'));
  assert.equal(stateBefore.security.controlPolicy, 'host_only');
  const payload = { roomCode: 'INTERACTION', assetId: image.id, sourceId: 'source-INTERACTION', x: 0, y: 1 };
  async function denied(client, input) {
    const result = await client.send('interaction_send', input);
    assert.equal(result?.ok, false);
    assert.deepEqual(Object.keys(result).sort(), ['message', 'ok']);
    assert.equal(typeof result.message, 'string');
  }
  writeCatalog({ version: 1, items: [image, video, sprite, builtin] });
  const [builtinHost, builtinGuest] = await makeRoom('BUILTIN');
  for (const client of [builtinHost, builtinGuest]) { await client.flush(); client.events = []; }
  const builtinState = structuredClone(roomService.getRoom('BUILTIN'));
  const builtinPayload = { roomCode: 'BUILTIN', assetId: builtin.id, sourceId: 'source-BUILTIN', x: 0.4, y: 0.6 };
  for (let index = 0; index < 4; index++) {
    assert.deepEqual(await builtinGuest.send('interaction_send', { ...builtinPayload, effect: 'forged', group: 'forged' }), { ok: true });
  }
  await denied(builtinGuest, builtinPayload);
  await builtinHost.until(() => builtinHost.events.filter(event => event.name === 'interaction_play').length === 4);
  await builtinGuest.until(() => builtinGuest.events.filter(event => event.name === 'interaction_play').length === 4);
  const builtinEvents = builtinHost.events.filter(event => event.name === 'interaction_play').map(event => event.value);
  assert.deepEqual(builtinGuest.events.filter(event => event.name === 'interaction_play').map(event => event.value), builtinEvents,
    'builtin peers share event IDs, hence deterministic random effects');
  assert.equal(new Set(builtinEvents.map(event => event.id)).size, 4, 'repeated clicks receive independent effect seeds');
  for (const event of builtinEvents) {
    assert.equal(event.durationMs, 2400);
    assert.equal(event.assetId, 'heart');
    assert.equal(event.effect, undefined, 'clients cannot inject a drawing effect in socket payloads');
  }
  assert.deepEqual(roomService.getRoom('BUILTIN'), builtinState, 'procedural interactions do not mutate playback or room state');
  writeCatalog({ version: 1, items: [image, video, sprite] });
  await denied(unjoined, payload);
  await denied(other, payload);
  for (const patch of [
    { x: -0.01 }, { x: 1.01 }, { x: null }, { x: '0.5' }, { x: [] }, { x: NaN },
    { y: Infinity }, { y: false }, { y: -1 }, { y: 2 }, { sourceId: 'old-source' },
    { sourceId: null }, { assetId: '../spark' }, { roomCode: {} }, { roomCode: 'OTHER' },
  ]) await denied(guest, { ...payload, ...patch });
  for (const value of [null, [], 'bad', {}]) await denied(guest, value);
  const binding = io.sockets.sockets.get(guest.id);
  binding.data.memberId = host.memberId;
  await denied(guest, payload);
  binding.data.memberId = guest.memberId;
  await denied(guest, { ...payload, assetId: 'unknown' });

  const sentBefore = Date.now();
  const ack = await guest.send('interaction_send', { ...payload, id: 'forged-id', sentAt: 1,
    durationMs: 999999, assetRevision: 'forged', memberId: host.memberId, token: 'not-to-be-broadcast', src: 'https://evil.test/a.png' });
  assert.deepEqual(ack, { ok: true }, 'a follower can send even in host-only playback mode');
  for (const client of clients) await client.flush();
  const events = host.events.filter(event => event.name === 'interaction_play');
  assert.equal(events.length, 1);
  const event = events[0].value;
  assert.deepEqual(Object.keys(event).sort(), ['assetId', 'assetRevision', 'durationMs', 'id', 'sentAt', 'sourceId', 'x', 'y']);
  assert.match(event.id, /^interaction-/);
  assert.equal(event.assetId, image.id);
  assert.equal(event.assetRevision, initialCatalog.items[0].revision);
  assert.equal(event.sourceId, payload.sourceId);
  assert.equal(event.x, 0);
  assert.equal(event.y, 1);
  assert.equal(event.durationMs, image.durationMs);
  assert.ok(event.sentAt >= sentBefore && event.sentAt <= Date.now());
  assert.ok(event.sentAt + event.durationMs <= event.sentAt + 3000);
  assert.deepEqual(guest.events.filter(value => value.name === 'interaction_play').map(value => value.value), [event]);
  assert.equal(other.events.some(value => value.name === 'interaction_play'), false);
  assert.equal(unjoined.events.some(value => value.name === 'interaction_play'), false);

  writeCatalog({ version: 1, items: [{ ...image, durationMs: 1200 }, video, sprite] });
  const revised = (await getCatalog()).items[0];
  assert.notEqual(revised.revision, event.assetRevision);
  assert.deepEqual(await guest.send('interaction_send', { ...payload, assetRevision: event.assetRevision }), { ok: true });
  await host.flush();
  const updatedEvent = host.events.filter(value => value.name === 'interaction_play').at(-1).value;
  assert.equal(updatedEvent.assetId, image.id);
  assert.equal(updatedEvent.assetRevision, revised.revision, 'Socket uses the current catalog revision, not the client revision');
  assert.equal(updatedEvent.durationMs, 1200);

  writeCatalog({ version: 1, items: [video] });
  assert.deepEqual((await getCatalog()).items.map(item => item.id), [video.id]);
  await denied(host, payload);
  assert.deepEqual(await host.send('interaction_send', { ...payload, assetId: video.id, x: 0.25, y: 0.75 }), { ok: true });
  writeCatalog('{bad');
  assert.deepEqual(await getCatalog(), empty);
  await denied(host, { ...payload, assetId: video.id });
  fs.unlinkSync(path.join(assets, 'catalog.json'));
  assert.deepEqual(await getCatalog(), empty);
  await denied(host, { ...payload, assetId: video.id });
  for (const client of clients) await client.flush();
  const plays = host.events.filter(value => value.name === 'interaction_play').map(value => value.value);
  assert.equal(plays.length, 3, 'removed and malformed catalogs must not emit anything');
  assert.equal(plays[2].durationMs, 3000);
  assert.equal(plays[2].assetRevision, initialCatalog.items[1].revision);
  assert.equal(plays[2].x, 0.25);
  assert.equal(plays[2].y, 0.75);
  assert.equal(new Set(plays.map(value => value.id)).size, 3, 'event IDs are generated independently by the server');
  assert.deepEqual(roomService.getRoom('INTERACTION'), stateBefore, 'interaction success/rejection must not mutate room state');
  for (const client of clients) {
    assert.equal(client.events.some(value => ['room_state', 'playback_state', 'room_error'].includes(value.name)), false,
      'interaction ACKs must not trigger room snapshots or errors');
  }
  writeCatalog({ version: 1, items: [image, video, sprite] });
  await sleep(3100);
  const late = await join('INTERACTION', 'late-member');
  await late.flush();
  assert.equal(late.events.some(value => value.name === 'interaction_play'), false, 'expired interactions are never replayed');

  const [rateHost, rateGuest] = await makeRoom('MEMBER-RATE');
  const ratePayload = { ...payload, roomCode: 'MEMBER-RATE', sourceId: 'source-MEMBER-RATE' };
  const burstStarted = Date.now();
  for (let index = 0; index < 4; index++) assert.deepEqual(await rateGuest.send('interaction_send', ratePayload), { ok: true });
  await denied(rateGuest, ratePayload);
  assert.ok(Date.now() - burstStarted < 3000, 'member burst fits inside its real rate window');
  assert.deepEqual(await rateHost.send('interaction_send', ratePayload), { ok: true }, 'member quotas are independent');
  const token = rateGuest.events.find(value => value.name === 'room_member_token').value.reconnectToken;
  rateGuest.ws.close();
  await rateGuest.until(() => !roomService.isMemberSocket('MEMBER-RATE', rateGuest.memberId, rateGuest.id));
  const reconnected = await new Client(baseURL).connect();
  const restored = await reconnected.send('join_room', { roomCode: 'MEMBER-RATE', memberId: rateGuest.memberId,
    clientId: `client-${rateGuest.memberId}`, reconnectToken: token });
  assert.ok(restored);
  await denied(reconnected, ratePayload);
  assert.ok(Date.now() - burstStarted < 3000, 'reconnect test remains within the exhausted window');
  await sleep(3100);
  assert.deepEqual(await reconnected.send('interaction_send', ratePayload), { ok: true }, 'quota refills after expiry');

  const roomMembers = await makeRoom('ROOM-RATE', 6);
  const roomPayload = { ...payload, roomCode: 'ROOM-RATE', sourceId: 'source-ROOM-RATE' };
  const roomBurstStarted = Date.now();
  for (const member of roomMembers.slice(0, 5)) {
    for (let index = 0; index < 4; index++) assert.deepEqual(await member.send('interaction_send', roomPayload), { ok: true });
  }
  await denied(roomMembers[5], roomPayload);
  assert.ok(Date.now() - roomBurstStarted < 3000, 'room burst fits inside its real rate window');
  assert.deepEqual(await other.send('interaction_send', { ...payload, roomCode: 'OTHER', sourceId: 'source-OTHER' }), { ok: true },
    'room quotas are isolated');
  // Fault injection at a real receiver transport, not a simulated network outage.
  // Capture the actual Engine.IO write boundary to distinguish app queueing from
  // hidden transport buffering; the other receiver remains healthy throughout.
  async function holdTransport(client) {
    await client.flush();
    const binding = io.sockets.sockets.get(client.id);
    const connection = binding.conn;
    const transport = connection.transport;
    await client.until(() => transport.writable && connection.writeBuffer.length === 0);
    const writes = [];
    const originalWrite = connection.write;
    connection.write = function (data, ...args) {
      if (typeof data === 'string' && data.includes('["interaction_play",')) {
        writes.push(JSON.parse(data.slice(data.indexOf('[')))[1]);
      }
      return originalWrite.call(this, data, ...args);
    };
    transport.writable = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (connection.readyState === 'open') { transport.writable = true; transport.emit('ready'); }
    };
    deliveryCleanups.push(() => { release(); connection.write = originalWrite; });
    return { binding, writes, release };
  }
  const interactionEvents = client => client.events.filter(value => value.name === 'interaction_play').map(value => value.value);
  async function stalledInteraction(code, durationMs = 1200) {
    writeCatalog({ version: 1, items: [{ ...image, durationMs }] });
    const [receiver, sender] = await makeRoom(code);
    const held = await holdTransport(receiver);
    const input = { ...payload, roomCode: code, sourceId: `source-${code}` };
    assert.deepEqual(await sender.send('interaction_send', input), { ok: true });
    await sender.until(() => interactionEvents(sender).length === 1);
    const event = interactionEvents(sender)[0];
    assert.equal(held.writes.length, 0, 'busy receiver gets no Engine.IO interaction writes');
    return { receiver, sender, event, input, ...held };
  }
  async function assertDropped(test, expired = false) {
    test.release();
    await test.receiver.flush();
    await sleep(80);
    if (!expired) assert.ok(Date.now() < test.event.sentAt + test.event.durationMs, 'expiry must not mask invalidation');
    assert.equal(test.writes.length, 0, 'discarded interactions never enter Engine.IO');
    assert.equal(interactionEvents(test.receiver).length, 0);
  }

  const recovered = await stalledInteraction('DELIVERY-RECOVER');
  const deliveryState = structuredClone(roomService.getRoom('DELIVERY-RECOVER'));
  await sleep(100);
  assert.equal(recovered.writes.length, 0);
  recovered.release();
  await recovered.receiver.until(() => interactionEvents(recovered.receiver).length === 1);
  await sleep(80);
  assert.deepEqual(interactionEvents(recovered.receiver), [recovered.event], 'recovery delivers once with unchanged id/sentAt/duration');
  assert.deepEqual(recovered.writes, [recovered.event]);
  assert.deepEqual(roomService.getRoom('DELIVERY-RECOVER'), deliveryState, 'delivery/retry never changes room state');

  const expired = await stalledInteraction('DELIVERY-EXPIRE', 120);
  await sleep(220);
  await assertDropped(expired, true);

  const disconnected = await stalledInteraction('DELIVERY-DISCONNECT');
  const reconnectToken = disconnected.receiver.events.find(value => value.name === 'room_member_token').value.reconnectToken;
  disconnected.receiver.ws.close();
  await disconnected.sender.until(() => !io.sockets.sockets.has(disconnected.receiver.id));
  disconnected.release();
  const replacement = await new Client(baseURL).connect();
  const rejoined = await replacement.send('join_room', {
    roomCode: 'DELIVERY-DISCONNECT', memberId: disconnected.receiver.memberId,
    clientId: `client-${disconnected.receiver.memberId}`, reconnectToken,
  });
  assert.ok(rejoined?.members.some(member => member.id === disconnected.receiver.memberId));
  await replacement.flush();
  await sleep(80);
  assert.ok(Date.now() < disconnected.event.sentAt + disconnected.event.durationMs, 'disconnect/reconnect is checked before original expiry');
  assert.equal(interactionEvents(replacement).length, 0, 'an unexpired event is not replayed to a replacement socket');
  assert.equal(disconnected.writes.length, 0);
  assert.deepEqual(await disconnected.sender.send('interaction_send', disconnected.input), { ok: true });
  await replacement.until(() => interactionEvents(replacement).length === 1);
  assert.notEqual(interactionEvents(replacement)[0].id, disconnected.event.id, 'new session receives only new events');

  const switched = await stalledInteraction('DELIVERY-SOURCE');
  roomService.addPlaylistItem('DELIVERY-SOURCE', { id: 'replacement-source', title: 'Replacement', sourceType: 'video',
    pageUrl: 'https://93.184.216.34/replacement.webm', sourceUrl: 'https://93.184.216.34/replacement.webm' });
  const switchSource = sourceId => switched.receiver.send('playback_update', {
    roomCode: 'DELIVERY-SOURCE', action: 'source',
    baseRevision: roomService.getRoom('DELIVERY-SOURCE').playback.revision,
    patch: { activeSourceId: sourceId }, client: { ready: true, seeking: false },
  });
  // ACKs to the busy host may buffer normally; interaction packets must not.
  const switchedAck = switchSource('replacement-source');
  await switched.sender.until(() => roomService.getRoom('DELIVERY-SOURCE').playback.activeSourceId === 'replacement-source');
  const restoredAck = switchSource(switched.input.sourceId);
  await switched.sender.until(() => roomService.getRoom('DELIVERY-SOURCE').playback.activeSourceId === switched.input.sourceId);
  switched.release();
  await Promise.all([switchedAck, restoredAck]);
  await assertDropped(switched);

  const rapidSwitch = await stalledInteraction('DELIVERY-RAPID-SOURCE');
  roomService.addPlaylistItem('DELIVERY-RAPID-SOURCE', { id: 'rapid-replacement', title: 'Replacement', sourceType: 'video',
    pageUrl: 'https://93.184.216.34/rapid.webm', sourceUrl: 'https://93.184.216.34/rapid.webm' });
  const playbackHandler = rapidSwitch.binding.listeners('playback_update')[0];
  assert.equal(typeof playbackHandler, 'function');
  // Call the real authenticated handler on the live socket without yielding:
  // no retry timer may observe B and mask a missing immediate dropRoom hook.
  for (const sourceId of ['rapid-replacement', rapidSwitch.input.sourceId]) {
    const before = roomService.getRoom('DELIVERY-RAPID-SOURCE');
    const previousSource = before.playback.activeSourceId;
    let acknowledged = false;
    playbackHandler({ roomCode: 'DELIVERY-RAPID-SOURCE', action: 'source', baseRevision: before.playback.revision,
      patch: { activeSourceId: sourceId }, client: { ready: true, seeking: false } }, (state, decision) => {
      acknowledged = true;
      assert.equal(decision.accepted, true);
      assert.equal(state.playback.activeSourceId, sourceId);
    });
    assert.equal(acknowledged, true);
    assert.equal(before.playback.activeSourceId, previousSource, 'current playback update replaces, rather than mutates, the old playback object');
  }
  await assertDropped(rapidSwitch);

  const revisedAsset = await stalledInteraction('DELIVERY-REVISION');
  writeCatalog({ version: 1, items: [{ ...image, durationMs: 1200, label: 'Revised while busy' }] });
  assert.notEqual(interactionCatalog.getCatalog().items[0].revision, revisedAsset.event.assetRevision);
  await sleep(80);
  writeCatalog({ version: 1, items: [{ ...image, durationMs: 1200 }] });
  assert.equal(interactionCatalog.getCatalog().items[0].revision, revisedAsset.event.assetRevision);
  await assertDropped(revisedAsset);

  const changedMember = await stalledInteraction('DELIVERY-MEMBER');
  changedMember.binding.data.memberId = changedMember.sender.memberId;
  await sleep(80);
  changedMember.binding.data.memberId = changedMember.receiver.memberId;
  await assertDropped(changedMember);

  // Exercise budgets directly on the delivery service with real sockets, without
  // weakening the interaction_send member/room rate limits to fill the queue.
  deliveryProbe = new InteractionDeliveryService(io);
  const [budgetReceiver] = await makeRoom('DELIVERY-BUDGET', 1);
  const budgetHeld = await holdTransport(budgetReceiver);
  const currentAsset = interactionCatalog.getCatalog().items[0];
  const boundedEvent = id => ({ id, assetId: currentAsset.id, assetRevision: currentAsset.revision,
    sourceId: 'source-DELIVERY-BUDGET', x: 0.5, y: 0.5, sentAt: Date.now(), durationMs: 1200 });
  const burst = Array.from({ length: 12 }, (_, index) => boundedEvent(`bounded-${index}`));
  for (const event of burst) {
    deliveryProbe.broadcast('DELIVERY-BUDGET', event);
    assert.ok(deliveryProbe.pending.events <= 8);
    assert.ok(deliveryProbe.pending.bytes <= 8192);
  }
  assert.equal(deliveryProbe.pending.events, 8);
  assert.equal(deliveryProbe.pending.timerActive, true);
  assert.equal(budgetHeld.writes.length, 0);
  budgetHeld.release();
  await budgetReceiver.until(() => interactionEvents(budgetReceiver).length === 8);
  assert.deepEqual(interactionEvents(budgetReceiver), burst.slice(-8), 'overflow evicts oldest, retained events preserve order and deadlines');
  assert.deepEqual(deliveryProbe.pending, { sockets: 0, events: 0, bytes: 0, timerActive: false });

  const bytesHeld = await holdTransport(budgetReceiver);
  const largeBurst = Array.from({ length: 6 }, (_, index) => boundedEvent(`${index}-${'x'.repeat(3000)}`));
  for (const event of largeBurst) {
    deliveryProbe.broadcast('DELIVERY-BUDGET', event);
    assert.ok(deliveryProbe.pending.bytes <= 8192);
  }
  assert.equal(deliveryProbe.pending.events, 2, 'byte budget binds before the count limit');
  assert.equal(bytesHeld.writes.length, 0);
  deliveryProbe.drop(io.sockets.sockets.get(budgetReceiver.id));
  deliveryProbe.broadcast('DELIVERY-BUDGET', boundedEvent(String.fromCharCode(0xe9).repeat(5000)));
  assert.deepEqual(deliveryProbe.pending, { sockets: 0, events: 0, bytes: 0, timerActive: false },
    'an individually oversized UTF-8 payload is rejected without starting a timer');
  deliveryProbe.broadcast('DELIVERY-BUDGET', boundedEvent('close-while-pending'));
  assert.equal(deliveryProbe.pending.events, 1);
  deliveryProbe.close();
  assert.deepEqual(deliveryProbe.pending, { sockets: 0, events: 0, bytes: 0, timerActive: false });
  bytesHeld.release();
  await budgetReceiver.flush();
  assert.equal(interactionEvents(budgetReceiver).length, 8, 'explicit drop/close never flush pending messages');

  const originalBroadcast = InteractionDeliveryService.prototype.broadcast;
  const originalClose = InteractionDeliveryService.prototype.close;
  let productionQueue;
  let queueCloseCalls = 0;
  let httpCloseObserved = false;
  InteractionDeliveryService.prototype.broadcast = function (roomCode, event) {
    if (roomCode === 'DELIVERY-SHUTDOWN') productionQueue = this;
    return originalBroadcast.call(this, roomCode, event);
  };
  InteractionDeliveryService.prototype.close = function () {
    if (this === productionQueue) queueCloseCalls++;
    return originalClose.call(this);
  };
  try {
    const shutdown = await stalledInteraction('DELIVERY-SHUTDOWN');
    assert.ok(productionQueue.pending.events > 0);
    assert.equal(productionQueue.pending.timerActive, true);
    server.once('close', () => { httpCloseObserved = true; });
    // Socket.IO closes live connections and calls the actual HTTP server.close.
    await new Promise(resolve => io.close(resolve));
    assert.equal(httpCloseObserved, true);
    assert.equal(queueCloseCalls, 1, 'HTTP close invokes the production delivery cleanup exactly once');
    assert.deepEqual(productionQueue.pending, { sockets: 0, events: 0, bytes: 0, timerActive: false });
    assert.equal(shutdown.writes.length, 0, 'shutdown must discard, not flush, pending interactions');
    assert.equal(server.listening, false);
    io = null;
  } finally {
    InteractionDeliveryService.prototype.broadcast = originalBroadcast;
    InteractionDeliveryService.prototype.close = originalClose;
  }
  console.log('Interaction catalog safety, hot reload, real Socket authorization, quotas, bounded busy delivery, expiry/session/source/revision invalidation and no replay/state mutation passed');
} finally {
  deliveryProbe?.close();
  for (const cleanup of deliveryCleanups.reverse()) cleanup();
  for (const client of clients) client.ws.close();
  if (io) await new Promise(resolve => io.close(resolve));
  else if (server?.listening) await new Promise(resolve => server.close(resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
}
