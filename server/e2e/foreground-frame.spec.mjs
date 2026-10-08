import { test as base, expect } from '@playwright/test';
import { buildRepeatedFixtureWebM, installRemoteWebMFixture } from './helpers/media.mjs';
import { createRoomContexts, createRoomFromHome, joinRoomFromHome, openRoomTab,
  waitForRemoteMediaReady, readMediaState, installMediaCounters, readMediaCounters,
  setAutoSync, uniqueRoomName, closeRoomContexts } from './helpers/room.mjs';

// Run with PLAYWRIGHT_TEST_PORT=4188 and the existing config, without the npm build wrapper.
// These are simulated visibility/rVFC-delivery failures, not reproduced GPU failures.
// Media clocks, decoding, buffering, seeks, loads and Socket.IO remain real.
const mediaUrl = 'https://93.184.216.34/foreground-frame.webm';
const title = 'Foreground frame fixture';
const stageMs = 4500;
const quietMs = 11_000;
const clip = buildRepeatedFixtureWebM({ name: 'foreground-frame.webm', durationSeconds: 240 });

async function installProbe(context) {
  await context.addInitScript(() => {
    const probe = window.__foregroundFrame = {
      visibility: 'visible', dropFrames: false, delivered: 0, dropped: 0,
      recoveries: [], outgoing: [], socket: null,
    };
    Object.defineProperty(document, 'visibilityState', {
      configurable: true, get: () => probe.visibility,
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true, get: () => probe.visibility === 'hidden',
    });
    const native = HTMLVideoElement.prototype.requestVideoFrameCallback;
    if (typeof native === 'function') {
      HTMLVideoElement.prototype.requestVideoFrameCallback = new Proxy(native, {
        apply(target, video, [callback]) {
          return Reflect.apply(target, video, [function (now, metadata) {
            if (video.matches('[data-room-video]')) {
              if (probe.dropFrames) { probe.dropped += 1; return; }
              probe.delivered += 1;
            }
            return Reflect.apply(callback, video, [now, metadata]);
          }]);
        },
      });
    }
    window.addEventListener('together-see:player-frame-recovery', event => {
      const video = document.querySelector('[data-room-video]');
      probe.recoveries.push({
        action: event.detail.action, generation: event.detail.generation,
        at: performance.now(), currentTime: video.currentTime,
        paused: video.paused, playbackRate: video.playbackRate, volume: video.volume,
        currentSrc: video.currentSrc, delivered: probe.delivered,
      });
    });
  });
  // Same observation approach as the room suites; preserve the served room script
  // and observe the real socket without replacing its emit/ACK behavior.
  await context.route('**/assets/js/room.js*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `{
      const originalIo = window.io;
      window.io = new Proxy(originalIo, {
        apply(target, receiver, args) {
          const socket = Reflect.apply(target, receiver, args);
          const probe = window.__foregroundFrame;
          probe.socket = socket;
          socket.onAnyOutgoing((event, payload) => {
            probe.outgoing.push({ event, action: payload?.action });
          });
          return socket;
        }
      });
    }\n${await response.text()}` });
  });
}

async function visibility(page, value) {
  return page.evaluate(next => {
    window.__foregroundFrame.visibility = next;
    document.dispatchEvent(new Event('visibilitychange'));
    return performance.now();
  }, value);
}

async function foreground(page, dropFrames = false) {
  await visibility(page, 'hidden');
  await page.evaluate(drop => { window.__foregroundFrame.dropFrames = drop; }, dropFrames);
  return visibility(page, 'visible');
}

async function snapshot(page) {
  return {
    ...await readMediaState(page),
    ...await page.evaluate(() => {
      const probe = window.__foregroundFrame;
      const video = window.TogetherSeePlayer.video;
      return {
        generation: window.TogetherSeePlayer.getLoadToken().generation,
        volume: video.volume, muted: video.muted, seeking: video.seeking,
        delivered: probe.delivered, dropped: probe.dropped,
        recoveries: probe.recoveries, outgoing: probe.outgoing,
        connected: probe.socket.connected,
      };
    }),
  };
}

async function eligible(page) {
  await expect.poll(async () => {
    const state = await snapshot(page);
    return !state.paused && !state.seeking && state.readyState >= 3 && state.bufferedAhead > 1.2;
  }).toBe(true);
  await expect(page.locator('[data-room-video]')).toBeInViewport();
}

async function expectQuiet(page, generation, actions = []) {
  const state = await snapshot(page);
  expect(state.generation).toBe(generation);
  expect(state.recoveries.map(event => event.action)).toEqual(actions);
  expect(await readMediaCounters(page)).toEqual({ loadstart: 0, emptied: 0 });
}

const test = base.extend({
  room: async ({ browser, baseURL }, use) => {
    const contexts = await createRoomContexts(browser);
    const { hostContext, guestContext } = contexts;
    let hostPage;
    let guestPage;
    const errors = [];
    const apiRequests = [];
    try {
      for (const context of [hostContext, guestContext]) {
        await installProbe(context);
        await installRemoteWebMFixture(context, {
          inputUrl: mediaUrl, mediaUrl, title, buffer: clip.buffer,
          mimeType: clip.mimeType, mockParser: true,
        });
      }
      hostPage = await hostContext.newPage();
      guestPage = await guestContext.newPage();
      for (const page of [hostPage, guestPage]) {
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
          if (/^\/api\/(?:parse|proxy)(?:[/.]|$)/.test(new URL(request.url()).pathname)) {
            apiRequests.push(request.url());
          }
        });
      }
      const roomName = uniqueRoomName('FRAME');
      await createRoomFromHome(hostPage, baseURL, { roomName });
      await joinRoomFromHome(guestPage, baseURL, { roomName });
      // Grant room control so silence cannot pass merely because a guest lacks permission.
      await hostPage.locator('[data-room-control-policy-option="everyone"]').evaluate(node => node.click());
      await expect(guestPage.locator('[data-room-control-policy-option="everyone"]')).toHaveClass(/is-active/);
      await openRoomTab(hostPage, 'playlist');
      const form = hostPage.locator('[data-playlist-form]');
      await form.locator('input[name="videoLink"]').fill(mediaUrl);
      await form.evaluate(node => node.requestSubmit());
      await waitForRemoteMediaReady(hostPage, title);
      await waitForRemoteMediaReady(guestPage, title);
      await expect.poll(() => guestPage.evaluate(() =>
        typeof HTMLVideoElement.prototype.requestVideoFrameCallback)).toBe('function');
      await setAutoSync(guestPage, false);
      await hostPage.locator('[data-room-video]').evaluate(video => {
        video.pause();
        window.dispatchEvent(new CustomEvent('together-see:playback-user-action', { detail: { action: 'pause' } }));
      });
      await guestPage.locator('[data-room-video]').evaluate(async video => {
        // Establish a deliberately local state, distinct from the paused room.
        // A playback-user-action would be an explicit room command in everyone mode.
        video.muted = true;
        video.volume = 0.37;
        video.currentTime = 20;
        window.TogetherSeePlayer.setExternalPlaybackRate(1.25);
        await video.play();
      });
      await foreground(guestPage);
      await eligible(guestPage);
      await expect.poll(async () => (await snapshot(guestPage)).delivered).toBeGreaterThan(3);
      await guestPage.waitForTimeout(1000);
      expect((await readMediaState(hostPage)).paused).toBe(true);
      expect((await snapshot(guestPage)).connected).toBe(true);
      await installMediaCounters(hostPage);
      await installMediaCounters(guestPage);
      await guestPage.evaluate(() => { window.__foregroundFrame.outgoing = []; });
      apiRequests.length = 0;
      await use({ host: hostPage, guest: guestPage, apiRequests });
      expect(errors).toEqual([]);
    } finally {
      if (hostPage && guestPage) {
        await closeRoomContexts({ ...contexts, hostPage, guestPage });
      } else {
        await guestContext.close();
        await hostContext.close();
      }
    }
  },
});

test('healthy foreground return keeps frames flowing without a reload throughout the watch', async ({ room }) => {
  const { guest, apiRequests } = room;
  const before = await snapshot(guest);
  await foreground(guest);
  await guest.waitForTimeout(31_000);
  const after = await snapshot(guest);
  expect(after.delivered).toBeGreaterThan(before.delivered + 10);
  expect(after.currentTime).toBeGreaterThan(before.currentTime + 25);
  await expectQuiet(guest, before.generation);
  expect(apiRequests).toEqual([]);
});

test('stopped rVFC delivery nudges then reloads once, preserving guest intent without room commands', async ({ room }) => {
  const { host, guest, apiRequests } = room;
  const before = await snapshot(guest);
  const hostBefore = await snapshot(host);
  const armedAt = await foreground(guest, true);
  await expect.poll(async () => (await snapshot(guest)).dropped).toBeGreaterThan(0);
  const blocked = await snapshot(guest);
  await guest.waitForTimeout(1800);
  await eligible(guest);
  const advancing = await snapshot(guest);
  expect(advancing.delivered).toBe(blocked.delivered);
  expect(advancing.currentTime).toBeGreaterThan(blocked.currentTime + 1);
  expect(advancing.recoveries).toEqual([]);

  await expect.poll(async () => (await snapshot(guest)).recoveries.length, { timeout: 10_000 }).toBe(1);
  const nudged = await snapshot(guest);
  const nudge = nudged.recoveries[0];
  expect(nudge).toMatchObject({ action: 'nudge', generation: before.generation, paused: false });
  expect(nudge.at - armedAt).toBeGreaterThanOrEqual(stageMs);
  expect(Math.abs(nudged.currentTime - nudge.currentTime)).toBeLessThan(2);
  await expectQuiet(guest, before.generation, ['nudge']);

  await expect.poll(async () => (await snapshot(guest)).recoveries.length, { timeout: 12_000 }).toBe(2);
  await eligible(guest);
  await expect.poll(async () => (await readMediaCounters(guest)).loadstart).toBe(1);
  const recovered = await snapshot(guest);
  const reload = recovered.recoveries[1];
  expect(reload).toMatchObject({ action: 'reload', generation: before.generation,
    paused: false, playbackRate: 1.25, volume: 0.37, currentSrc: before.currentSrc });
  expect(reload.at - nudge.at).toBeGreaterThanOrEqual(stageMs);
  expect(reload.currentTime).toBeGreaterThan(nudge.currentTime + 3);
  expect(recovered).toMatchObject({ generation: before.generation + 1,
    currentSrc: before.currentSrc, sourceId: before.sourceId,
    paused: false, playbackRate: 1.25, volume: 0.37, muted: true });
  expect(recovered.currentTime).toBeGreaterThanOrEqual(reload.currentTime - 0.75);
  expect(recovered.currentTime).toBeLessThan(reload.currentTime + 4);
  const counters = await readMediaCounters(guest);

  // A fresh visibility arm on the same source must not replenish either attempt.
  await foreground(guest, true);
  await guest.waitForTimeout(31_000);
  const after = await snapshot(guest);
  expect(after.recoveries.map(event => event.action)).toEqual(['nudge', 'reload']);
  expect(after.generation).toBe(before.generation + 1);
  expect(await readMediaCounters(guest)).toEqual(counters);
  expect(after.currentTime).toBeGreaterThan(recovered.currentTime + 25);
  expect(after).toMatchObject({ paused: false, playbackRate: 1.25, volume: 0.37, connected: true });
  expect(after.outgoing.filter(item => item.event === 'playback_update' || item.event === 'proxy_token_request')).toEqual([]);
  expect(apiRequests).toEqual([]);
  const hostAfter = await snapshot(host);
  expect(hostAfter).toMatchObject({ generation: hostBefore.generation,
    sourceId: hostBefore.sourceId, paused: true, playbackRate: hostBefore.playbackRate });
  expect(Math.abs(hostAfter.currentTime - hostBefore.currentTime)).toBeLessThan(0.25);
  expect(await readMediaCounters(host)).toEqual({ loadstart: 0, emptied: 0 });
});

test('frames restored after nudge prevent the second-stage reload', async ({ room }) => {
  const { guest } = room;
  const before = await snapshot(guest);
  await foreground(guest, true);
  await expect.poll(async () => (await snapshot(guest)).recoveries.length, { timeout: 12_000 }).toBe(1);
  const nudged = await snapshot(guest);
  // Suppressing a one-shot callback stops its recursive chain. Re-arm explicitly.
  await foreground(guest, false);
  await expect.poll(async () => (await snapshot(guest)).delivered).toBeGreaterThan(nudged.delivered + 3);
  await guest.waitForTimeout(quietMs);
  await expectQuiet(guest, before.generation, ['nudge']);
  expect((await snapshot(guest)).currentTime).toBeGreaterThan(nudged.currentTime + 8);
});

for (const mode of ['paused', 'hidden']) {
  test(`${mode} cancels an armed frame fault before recovery`, async ({ room }) => {
    const { guest } = room;
    const before = await snapshot(guest);
    await foreground(guest, true);
    await expect.poll(async () => (await snapshot(guest)).dropped).toBeGreaterThan(0);
    await guest.waitForTimeout(1500);
    if (mode === 'paused') await guest.locator('[data-room-video]').evaluate(video => video.pause());
    else await visibility(guest, 'hidden');
    const stopped = await snapshot(guest);
    await guest.waitForTimeout(quietMs);
    await expectQuiet(guest, before.generation);
    const after = await snapshot(guest);
    if (mode === 'paused') {
      expect(after.paused).toBe(true);
      expect(Math.abs(after.currentTime - stopped.currentTime)).toBeLessThan(0.1);
    } else {
      expect(after.paused).toBe(false);
      expect(after.currentTime).toBeGreaterThan(stopped.currentTime + 8);
    }
  });
}

test('a late frame-delivery fault is ignored after 30 seconds until another foreground arm', async ({ room }) => {
  const { guest } = room;
  const before = await snapshot(guest);
  await foreground(guest);
  await guest.waitForTimeout(31_000);
  await guest.evaluate(() => { window.__foregroundFrame.dropFrames = true; });
  const expired = await snapshot(guest);
  await guest.waitForTimeout(quietMs);
  await expectQuiet(guest, before.generation);
  expect((await snapshot(guest)).currentTime).toBeGreaterThan(expired.currentTime + 8);
  await foreground(guest, true);
  await expect.poll(async () => (await snapshot(guest)).recoveries.length, { timeout: 12_000 }).toBe(1);
  await expectQuiet(guest, before.generation, ['nudge']);
});

test('HLS routing stub reuses the authorized proxy URL and rejects old callbacks after a source switch', async ({ room }) => {
  const { guest, apiRequests } = room;
  const originUrl = 'https://93.184.216.34/original-not-authorized.m3u8';
  const proxyUrl = new URL('/api/proxy/hls?grant=foreground-routing-fixture', guest.url()).href;
  const mediaRequests = [];
  const originRequests = [];
  await installRemoteWebMFixture(guest.context(), {
    mediaUrl: proxyUrl, buffer: clip.buffer, mimeType: clip.mimeType,
    onMediaRequest: request => mediaRequests.push(request),
  });
  await guest.route(originUrl, route => {
    originRequests.push(route.request().url());
    return route.abort('failed');
  });

  const loaded = await guest.evaluate(({ originUrl, proxyUrl }) => {
    const video = window.TogetherSeePlayer.video;
    const state = window.__foregroundHls = {
      instances: [], grants: [], frames: [], canceled: [], errors: [],
    };
    window.addEventListener('together-see:player-error', event => state.errors.push(event.detail.reason));
    const canPlayType = video.canPlayType.bind(video);
    video.canPlayType = type => /mpegurl/i.test(type) ? '' : canPlayType(type);
    const requestFrame = video.requestVideoFrameCallback;
    const cancelFrame = video.cancelVideoFrameCallback;
    video.requestVideoFrameCallback = function (callback) {
      const id = requestFrame.call(this, callback);
      state.frames.push({ id, callback });
      return id;
    };
    video.cancelVideoFrameCallback = function (id) {
      state.canceled.push(id);
      return cancelFrame.call(this, id);
    };
    window.TogetherSeeRoomProxy.request = async request => {
      state.grants.push({ ...request });
      if (state.grants.length !== 1) throw new Error('Unexpected replacement HLS grant');
      return { proxyUrl };
    };

    // Routing/lifecycle API stub only: the proxy fixture serves actual WebM bytes.
    // No MSE, manifest parsing, TS demuxing, or real Hls.js decoding is claimed.
    class RoutingHlsStub {
      static Events = { MEDIA_ATTACHED: 'attached', MANIFEST_PARSED: 'manifest',
        FRAG_BUFFERED: 'buffered', ERROR: 'error' };
      static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
      static isSupported() { return true; }
      constructor(config) {
        this.config = config;
        this.handlers = new Map();
        this.loads = [];
        this.starts = [];
        this.destroyed = 0;
        state.instances.push(this);
      }
      on(event, callback) {
        const callbacks = this.handlers.get(event) || [];
        callbacks.push(callback);
        this.handlers.set(event, callbacks);
      }
      emit(event, data = {}) {
        for (const callback of this.handlers.get(event) || []) callback(event, data);
      }
      attachMedia(media) {
        this.media = media;
        // Hls normally exposes the attached MSE URL before MEDIA_ATTACHED.
        // Our WebM transport uses loadstart, when currentSrc is actually updated;
        // even a zero-delay timer can still observe the previous media URL.
        this.onAttached = () => {
          this.attachedSrc = media.currentSrc || media.src;
          if (!this.destroyed) this.emit(RoutingHlsStub.Events.MEDIA_ATTACHED);
        };
        media.addEventListener('loadstart', this.onAttached, { once: true });
        media.preload = 'auto';
        media.src = proxyUrl;
        media.load();
      }
      loadSource(url) {
        this.loads.push(url);
        this.url = url;
        this.emit(RoutingHlsStub.Events.MANIFEST_PARSED);
      }
      startLoad(position) {
        this.starts.push(position);
        if (this.started) return;
        this.started = true;
        this.onData = () => this.emit(RoutingHlsStub.Events.FRAG_BUFFERED);
        this.media.addEventListener('loadeddata', this.onData, { once: true });
        if (this.media.currentSrc !== this.url) {
          this.media.src = this.url;
          this.media.load();
        }
      }
      destroy() {
        this.destroyed += 1;
        this.media.removeEventListener('loadstart', this.onAttached);
        if (this.onData) this.media.removeEventListener('loadeddata', this.onData);
        // Retain handlers so the test can deliberately deliver stale callbacks.
      }
    }
    window.Hls = RoutingHlsStub;
    return window.TogetherSeePlayer.loadSource({
      id: 'foreground-proxy-hls', sourceType: 'hls', sourceUrl: originUrl,
    }, { useProxy: true, startTime: 35, playWhenReady: true, playbackRate: 1.5 });
  }, { originUrl, proxyUrl });
  expect(loaded).toBe(true);
  await eligible(guest);
  await expect.poll(async () => (await snapshot(guest)).currentTime).toBeGreaterThan(35);
  expect(await guest.locator('[data-room-video]').getAttribute('data-hls-proxy')).toBe('true');
  const before = await snapshot(guest);
  expect(before).toMatchObject({ currentSrc: proxyUrl, paused: false, playbackRate: 1.5 });
  // The room fixture already installed listeners; reinstalling double-counts loads.
  await guest.evaluate(() => { window.__togetherSeeE2EMediaEvents = { loadstart: 0, emptied: 0 }; });
  await foreground(guest, true);
  await expect.poll(async () => (await snapshot(guest)).recoveries.length, { timeout: 18_000 }).toBe(2);
  await eligible(guest);
  await expect.poll(async () => (await readMediaCounters(guest)).loadstart).toBe(1);
  const recovered = await snapshot(guest);
  const reload = recovered.recoveries[1];
  expect(recovered.recoveries.map(event => ({ action: event.action, generation: event.generation }))).toEqual([
    { action: 'nudge', generation: before.generation },
    { action: 'reload', generation: before.generation },
  ]);
  expect(recovered).toMatchObject({ generation: before.generation + 1, currentSrc: proxyUrl,
    sourceId: before.sourceId, paused: false, playbackRate: 1.5, volume: before.volume });
  expect(recovered.currentTime).toBeGreaterThanOrEqual(reload.currentTime - 0.75);
  expect(recovered.currentTime).toBeLessThan(reload.currentTime + 4);
  const routing = () => guest.evaluate(() => ({
    grants: window.__foregroundHls.grants,
    instances: window.__foregroundHls.instances.map(instance => ({
      loads: instance.loads, starts: instance.starts, destroyed: instance.destroyed,
      startPosition: instance.config.startPosition, attachedSrc: instance.attachedSrc,
    })),
    errors: window.__foregroundHls.errors,
  }));
  const rebuilt = await routing();
  expect(rebuilt.grants).toEqual([{ routeName: 'hls', url: originUrl, refUrl: originUrl }]);
  expect(rebuilt.instances).toHaveLength(2);
  expect(rebuilt.instances.map(instance => instance.loads)).toEqual([[proxyUrl], [proxyUrl]]);
  expect(rebuilt.instances.map(instance => instance.attachedSrc)).toEqual([proxyUrl, proxyUrl]);
  expect(rebuilt.instances.map(instance => instance.destroyed)).toEqual([1, 0]);
  expect(rebuilt.instances[1].startPosition).toBeCloseTo(reload.currentTime, 1);
  expect(rebuilt.instances[1].starts[0]).toBeCloseTo(reload.currentTime, 1);
  expect(mediaRequests.length).toBeGreaterThanOrEqual(2);

  // Switch while the replacement engine has an outstanding frame watch.
  await guest.evaluate(mediaUrl => {
    const state = window.__foregroundHls;
    state.staleFrame = state.frames.at(-1);
    window.TogetherSeePlayer.loadSource({
      id: 'foreground-after-hls', sourceType: 'video', sourceUrl: mediaUrl,
    }, { startTime: 7, playWhenReady: false, playbackRate: 0.75 });
  }, mediaUrl);
  await expect.poll(async () => (await snapshot(guest)).readyState).toBeGreaterThanOrEqual(3);
  await expect.poll(async () => (await snapshot(guest)).seeking).toBe(false);
  const switched = await snapshot(guest);
  expect(switched).toMatchObject({ sourceId: 'foreground-after-hls', currentSrc: mediaUrl,
    generation: recovered.generation + 1, paused: true, playbackRate: 0.75 });
  expect(switched.currentTime).toBeCloseTo(7, 1);
  await guest.evaluate(() => { window.__togetherSeeE2EMediaEvents = { loadstart: 0, emptied: 0 }; });
  const stale = await guest.evaluate(() => {
    const state = window.__foregroundHls;
    const requestsBefore = state.frames.length;
    const canceled = state.canceled.includes(state.staleFrame.id);
    state.staleFrame.callback(performance.now(), {});
    for (const instance of state.instances) {
      instance.emit(window.Hls.Events.MEDIA_ATTACHED);
      instance.emit(window.Hls.Events.MANIFEST_PARSED);
      instance.emit(window.Hls.Events.FRAG_BUFFERED);
      instance.emit(window.Hls.Events.ERROR, {
        fatal: true, type: window.Hls.ErrorTypes.NETWORK_ERROR,
        details: 'manifestLoadError', response: { code: 403 },
      });
    }
    return { canceled, framesScheduled: state.frames.length - requestsBefore };
  });
  expect(stale).toEqual({ canceled: true, framesScheduled: 0 });
  await guest.waitForTimeout(quietMs);
  await expectQuiet(guest, switched.generation, ['nudge', 'reload']);
  const after = await snapshot(guest);
  expect(after).toMatchObject({ currentSrc: mediaUrl, sourceId: switched.sourceId,
    paused: true, playbackRate: 0.75 });
  expect(after.currentTime).toBeCloseTo(7, 1);
  const finalRouting = await routing();
  expect(finalRouting).toEqual({ ...rebuilt,
    instances: rebuilt.instances.map(instance => ({ ...instance, destroyed: 1 })) });
  expect(finalRouting.errors).toEqual([]);
  expect(originRequests).toEqual([]);
  // Proxy media reads are expected; parse and new authorization requests are not.
  expect(apiRequests.filter(url => url !== proxyUrl)).toEqual([]);
  expect(after.outgoing.filter(item => item.event === 'proxy_token_request')).toEqual([]);
});
