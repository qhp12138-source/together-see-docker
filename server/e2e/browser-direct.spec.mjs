import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { buildRepeatedFixtureWebM, loadFixtureWebM, installRemoteWebMFixture, mediaResponse } from './helpers/media.mjs';
import { createRoomFromHome, joinRoomFromHome, openRoomTab, uniqueRoomName, waitForRemoteMediaReady } from './helpers/room.mjs';

const directScript = fileURLToPath(new URL('../../assets/js/direct-media.js', import.meta.url));

// Real cross-origin HTTP validates browser CORS and stream cancellation. These
// loopback candidates are test-only, not assertions about backend public-IP gates.
async function corsFixture() {
  const clip = loadFixtureWebM({ name: 'probe.webm' });
  const requests = [];
  const timers = new Set();
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    const entry = { path, range: req.headers.range, cookie: req.headers.cookie || '', sent: 0, closed: false };
    requests.push(entry);
    res.on('close', () => { entry.closed = true; });
    if (!path.startsWith('/no-cors')) res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    if (path === '/redirect.webm') { res.writeHead(302, { location: '/valid.webm' }).end(); return; }
    res.setHeader('Content-Type', path.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/webm');
    if (path === '/timeout.webm' || path === '/no-cors-timeout.webm') { res.flushHeaders(); return; }
    if (path === '/ignore-range.webm') {
      res.flushHeaders();
      const timer = setInterval(() => {
        const chunk = entry.sent === 0 ? clip.buffer.subarray(0, 1024) : Buffer.alloc(1024);
        entry.sent += chunk.length;
        res.write(chunk);
        if (entry.sent >= 1024 * 1024) { clearInterval(timer); timers.delete(timer); res.end(); }
      }, 20);
      timers.add(timer);
      res.on('close', () => { clearInterval(timer); timers.delete(timer); });
      return;
    }
    if (path === '/html.webm' || path === '/no-cors-invalid.webm') { res.end('<html><body>not a video, despite its extension and MIME</body></html>'); return; }
    if (path === '/play.webm' || path === '/no-cors.webm') {
      const response = mediaResponse(clip.buffer, clip.mimeType, req.headers.range);
      if (path === '/no-cors.webm') delete response.headers['access-control-allow-origin'];
      res.writeHead(response.status, response.headers).end(response.body);
      return;
    }
    if (path === '/denied.webm') { res.writeHead(403).end(clip.buffer); return; }
    if (path.endsWith('.m3u8')) {
      if (path === '/range-denied.m3u8' && req.headers.range) { res.writeHead(403).end(); return; }
      if (path === '/transient.m3u8' && requests.filter(item => item.path === path).length === 1) { res.writeHead(503).end(); return; }
      const key = path === '/drm.m3u8' ? '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="license"\n'
        : path === '/keyformat.m3u8' ? '#EXT-X-KEY:METHOD=AES-128,KEYFORMAT="com.apple.streamingkeydelivery",URI="license"\n' : '';
      res.end(`#EXTM3U\n${key}#EXT-X-STREAM-INF:BANDWIDTH=800000\nchild.m3u8\n`);
      return;
    }
    if (path === '/valid.mp4') {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109]));
      return;
    }
    const bytes = clip.buffer.subarray(0, 4096);
    res.writeHead(206, { 'Content-Range': `bytes 0-${bytes.length - 1}/${clip.buffer.length}` });
    res.end(bytes);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`, requests,
    close: async () => {
      for (const timer of timers) clearInterval(timer);
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

test('browser byte probe enforces real CORS, Range, cancellation, DRM and candidate boundaries', async ({ page, baseURL }) => {
  const fixture = await corsFixture();
  try {
    await page.goto(baseURL);
    await page.addScriptTag({ path: directScript });
    await page.context().addCookies([{ name: 'must-not-send', value: 'secret', url: fixture.origin }]);
    const verify = (path, type = 'video', original) => page.evaluate(async ({ url, type, original }) => {
      try { return { result: await window.TogetherSeeDirectMedia.verify({ url, type }, original || url) }; }
      catch (error) { return { error: error.message }; }
    }, { url: fixture.origin + path, type, original });
    for (const [path, type] of [['/valid.webm', 'video'], ['/valid.mp4', 'video'], ['/valid.m3u8', 'hls'], ['/range-denied.m3u8', 'hls'], ['/transient.m3u8', 'hls'], ['/ignore-range.webm', 'video']]) {
      const value = await verify(path, type);
      expect(value.result).toMatchObject({ success: true, type, clientDirectOnly: true, requiresClientParse: false });
      expect(value.result.pageUrl).toBe(value.result.src);
    }
    await expect.poll(() => fixture.requests.find(value => value.path === '/ignore-range.webm')?.closed).toBe(true);
    expect(fixture.requests.find(value => value.path === '/ignore-range.webm').sent).toBeLessThan(64 * 1024);
    for (const [path, type] of [['/html.webm', 'video'], ['/no-cors-invalid.webm', 'video'], ['/denied.webm', 'video'], ['/drm.m3u8', 'hls'], ['/keyformat.m3u8', 'hls']]) {
      expect((await verify(path, type)).error).toBeTruthy();
    }
    const before = fixture.requests.length;
    expect((await verify('/valid.webm', 'video', fixture.origin + '/watch/page')).error).toBeTruthy();
    const blocked = await page.evaluate(async () => {
      try {
        await window.TogetherSeeDirectMedia.verify({ url: 'https://cdn.bilivideo.com/a.webm', type: 'video' }, 'https://cdn.bilivideo.com/a.webm');
        return false;
      } catch { return true; }
    });
    expect(blocked).toBe(true);
    expect(fixture.requests.length).toBe(before);
    expect(fixture.requests.filter(value => value.path === '/valid.webm')).toHaveLength(1);
    expect(fixture.requests.filter(value => !value.path.startsWith('/no-cors')).every(value =>
      value.range === (value.path.endsWith('.m3u8') ? undefined : 'bytes=0-4095') && value.cookie === '')).toBe(true);
    expect(fixture.requests.filter(value => value.path === '/transient.m3u8')).toHaveLength(2);
    expect(fixture.requests.filter(value => value.path === '/range-denied.m3u8')).toHaveLength(1);
    const normalized = await verify('/valid.webm', 'video', fixture.origin + '/valid.webm#position');
    expect(normalized.result).toMatchObject({ src: fixture.origin + '/valid.webm', pageUrl: fixture.origin + '/valid.webm' });
  } finally { await fixture.close(); }
});

test('HTML, undecodable no-CORS and eight-second stalled-body probes never add a room item', async ({ browser, baseURL }) => {
  const fixture = await corsFixture();
  const context = await browser.newContext();
  let parses = 0;
  try {
    await context.route('**/api/parse*', route => {
      parses += 1;
      const { url } = route.request().postDataJSON();
      return route.fulfill({ json: { success: false, code: 'parse_upstream_http_403', browserDirectCandidate: { url, type: 'video' } } });
    });
    const page = await context.newPage();
    await createRoomFromHome(page, baseURL, { roomName: uniqueRoomName('DIRECTFAIL') });
    await openRoomTab(page, 'playlist');
    const form = page.locator('[data-playlist-form]');
    for (const path of ['/html.webm', '/no-cors-invalid.webm', '/timeout.webm', '/no-cors-timeout.webm']) {
      const started = Date.now();
      await form.locator('input').fill(fixture.origin + path);
      await form.evaluate(node => node.requestSubmit());
      await expect(form.locator('button')).toBeEnabled({ timeout: 11000 });
      await expect(page.locator('[data-playlist-item]')).toHaveCount(0);
      await expect(page.locator('body')).toContainText(/本机(?:直连|原生播放).*(?:校验|失败|CORS|超时)/);
      if (path.endsWith('timeout.webm')) {
        expect(Date.now() - started).toBeGreaterThanOrEqual(7500);
        expect(Date.now() - started).toBeLessThan(11000);
        await expect.poll(() => fixture.requests.find(value => value.path === path)?.closed).toBe(true);
      }
    }
    await page.waitForTimeout(700);
    expect(parses).toBe(4);
    expect(fixture.requests.filter(value => value.path === '/timeout.webm')).toHaveLength(1);
  } finally { await context.close(); await fixture.close(); }
});

test('a real native-decoded no-CORS video joins and plays without proxy or script-readable bytes', async ({ browser, baseURL }) => {
  const fixture = await corsFixture();
  const context = await browser.newContext();
  const proxyRequests = [];
  const url = 'https://93.184.216.34/native-no-cors.webm';
  const clip = loadFixtureWebM({ name: 'native-no-cors.webm' });
  try {
    context.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/proxy/')) proxyRequests.push(request.url());
    });
    await context.route('**/api/parse*', route => route.fulfill({ json: {
      success: false, code: 'parse_upstream_http_403',
      browserDirectCandidate: { url, type: 'video' },
    } }));
    await context.route(url, route => {
      const response = mediaResponse(clip.buffer, clip.mimeType, route.request().headers().range);
      delete response.headers['access-control-allow-origin'];
      return route.fulfill({ status: response.status, headers: response.headers, body: response.body });
    });
    const page = await context.newPage();
    await createRoomFromHome(page, baseURL, { roomName: uniqueRoomName('NATIVEDIRECT') });
    // Real no-CORS HTTP proves decoder fallback. The room fixture separately
    // uses a public-shaped URL; real loopback playlist submissions remain denied.
    expect(await page.evaluate(async url => window.TogetherSeeDirectMedia.verify({ url, type: 'video' }, url),
      fixture.origin + '/no-cors.webm')).toMatchObject({ success: true, clientDirectOnly: true, message: expect.stringContaining('原生解码') });
    await openRoomTab(page, 'playlist');
    const form = page.locator('[data-playlist-form]');
    await form.locator('input').fill(url);
    await form.evaluate(node => node.requestSubmit());
    await expect(page.locator('[data-playlist-item]')).toHaveAttribute('data-client-direct-only', 'true');
    await expect.poll(() => page.locator('video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
    expect(await page.locator('video').getAttribute('crossorigin')).toBeNull();
    await page.locator('video').evaluate(video => { video.muted = true; return video.play(); });
    await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(0.5);
    expect(await page.evaluate(async url => {
      try { await fetch(url, { mode: 'cors' }); return true; } catch { return false; }
    }, fixture.origin + '/no-cors.webm')).toBe(false);
    expect(proxyRequests).toHaveLength(0);
  } finally { await context.close(); await fixture.close(); }
});

test('direct-only player handles native errors and fatal HLS errors without opening a proxy generation', async ({ page, baseURL }) => {
  const fixture = await corsFixture();
  try {
    // Isolate the production player; room authorization is exercised below.
    await page.route('**/assets/js/room.js*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
    await page.goto(`${baseURL}/room.html`);
    await page.evaluate(url => {
      window.__directPlayer = { errors: 0, proxy: 0, hlsUrl: '', retries: null };
      window.TogetherSeeRoomProxy = { request() { window.__directPlayer.proxy++; return Promise.reject(new Error('Unexpected proxy')); } };
      window.addEventListener('together-see:player-error', () => { window.__directPlayer.errors++; });
      window.TogetherSeePlayer.loadSource({ id: 'native-failure', sourceType: 'video', sourceUrl: url, clientDirectOnly: true });
    }, fixture.origin + '/html.webm');
    await expect.poll(() => page.evaluate(() => window.__directPlayer.errors)).toBe(1);
    const generation = await page.locator('video').getAttribute('data-load-generation');
    await page.locator('video').evaluate(video => { video.dispatchEvent(new Event('error')); video.dispatchEvent(new Event('error')); });
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => window.__directPlayer.errors)).toBe(1);
    expect(await page.locator('video').getAttribute('data-load-generation')).toBe(generation);
    await page.evaluate(url => {
      const video = document.querySelector('video');
      const canPlayType = video.canPlayType.bind(video);
      video.canPlayType = type => /mpegurl/i.test(type) ? '' : canPlayType(type);
      class MockHls {
        static isSupported() { return true; }
        static Events = { MEDIA_ATTACHED: 'attached', MANIFEST_PARSED: 'parsed', FRAG_BUFFERED: 'buffered', ERROR: 'error' };
        static ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
        constructor(options) { this.handlers = {}; window.__directPlayer.retries = options.manifestLoadPolicy.default.errorRetry.maxNumRetry; }
        on(name, handler) { this.handlers[name] = handler; }
        attachMedia() { this.handlers.attached(); }
        loadSource(value) {
          window.__directPlayer.hlsUrl = value;
          setTimeout(() => this.handlers.error('error', { fatal: true, type: 'network', details: 'fixture network failure' }), 0);
        }
        stopLoad() {}
        detachMedia() {}
        destroy() {}
      }
      window.Hls = MockHls;
      window.TogetherSeePlayer.loadSource({ id: 'hls-failure', sourceType: 'hls', sourceUrl: url, clientDirectOnly: true }, { useProxy: true });
    }, fixture.origin + '/valid.m3u8');
    await expect.poll(() => page.evaluate(() => window.__directPlayer.errors)).toBe(2);
    expect(await page.evaluate(() => window.__directPlayer)).toMatchObject({ proxy: 0, retries: 2, hlsUrl: fixture.origin + '/valid.m3u8' });
    await page.evaluate(url => {
      delete document.querySelector('video').canPlayType;
      window.TogetherSeePlayer.loadSource({ id: 'native-success', sourceType: 'video', sourceUrl: url, clientDirectOnly: true });
      document.querySelector('video').muted = true;
    }, fixture.origin + '/play.webm');
    await expect.poll(() => page.locator('video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
    await page.locator('video').evaluate(video => video.play());
    await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(0.2);
    expect(await page.evaluate(() => window.__directPlayer.proxy)).toBe(0);
  } finally { await fixture.close(); }
});

const observer = `{
  const io = window.io;
  window.io = function (...args) {
    const socket = Reflect.apply(io, this, args);
    const state = window.__directPlayback = { proxy: 0, errors: 0, shared: null };
    const emit = socket.emit;
    socket.emit = function (name, ...values) {
      if (name === 'proxy_token_request') state.proxy++;
      return Reflect.apply(emit, this, [name, ...values]);
    };
    socket.on('room_state', value => { state.shared = value.playlist[0] || null; });
    window.addEventListener('together-see:player-error', () => { state.errors++; });
    return socket;
  };
}
`;

test('real Hls.js terminal guest resists same-source authoritative playback broadcasts', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const contexts = [];
  const parses = [0, 0];
  const proxyRequests = [0, 0];
  const mediaRequests = [[], []];
  const url = 'https://93.184.216.34/terminal-hls/master.m3u8';
  const manifest = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="avc1.42E01E"\nchild.m3u8\n';
  const socketObserver = `{
    const io = window.io;
    window.io = function (...args) {
      const socket = Reflect.apply(io, this, args);
      const state = window.__terminalHls = {
        socket, roomCode: '', playback: null, shared: null, broadcasts: [], errors: [], proxy: 0
      };
      const remember = value => {
        if (value?.playback && (!state.playback || value.playback.revision >= state.playback.revision)) {
          state.playback = value.playback;
        }
      };
      const emit = socket.emit;
      socket.emit = function (name, ...values) {
        if (name === 'proxy_token_request') state.proxy++;
        const callback = values[values.length - 1];
        if (name === 'playback_update' && typeof callback === 'function') {
          values[values.length - 1] = function (...result) {
            remember(result[0]);
            return Reflect.apply(callback, this, result);
          };
        }
        return Reflect.apply(emit, this, [name, ...values]);
      };
      socket.on('room_state', value => {
        remember(value);
        state.roomCode = value.roomCode;
        state.shared = value.playlist[0] || null;
      });
      socket.on('playback_state', value => {
        remember({ playback: value });
        state.broadcasts.push({ revision: value.revision, sourceId: value.activeSourceId, playing: value.playing });
      });
      window.addEventListener('together-see:player-error', event => {
        const detail = event.detail;
        state.errors.push({
          generation: detail.generation, sourceId: detail.source?.id, reason: detail.reason,
          fatal: detail.hls?.fatal, status: detail.hls?.response?.code || detail.hls?.networkDetails?.status
        });
      });
      return socket;
    };
  }\n`;
  try {
    const roomJs = await fs.readFile(new URL('../../assets/js/room.js', import.meta.url), 'utf8');
    for (let index = 0; index < 2; index++) {
      const context = await browser.newContext();
      contexts.push(context);
      await context.route('**/assets/js/room.js*', route => route.fulfill({ contentType: 'application/javascript', body: socketObserver + roomJs }));
      context.on('request', request => {
        const pathname = new URL(request.url()).pathname;
        if (pathname === '/api/parse') parses[index]++;
        if (/^\/api\/proxy(?:\/|$)/.test(pathname)) proxyRequests[index]++;
      });
      await context.route('**/api/parse', route => route.fulfill({ json: {
        success: false, src: '', code: 'parse_upstream_http_403', browserDirectCandidate: { url, type: 'hls' },
      } }));
      // Every request to this fixture origin is intercepted, including unexpected children.
      await context.route('https://93.184.216.34/**', route => {
        const request = route.request();
        mediaRequests[index].push({ url: request.url(), range: request.headers().range || '' });
        return route.fulfill({
          status: request.url() === url ? 200 : 403,
          contentType: request.url() === url ? 'application/vnd.apple.mpegurl' : 'text/plain',
          headers: { 'access-control-allow-origin': '*' },
          body: request.url() === url ? manifest : 'Fixture child playlist forbidden',
        });
      });
    }
    const host = await contexts[0].newPage();
    const guest = await contexts[1].newPage();
    const roomName = uniqueRoomName('DIRECT-HLS-TERMINAL');
    await createRoomFromHome(host, baseURL, { roomName });
    await joinRoomFromHome(guest, baseURL, { roomName });
    for (const page of [host, guest]) {
      // Chromium can advertise native HLS. Select the bundled, unmodified real Hls.js engine.
      expect(await page.evaluate(() => {
        const video = document.querySelector('video');
        const canPlayType = video.canPlayType.bind(video);
        video.canPlayType = type => /mpegurl/i.test(type) ? '' : canPlayType(type);
        return { supported: window.Hls.isSupported(), version: window.Hls.version };
      })).toMatchObject({ supported: true, version: expect.stringMatching(/^\d+\./) });
      await openRoomTab(page, 'playlist');
    }
    const form = host.locator('[data-playlist-form]');
    await form.locator('input').fill(url);
    await form.evaluate(node => node.requestSubmit());
    for (const page of [host, guest]) {
      await expect(page.locator('[data-playlist-item]')).toHaveAttribute('data-client-direct-only', 'true');
      await expect.poll(() => page.evaluate(() => window.__terminalHls.shared)).toMatchObject({
        sourceUrl: url, pageUrl: url, clientDirectOnly: true, requiresClientParse: false,
      });
      await expect.poll(() => page.evaluate(() => window.__terminalHls.errors)).toEqual([
        expect.objectContaining({ fatal: true, status: 403, reason: 'levelLoadError' }),
      ]);
    }
    expect(mediaRequests[0].every(request => request.range === '')).toBe(true);
    expect(mediaRequests[1].some(request => request.url === url.replace('master', 'child'))).toBe(true);
    const sourceId = await guest.locator('[data-playlist-item]').getAttribute('data-source-id');
    const generation = await guest.locator('video').getAttribute('data-load-generation');
    expect(Number(generation)).toBeGreaterThan(0);
    const requestsAtTerminal = mediaRequests[1].length;
    const revisions = [];
    for (let index = 0; index < 8; index++) {
      // Drive the actual host socket, never inject a guest event or replace the transport.
      const result = await host.evaluate(index => new Promise((resolve, reject) => {
        const state = window.__terminalHls;
        const baseRevision = state.playback.revision;
        const timer = setTimeout(() => reject(new Error('Host playback acknowledgement timed out')), 3000);
        state.socket.emit('playback_update', {
          roomCode: state.roomCode, baseRevision, action: index % 2 === 0 ? 'play' : 'rate',
          patch: { activeSourceId: state.shared.id, playbackRate: index % 4 === 1 ? 1.25 : 1 },
          client: { ready: false, seeking: false },
        }, (room, decision) => {
          clearTimeout(timer);
          resolve({ decision, playback: room?.playback });
        });
      }), index);
      expect(result.decision).toMatchObject({ accepted: true, action: index % 2 === 0 ? 'play' : 'rate' });
      expect(result.decision.nextRevision).toBe(result.decision.baseRevision + 1);
      expect(result.playback).toMatchObject({ activeSourceId: sourceId, playing: true });
      const revision = result.decision.nextRevision;
      revisions.push(revision);
      await expect.poll(() => guest.evaluate(() => window.__terminalHls.broadcasts)).toContainEqual({
        revision, sourceId, playing: true,
      });
      await guest.waitForTimeout(750);
      expect(await guest.locator('video').getAttribute('data-load-generation')).toBe(generation);
      expect(await guest.evaluate(() => window.__terminalHls.errors)).toEqual([
        expect.objectContaining({ generation: Number(generation), sourceId, fatal: true, status: 403 }),
      ]);
    }
    expect(new Set(revisions).size).toBe(8);
    expect(mediaRequests[1]).toHaveLength(requestsAtTerminal);
    for (const page of [host, guest]) expect(await page.evaluate(() => window.__terminalHls.proxy)).toBe(0);
    expect(proxyRequests).toEqual([0, 0]);
    expect(parses).toEqual([1, 0]);
    console.log(JSON.stringify({ terminalHls: { broadcasts: revisions.length, revisions, guestErrors: 1,
      generation, guestMediaRequests: requestsAtTerminal, proxyRequests, parses } }));
  } finally {
    await Promise.allSettled(contexts.map(context => context.close()));
  }
});

for (const broken of [false, true]) {
  test(broken ? 'clientDirectOnly native playback failure terminates once without proxy or reparse' : 'upstream 403 browser-verified WebM persists and synchronizes on a guest without proxy or reparse', async ({ browser, baseURL }) => {
    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const contexts = [hostContext, guestContext];
    const parses = [0, 0];
    const probes = [];
    const url = 'https://93.184.216.34/browser-direct.webm';
    const title = 'Browser direct WebM';
    const clip = buildRepeatedFixtureWebM({ name: 'direct.webm', durationSeconds: 20 });
    try {
      const roomJs = await fs.readFile(new URL('../../assets/js/room.js', import.meta.url), 'utf8');
      for (const [index, context] of contexts.entries()) {
        await context.route('**/assets/js/room.js*', route => route.fulfill({ contentType: 'application/javascript', body: observer + roomJs }));
        context.on('request', request => { if (new URL(request.url()).pathname === '/api/parse') parses[index]++; });
        await installRemoteWebMFixture(context, {
          inputUrl: url, mediaUrl: url, title, buffer: clip.buffer, mockParser: index === 0,
          parserResult: { success: false, src: '', code: 'parse_upstream_http_403', browserDirectCandidate: { url, type: 'video' } },
          onMediaRequest: value => { if (index === 0) probes.push(value); },
        });
        if (broken) await context.route(url, route => route.request().resourceType() === 'media'
          ? route.fulfill({ contentType: 'video/webm', headers: { 'access-control-allow-origin': '*' }, body: '<html>media disappeared after verification</html>' })
          : route.fallback());
      }
      const host = await hostContext.newPage();
      const guest = await guestContext.newPage();
      const roomName = uniqueRoomName('DIRECT');
      await createRoomFromHome(host, baseURL, { roomName });
      await joinRoomFromHome(guest, baseURL, { roomName });
      await openRoomTab(host, 'playlist');
      await openRoomTab(guest, 'playlist');
      const form = host.locator('[data-playlist-form]');
      await form.locator('input').fill(url);
      await form.evaluate(node => node.requestSubmit());
      for (const page of [host, guest]) {
        await expect(page.locator('[data-playlist-item]')).toHaveAttribute('data-client-direct-only', 'true');
        await expect.poll(() => page.evaluate(() => window.__directPlayback.shared)).toMatchObject({ clientDirectOnly: true, requiresClientParse: false, sourceUrl: url, pageUrl: url });
      }
      expect(probes.some(value => value.rangeHeader === 'bytes=0-4095' && value.bytes <= 4096)).toBe(true);
      if (broken) {
        for (const page of [host, guest]) await expect.poll(() => page.evaluate(() => window.__directPlayback.errors)).toBe(1);
        const generations = [];
        for (const page of [host, guest]) generations.push(await page.locator('video').getAttribute('data-load-generation'));
        await guest.waitForTimeout(6000);
        for (const [index, page] of [host, guest].entries()) {
          expect(await page.evaluate(() => window.__directPlayback.errors)).toBe(1);
          expect(await page.locator('video').getAttribute('data-load-generation')).toBe(generations[index]);
        }
      } else {
        await waitForRemoteMediaReady(host, title);
        await waitForRemoteMediaReady(guest, title);
        if (await host.locator('video').evaluate(video => video.paused)) await host.locator('[data-player-play]').click({ force: true });
        for (const page of [host, guest]) await expect.poll(() => page.locator('video').evaluate(video => video.currentTime)).toBeGreaterThan(1);
        const hostTime = await host.locator('video').evaluate(video => video.currentTime);
        const guestTime = await guest.locator('video').evaluate(video => video.currentTime);
        expect(Math.abs(hostTime - guestTime)).toBeLessThan(3.5);
        expect(await guest.evaluate(() => window.__directPlayback.proxy)).toBe(0);
        await guest.reload();
        await waitForRemoteMediaReady(guest, title);
        await expect(guest.locator('[data-playlist-item]')).toHaveAttribute('data-client-direct-only', 'true');
      }
      for (const page of [host, guest]) expect(await page.evaluate(() => window.__directPlayback.proxy)).toBe(0);
      expect(parses).toEqual([1, 0]);
    } finally { await guestContext.close(); await hostContext.close(); }
  });
}
