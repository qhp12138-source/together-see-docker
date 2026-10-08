import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createRoomContexts, createRoomFromHome, joinRoomFromHome, openRoomTab,
  waitForRemoteMediaReady, uniqueRoomName, setAutoSync, closeRoomContexts,
} from './helpers/room.mjs';
import { buildRepeatedFixtureWebM, installRemoteWebMFixture } from './helpers/media.mjs';

const actionTimeout = 10_000;
test.use({ actionTimeout });
test.describe.configure({ timeout: 60_000 });

const shellSelector = '[data-player-shell]';
const effectsSelector = '[data-interaction-layer] canvas';
const point = { x: 0.36, y: 0.38 };
const resizeViewport = { width: 800, height: 768 };

async function installContextProbe(context) {
  await context.addInitScript(() => {
    const history = window.__interactionContextHistory = [];
    const delivery = window.__interactionDelivery = { received: [], images: [] };
    const NativeImage = window.Image;
    window.Image = new Proxy(NativeImage, {
      construct(target, args) {
        const image = Reflect.construct(target, args);
        for (const type of ['load', 'error']) image.addEventListener(type, () => {
          const url = new URL(image.currentSrc || image.src, location.href);
          if (!url.pathname.startsWith('/assets/interactions/')) return;
          delivery.images.push({ type, at: performance.now(), path: url.pathname,
            revision: url.searchParams.get('v'), width: image.naturalWidth, height: image.naturalHeight });
          if (delivery.images.length > 64) delivery.images.shift();
        });
        return image;
      },
    });
    let module;
    Object.defineProperty(window, 'TogetherSeeInteractions', {
      configurable: true,
      get: () => module,
      set(value) {
        module = value;
        const create = value.create;
        value.create = function (options) {
          let lastIdentity;
          const readContext = () => {
            const state = options.getContext();
            const identity = JSON.stringify([state.connected, state.sourceId, state.localSourceId, document.hidden]);
            if (identity !== lastIdentity) {
              history.push({ ...state, at: performance.now(), hidden: document.hidden });
              if (history.length > 160) history.shift();
              lastIdentity = identity;
            }
            return state;
          };
          window.__readInteractionContext = readContext;
          const api = create.call(this, { ...options, getContext: readContext });
          const show = api.show;
          api.show = function (payload) {
            const receivedAt = performance.now();
            const state = readContext();
            const receivedAge = state.now - payload.sentAt;
            const entry = { id: payload.id, assetId: payload.assetId, assetRevision: payload.assetRevision,
              sourceId: payload.sourceId, sentAt: payload.sentAt, durationMs: payload.durationMs,
              x: payload.x, y: payload.y, receivedAt, receivedWallTime: Date.now(), receivedAge,
              deadline: receivedAt + Math.min(payload.durationMs, 3000) - Math.max(0, receivedAge),
              context: { ...state, hidden: document.hidden },
              enabled: document.querySelector('[data-interaction-enabled]')?.checked, settledAt: null };
            delivery.received.push(entry);
            if (delivery.received.length > 64) delivery.received.shift();
            const result = show.call(this, payload);
            Promise.resolve(result).then(() => { entry.settledAt = performance.now(); },
              () => { entry.settledAt = performance.now(); entry.rejected = true; });
            return result;
          };
          return api;
        };
      },
    });
  });
}

async function roomPair(browser, baseURL, { probeContext = false } = {}) {
  const contexts = await createRoomContexts(browser);
  for (const context of [contexts.hostContext, contexts.guestContext]) {
    context.setDefaultTimeout(actionTimeout);
    await installContextProbe(context);
  }
  const hostPage = await contexts.hostContext.newPage();
  const guestPage = await contexts.guestContext.newPage();
  const pair = { ...contexts, hostPage, guestPage, errors: [] };
  pair.playback = {};
  pair.playbackAcks = { host: [], guest: [] };
  pair.interactionFrames = { host: [], guest: [] };
  pair.catalogs = {};
  pair.assetRequests = { host: [], guest: [] };
  for (const [peer, page] of [['host', hostPage], ['guest', guestPage]]) {
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/assets/interactions/')) pair.assetRequests[peer].push({
        path: url.pathname, revision: url.searchParams.get('v'), type: request.resourceType(), startedWallTime: Date.now(),
      });
    });
    page.on('response', async response => {
      if (new URL(response.url()).pathname !== '/api/interactions') return;
      const catalog = await response.json().catch(() => null);
      if (Array.isArray(catalog?.items)) pair.catalogs[peer] = catalog.items.map(asset => ({
        id: asset.id, revision: asset.revision, type: asset.type, durationMs: asset.durationMs,
        path: new URL(asset.src, baseURL).pathname,
        audioPath: asset.audio ? new URL(asset.audio, baseURL).pathname : null, visualBytes: asset.visualBytes,
      }));
    });
    page.on('websocket', socket => {
      const pending = new Map();
      socket.on('framesent', ({ payload }) => {
        if (!probeContext || typeof payload !== 'string') return;
        const match = /^42(\d+)\[/.exec(payload);
        if (!match) return;
        try {
          const [event, data] = JSON.parse(payload.slice(payload.indexOf('[')));
          if (event === 'playback_update') pending.set(match[1], {
            action: data.action, baseRevision: data.baseRevision, sourceId: data.patch?.activeSourceId,
            playing: data.patch?.playing, ready: data.client?.ready, seeking: data.client?.seeking,
            sentAt: Date.now(),
          });
        } catch { /* Observe only complete Socket.IO event packets. */ }
      });
      socket.on('framereceived', ({ payload }) => {
        if (typeof payload !== 'string' || !/^4[23]\d*\[/.test(payload)) return;
        try {
          const [event, data] = JSON.parse(payload.slice(payload.indexOf('[')));
          if (event === 'interaction_play') pair.interactionFrames[peer].push({
            receivedWallTime: Date.now(), id: data.id, assetId: data.assetId,
            assetRevision: data.assetRevision, sourceId: data.sourceId,
            sentAt: data.sentAt, durationMs: data.durationMs, x: data.x, y: data.y,
          });
          const playback = payload.startsWith('43') ? event?.playback
            : event === 'playback_state' ? data : event === 'room_state' ? data.playback : null;
          if (playback) pair.playback[peer] = {
            playing: playback.playing, rate: playback.playbackRate, revision: playback.revision,
            sourceId: playback.activeSourceId, updatedAt: playback.updatedAt,
          };
          const ackId = /^43(\d+)\[/.exec(payload)?.[1];
          const request = pending.get(ackId);
          if (request) {
            pending.delete(ackId);
            pair.playbackAcks[peer].push({ ackId, request, receivedAt: Date.now(),
              playback: playback ? { ...pair.playback[peer] } : null,
              decision: { accepted: data?.accepted, action: data?.action,
                baseRevision: data?.baseRevision, nextRevision: data?.nextRevision },
            });
          }
        } catch { /* Ignore non-event transport frames. */ }
      });
    });
  }
  try {
    const clip = buildRepeatedFixtureWebM({ name: 'interactions.webm', durationSeconds: 60 });
    const mediaUrl = 'https://93.184.216.34/interactions-e2e.webm';
    for (const context of [contexts.hostContext, contexts.guestContext]) {
      await installRemoteWebMFixture(context, {
        inputUrl: mediaUrl, mediaUrl, title: 'Interaction fixture', buffer: clip.buffer, mockParser: true,
      });
    }
    for (const page of [hostPage, guestPage]) page.on('pageerror', error => pair.errors.push(error.message));
    const roomName = uniqueRoomName('INTERACTION');
    await createRoomFromHome(hostPage, baseURL, { roomName, nickname: 'Interaction Host' });
    await joinRoomFromHome(guestPage, baseURL, { roomName, nickname: 'Ordinary Guest' });
    await expect(guestPage.locator('body')).toHaveAttribute('data-room-user-role', 'follower');
    await expect(hostPage.locator('[data-toolbar-member-count]')).toHaveText('2');
    if (probeContext) await expect.poll(() => pair.playback.host?.sourceId).toBeNull();
    pair.emptyPlayback = { ...pair.playback.host };
    await openRoomTab(hostPage, 'playlist');
    const form = hostPage.locator('[data-playlist-form]');
    await form.locator('input').fill(mediaUrl);
    await form.evaluate(node => node.requestSubmit());
    await waitForRemoteMediaReady(hostPage, 'Interaction fixture');
    await waitForRemoteMediaReady(guestPage, 'Interaction fixture');
    return pair;
  } catch (error) {
    await closeRoomContexts(pair);
    throw error;
  }
}

async function screenshot(page, testInfo, name) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'together-see-interactions-'));
  const file = path.join(directory, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

async function chooseQuestion(page) {
  // Playing controls can auto-hide while the other peer's layout is being checked.
  await page.locator(shellSelector).hover();
  await page.locator('[data-interaction-toggle]').click();
  await expect(page.locator('#interactionPopover')).toBeVisible();
  if (await page.locator('[data-interaction-group-tab="other"]').isVisible()) await page.locator('[data-interaction-group-tab="other"]').click();
  await page.locator('[data-interaction-asset="question"]').click();
  await expect(page.locator(shellSelector)).toHaveClass(/\bis-interaction-placing\b/);
}

// Independent geometry calculation: do not use pictureRect from the implementation under test.
async function picture(page) {
  return page.locator('[data-room-video]').evaluate(video => {
    const box = video.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const width = video.videoWidth * scale, height = video.videoHeight * scale;
    return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2,
      width, height, boxWidth: box.width, boxHeight: box.height };
  });
}

async function placeQuestion(page) {
  await chooseQuestion(page);
  const rect = await picture(page);
  await page.mouse.click(rect.left + rect.width * point.x, rect.top + rect.height * point.y);
}

async function installObserver(page) {
  await page.evaluate(() => {
    const video = document.querySelector('[data-room-video]');
    const layer = document.querySelector('[data-interaction-layer]');
    const state = window.__interactionProbe = { effects: {}, events: {}, snapshots: [], visibility: [], done: false };
    const media = () => ({ src: video.src, currentSrc: video.currentSrc, time: video.currentTime,
      paused: video.paused, rate: video.playbackRate, at: performance.now(), wallTime: Date.now(),
      hidden: document.hidden, sourceId: video.dataset.sourceId || '', connected: document.body.dataset.socketConnected });
    state.before = media();
    document.addEventListener('visibilitychange', () => state.visibility.push(media()));
    for (const type of ['loadstart', 'loadedmetadata', 'loadeddata', 'emptied', 'seeking', 'seeked', 'play', 'pause', 'ratechange']) {
      state.events[type] = 0;
      video.addEventListener(type, () => { state.events[type]++; });
    }
    const observer = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          const id = node.dataset?.interactionId;
          if (id) state.effects[id] = { added: performance.now(), addedState: media(), removed: null, samples: [] };
        }
        for (const node of record.removedNodes) {
          const id = node.dataset?.interactionId;
          if (state.effects[id]) {
            state.effects[id].removed = performance.now();
            state.effects[id].removedState = media();
          }
        }
      }
    });
    observer.observe(layer, { childList: true });
    let lastSample = -Infinity;
    function sample(at) {
      if (state.done) { observer.disconnect(); return; }
      if (at - lastSample >= 40 || Object.values(state.effects).some(item => item.removed === null && !item.samples.length)) {
        at = performance.now();
        lastSample = at;
        state.snapshots.push(media());
        const box = video.getBoundingClientRect();
        const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
        const width = video.videoWidth * scale, height = video.videoHeight * scale;
        const left = box.left + (box.width - width) / 2, top = box.top + (box.height - height) / 2;
        for (const element of layer.querySelectorAll('canvas, img, video')) {
          const item = state.effects[element.dataset.interactionId];
          if (!item) continue;
          let canvas = element;
          if (element.tagName !== 'CANVAS') {
            const width = element.videoWidth || element.naturalWidth;
            const height = element.videoHeight || element.naturalHeight;
            if (!width || !height || (element.tagName === 'VIDEO' && element.readyState < 2)) continue;
            canvas = document.createElement('canvas');
            canvas.width = Math.min(320, width);
            canvas.height = Math.max(1, Math.round(height * canvas.width / width));
            canvas.getContext('2d').drawImage(element, 0, 0, canvas.width, canvas.height);
          }
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let visible = 0, transparent = 0, minimum = 255, maximum = 0;
          for (let i = 3; i < pixels.length; i += 4) {
            if (pixels[i] > 8) {
              visible++;
              minimum = Math.min(minimum, pixels[i - 3], pixels[i - 2], pixels[i - 1]);
              maximum = Math.max(maximum, pixels[i - 3], pixels[i - 2], pixels[i - 1]);
            }
            if (pixels[i] === 0) transparent++;
          }
          const bounds = element.getBoundingClientRect();
          const overlay = layer.getBoundingClientRect();
          item.samples.push({ at, visible, transparent, hidden: document.hidden, width, height, kind: element.tagName, colorRange: maximum - minimum,
            effectWidth: bounds.width, effectHeight: bounds.height,
            decodedFrames: element.tagName === 'VIDEO' ? element.getVideoPlaybackQuality().totalVideoFrames : null,
            effectPaused: element.tagName === 'VIDEO' ? element.paused : null,
            x: (bounds.left + bounds.width / 2 - left) / width,
            y: (bounds.top + bounds.height / 2 - top) / height,
            overlayError: Math.max(Math.abs(overlay.left - left), Math.abs(overlay.top - top),
              Math.abs(overlay.width - width), Math.abs(overlay.height - height)) });
        }
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
}

async function observedVisible(page) {
  return page.evaluate(() => Object.values(window.__interactionProbe.effects)
    .some(item => item.samples.some(sample => sample.visible > 50 && sample.transparent > 50)));
}

// Delivery gets a separate bounded wait, but rendering never gets a fresh lifetime.
async function requireInteractionFrame(page, { resizedFrom = null } = {}) {
  const result = await page.evaluate(async resizedFrom => {
    const deliveryDeadline = performance.now() + 4000;
    const waitDeadline = deliveryDeadline + 3000;
    return new Promise(resolve => {
      function check() {
        const now = performance.now();
        const event = window.__interactionDelivery.received.at(-1);
        if (now >= waitDeadline) return resolve({ status: 'bounded-observation-timeout', event });
        if (!event) {
          if (now >= deliveryDeadline) return resolve({ status: 'broadcast-not-dispatched' });
        } else {
          if (![event.sentAt, event.receivedAt, event.receivedAge, event.durationMs, event.deadline].every(Number.isFinite)
            || event.durationMs <= 0 || event.durationMs > 3000 || event.receivedAge < -1000
            || event.deadline > event.receivedAt + 3000) return resolve({ status: 'invalid-event-timing', event });
          if (event.receivedAt > deliveryDeadline) return resolve({ status: 'broadcast-after-delivery-budget', event });
          if (event.receivedAge >= event.durationMs) return resolve({ status: 'expired-on-arrival', event });
          const context = window.__readInteractionContext();
          if (event.context.hidden || document.hidden || !event.context.connected || !context.connected
            || event.context.sourceId !== event.sourceId || event.context.localSourceId !== event.sourceId
            || context.sourceId !== event.sourceId || context.localSourceId !== event.sourceId) {
            return resolve({ status: 'context-unavailable-before-render', event });
          }
          const effect = window.__interactionProbe.effects[event.id];
          const visible = sample => !sample.hidden && sample.effectWidth > 0 && sample.effectHeight > 0
            && sample.visible > 50 && sample.transparent > 50;
          const first = effect?.samples.find(visible);
          const frame = effect?.samples.find(sample => visible(sample)
            && sample.at < event.deadline && (resizedFrom === null || Math.abs(sample.width - resizedFrom) > 10));
          if (frame) return resolve({ status: 'visible-before-original-expiry', event, first, frame });
          if (now >= event.deadline) {
            const image = window.__interactionDelivery.images.find(item => item.revision === event.assetRevision);
            const resources = performance.getEntriesByType('resource').filter(item => {
              const url = new URL(item.name);
              return url.pathname.startsWith('/assets/interactions/') && url.searchParams.get('v') === event.assetRevision;
            }).map(item => ({ path: new URL(item.name).pathname, start: item.startTime, end: item.responseEnd,
              duration: item.duration, bytes: item.encodedBodySize }));
            const status = event.receivedAge >= event.durationMs ? 'expired-on-arrival'
              : document.hidden || !context.connected || context.sourceId !== event.sourceId || context.localSourceId !== event.sourceId
                ? 'context-unavailable-before-render'
                : first?.at >= event.deadline ? 'first-frame-after-expiry'
                  : first ? 'resize-not-observed-before-expiry'
                  : !image ? 'no-image-load-observed-before-expiry'
                    : image.at >= event.deadline ? 'image-ready-after-expiry' : 'no-pixels-before-expiry';
            return resolve({ status, event, first, image, resources, now });
          }
        }
        setTimeout(check, 10);
      }
      check();
    });
  }, resizedFrom);
  expect(result.status, JSON.stringify(result)).toBe('visible-before-original-expiry');
  expect(result.event.receivedAge).toBeGreaterThanOrEqual(-1000);
  expect(result.event.durationMs).toBeGreaterThan(0);
  expect(result.event.durationMs).toBeLessThanOrEqual(3000);
  expect(result.event.context).toMatchObject({ connected: true, hidden: false,
    sourceId: result.event.sourceId, localSourceId: result.event.sourceId });
  expect(result.first.at).toBeLessThan(result.event.deadline);
  return result.event;
}

async function attachDelivery(pair, testInfo) {
  for (const [peer, page] of [['host', pair.hostPage], ['guest', pair.guestPage]]) {
    const data = await page.evaluate(async () => {
      const event = window.__interactionDelivery.received.at(-1);
      // Keep late load completion in diagnostics; a failed first-frame verdict is never retried.
      if (event && event.settledAt === null && performance.now() >= event.deadline) {
        const stop = performance.now() + 1000;
        while (event.settledAt === null && performance.now() < stop) await new Promise(resolve => setTimeout(resolve, 20));
      }
      return { ...window.__interactionDelivery,
        at: performance.now(), context: window.__readInteractionContext?.(),
        effects: Object.entries(window.__interactionProbe?.effects || {}).map(([id, effect]) => ({
          id, added: effect.added, removed: effect.removed,
          firstFrame: effect.samples.find(sample => !sample.hidden && sample.effectWidth > 0 && sample.effectHeight > 0
            && sample.visible > 50 && sample.transparent > 50) || null,
        })),
        resources: performance.getEntriesByType('resource').filter(item => new URL(item.name).pathname.startsWith('/assets/interactions/'))
          .map(item => ({ path: new URL(item.name).pathname, start: item.startTime, end: item.responseEnd,
            bytes: item.encodedBodySize, duration: item.duration })),
      };
    }).catch(() => null);
    const event = data?.received.at(-1);
    const asset = pair.catalogs[peer]?.find(asset => asset.id === event?.assetId);
    const firstFrame = data?.effects.find(effect => effect.id === event?.id)?.firstFrame;
    const image = data?.images.find(image => image.revision === event?.assetRevision && image.path === asset?.path);
    const verdict = !event ? (pair.interactionFrames[peer].length ? 'wire-received-not-dispatched' : 'broadcast-not-observed')
      : ![event.receivedAge, event.durationMs, event.deadline].every(Number.isFinite) || event.receivedAge < -1000
        || event.durationMs <= 0 || event.durationMs > 3000 ? 'invalid-event-timing'
        : !event.enabled ? 'locally-disabled'
        : asset?.revision !== event.assetRevision ? 'catalog-revision-mismatch'
          : event.receivedAge >= event.durationMs ? 'expired-on-arrival'
            : event.context.hidden || !event.context.connected || event.context.sourceId !== event.sourceId
              || event.context.localSourceId !== event.sourceId ? 'context-unavailable-on-arrival'
            : firstFrame ? (firstFrame.at < event.deadline ? 'rendered-before-original-expiry' : 'first-frame-after-expiry')
              : image?.type === 'error' ? 'image-load-error'
                : image?.at >= event.deadline ? 'image-ready-after-expiry'
                  : !image ? 'image-load-not-observed' : 'image-ready-but-no-pixels-before-expiry';
    await testInfo.attach(`${peer}-interaction-delivery`, { contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ verdict, frames: pair.interactionFrames[peer], catalog: pair.catalogs[peer],
        requests: pair.assetRequests[peer], beforeToolbox: pair.beforeToolbox?.[peer], ...data }, null, 2)) });
    console.log('[interaction delivery] ' + JSON.stringify({ peer, verdict, wireEvents: pair.interactionFrames[peer].length,
      received: data?.received.slice(-4), images: data?.images.slice(-4) }));
  }
}

function inspectProductPrewarm(pair) {
  pair.beforeToolbox = {};
  for (const peer of ['host', 'guest']) {
    const catalog = pair.catalogs[peer] || [];
    expect(catalog.map(asset => asset.id).sort(), `${peer}: public snapshot allowlist`)
      .toEqual(['birthday', 'fireworks', 'heart', 'question', 'sakura']);
    const requests = pair.assetRequests[peer].slice();
    const warmed = catalog.filter(asset => requests.some(request => request.path === asset.path && request.revision === asset.revision));
    pair.beforeToolbox[peer] = { at: Date.now(), requests, warmed };
    // No test fetch, toolbox open, or asset selection has occurred on either cold context.
    const question = warmed.find(asset => asset.id === 'question');
    expect(question, `${peer}: product must initiate the small question visual before toolbox interaction`).toBeTruthy();
    expect(warmed.map(asset => asset.id), `${peer}: only the public sprite needs visual prewarm`).toEqual(['question']);
    expect(warmed.length, `${peer}: bounded product prewarm count`).toBeLessThanOrEqual(2);
    expect(requests.filter(request => warmed.some(asset => asset.path === request.path && asset.revision === request.revision)).length,
      `${peer}: at most two visual prewarm requests, including retries`).toBeLessThanOrEqual(2);
    for (const asset of warmed) {
      expect(['image', 'sprite']).toContain(asset.type);
      expect(Number.isInteger(asset.visualBytes)).toBe(true);
      expect(asset.visualBytes).toBeGreaterThan(0);
      expect(asset.visualBytes).toBeLessThanOrEqual(1024 * 1024);
    }
    expect(warmed.reduce((sum, asset) => sum + asset.visualBytes, 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(requests.filter(request => catalog.some(asset => asset.audioPath === request.path)),
      `${peer}: product prewarm must not fetch audio`).toEqual([]);
    expect(requests.filter(request => catalog.some(asset => asset.type === 'video' && asset.path === request.path)),
      `${peer}: product prewarm must not fetch video`).toEqual([]);
  }
}

async function requireOriginalExpiry(page, event) {
  const effect = await page.evaluate(async event => {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, event.deadline + 32 - performance.now())));
    return window.__interactionProbe.effects[event.id];
  }, event);
  expect(effect?.removed, 'a rendered effect must be removed at its original deadline').not.toBeNull();
  expect(effect?.removed).toBeGreaterThanOrEqual(event.deadline - 2);
  // Cleanup may land on the next animation frame; this is not extra permitted first-frame time.
  expect(effect?.removed).toBeLessThanOrEqual(event.deadline + 32);
  await expect(page.locator(effectsSelector)).toHaveCount(0);
}

for (const playing of [false, true]) {
  test(`ordinary guest sends a transparent, aligned effect without disturbing ${playing ? 'playing' : 'paused'} media`, async ({ browser, baseURL }, testInfo) => {
    const pair = await roomPair(browser, baseURL);
    const { hostPage: host, guestPage: guest } = pair;
    try {
      if (playing) {
        for (const page of [host, guest]) await page.locator('[data-room-video]').evaluate(video => { video.muted = true; });
        await expect.poll(() => host.locator('[data-room-video]').evaluate(video => video.paused)).toBe(true);
        await host.locator(shellSelector).hover();
        await host.locator('[data-player-play]').click();
        await expect.poll(() => pair.playback.host?.playing, { message: 'host user play must establish server authority' }).toBe(true);
        await expect.poll(() => pair.playback.guest?.playing).toBe(true);
        for (const page of [host, guest]) await expect.poll(() => page.locator('[data-room-video]').evaluate(video => video.paused)).toBe(false);
      }
      // Establish authority first; then keep both peers' local preferences independent.
      for (const page of [host, guest]) await setAutoSync(page, false);
      for (const page of [host, guest]) {
        await page.locator('[data-room-video]').evaluate(async (video, running) => {
          if (!running) video.pause();
          video.muted = true;
          video.currentTime = 4;
          if (video.seeking) await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
          if (!running) video.playbackRate = 1.25;
        }, playing);
        await page.locator(shellSelector).scrollIntoViewIfNeeded();
        if (playing) {
          await page.locator(shellSelector).hover();
          await page.locator('[data-player-rate]').click();
        }
        await expect.poll(() => page.locator('[data-room-video]').evaluate(video => video.playbackRate)).toBe(1.25);
      }
      // CSS page fullscreen gives the mobile 16:9 clip a tall, letterboxed video box.
      await guest.locator('[data-page-fullscreen]').click();
      await expect(guest.locator(shellSelector)).toHaveClass(/\bis-page-fullscreen\b/);
      const letterbox = await picture(guest);
      expect(letterbox.boxHeight - letterbox.height).toBeGreaterThan(20);
      const beforeResize = await test.step('verify distinct picture layouts before sending', async () => {
        const originalViewport = host.viewportSize();
        expect(originalViewport).not.toBeNull();
        const originalPicture = await picture(host);
        expect(originalPicture.width).toBeGreaterThan(0);
        expect(originalPicture.height).toBeGreaterThan(0);
        await host.setViewportSize(resizeViewport);
        await expect.poll(async () => Math.abs((await picture(host)).width - originalPicture.width),
          { message: '800px viewport must change the actual video picture width before testing resize' }).toBeGreaterThan(10);
        await host.setViewportSize(originalViewport);
        await expect.poll(async () => Math.abs((await picture(host)).width - originalPicture.width),
          { message: 'restore the original picture width before sending the interaction' }).toBeLessThan(2);
        return originalPicture;
      });
      for (const page of [host, guest]) {
        await installObserver(page);
        expect(await page.evaluate(() => window.__interactionProbe.before.rate)).toBe(1.25);
      }
      inspectProductPrewarm(pair);
      await placeQuestion(guest);
      const hostEvent = await requireInteractionFrame(host);
      if (beforeResize) {
        // Resize immediately after the host's first observed pixels, before inspecting the guest.
        await host.setViewportSize(resizeViewport);
        await requireInteractionFrame(host, { resizedFrom: beforeResize.width });
      }
      const guestEvent = await requireInteractionFrame(guest);
      expect(guestEvent.id).toBe(hostEvent.id);
      for (const [peer, event] of [['host', hostEvent], ['guest', guestEvent]]) {
        const asset = pair.catalogs[peer].find(asset => asset.id === 'question');
        expect(event).toMatchObject({ assetId: asset.id, assetRevision: asset.revision, durationMs: asset.durationMs });
      }
      await screenshot(host, testInfo, `effect-${playing ? 'playing' : 'paused-resized'}`);
      await requireOriginalExpiry(host, hostEvent);
      await requireOriginalExpiry(guest, guestEvent);
      const probes = [];
      for (const page of [host, guest]) probes.push(await page.evaluate(() => {
        window.__interactionProbe.done = true;
        return window.__interactionProbe;
      }));
      expect(Object.keys(probes[0].effects)).toEqual(Object.keys(probes[1].effects));
      for (const probe of probes) {
        expect(Object.values(probe.events), 'interaction must not load, seek, toggle play or change rate').toEqual(Object.values(probe.events).map(() => 0));
        for (const sample of probe.snapshots) {
          expect(sample.src).toBe(probe.before.src);
          expect(sample.currentSrc).toBe(probe.before.currentSrc);
          expect(sample.paused).toBe(!playing);
          expect(sample.rate).toBe(1.25);
          const expectedTime = probe.before.time + (playing ? (sample.at - probe.before.at) / 1000 * 1.25 : 0);
          expect(Math.abs(sample.time - expectedTime)).toBeLessThan(playing ? 0.4 : 0.02);
        }
        const effect = Object.values(probe.effects)[0];
        expect(effect.removed - effect.added).toBeLessThanOrEqual(3000);
        expect(effect.samples.some(sample => sample.visible > 50 && sample.transparent > 50)).toBe(true);
        // Ignore only the single layout-transition sample; require stable geometry before and after resize.
        const stable = effect.samples.filter(sample => sample.overlayError <= 2);
        expect(stable.length).toBeGreaterThan(5);
        for (const sample of stable) {
          expect(Math.abs(sample.x - point.x)).toBeLessThan(0.015);
          expect(Math.abs(sample.y - point.y)).toBeLessThan(0.015);
        }
        expect(effect.samples.filter(sample => sample.overlayError > 2).length).toBeLessThanOrEqual(2);
      }
      if (beforeResize) {
        const hostSamples = Object.values(probes[0].effects)[0].samples.filter(sample => sample.overlayError <= 2);
        expect(hostSamples.some(sample => Math.abs(sample.width - beforeResize.width) < 2)).toBe(true);
        expect(hostSamples.some(sample => Math.abs(sample.width - beforeResize.width) > 10)).toBe(true);
      }
      await testInfo.attach('interaction-observations', { body: Buffer.from(JSON.stringify(probes, null, 2)), contentType: 'application/json' });
      expect(pair.errors).toEqual([]);
    } finally {
      try {
        await attachDelivery(pair, testInfo);
        for (const [name, page] of [['host', host], ['guest', guest]]) {
          const probe = await page.evaluate(() => window.__interactionProbe || null).catch(() => null);
          if (probe) {
            const compactState = state => state ? {
              at: state.at, wallTime: state.wallTime, hidden: state.hidden, sourceId: state.sourceId,
              connected: state.connected, paused: state.paused, rate: state.rate, time: state.time,
            } : null;
            const finalPage = await page.evaluate(() => ({
              access: document.body.dataset.roomAccess,
              enabled: document.querySelector('[data-interaction-enabled]')?.checked,
              hidden: document.hidden,
              readyState: document.querySelector('[data-room-video]')?.readyState,
            })).catch(() => null);
            // At most one bounded line per peer; full pixel/media history stays in the attachment.
            console.log('[interactions lifecycle] ' + JSON.stringify({
              mode: playing ? 'playing' : 'paused', peer: name,
              before: compactState(probe.before), last: compactState(probe.snapshots.at(-1)),
              mediaEvents: probe.events, visibility: probe.visibility.slice(-4).map(compactState), finalPage,
              effects: Object.entries(probe.effects).slice(0, 8).map(([id, effect]) => ({
                id, added: effect.added, removed: effect.removed,
                addedState: compactState(effect.addedState), removedState: compactState(effect.removedState),
                samples: effect.samples.length,
                visibleSamples: effect.samples.filter(sample => sample.visible > 50 && sample.transparent > 50).length,
              })),
            }));
            await testInfo.attach(`${name}-final-probe`, { body: Buffer.from(JSON.stringify(probe, null, 2)), contentType: 'application/json' });
          }
        }
        await screenshot(host, testInfo, `host-${playing ? 'playing' : 'paused'}`);
        await screenshot(guest, testInfo, `guest-${playing ? 'playing' : 'paused'}`);
      } finally {
        await closeRoomContexts(pair);
      }
    }
  });
}

test('first-source interactions survive a rejected periodic ACK while authority remains paused', async ({ browser, baseURL }, testInfo) => {
  const pair = await roomPair(browser, baseURL, { probeContext: true });
  const { hostPage: host, guestPage: guest } = pair;
  const peers = [['host', host], ['guest', guest]];
  let activation;
  let rejectedAck;
  try {
    const sourceId = await host.locator('[data-room-video]').getAttribute('data-source-id');
    expect(sourceId).toBeTruthy();
    await expect.poll(() => pair.playback.host?.sourceId).toBe(sourceId);
    activation = { ...pair.playback.host };
    expect(activation.playing).toBe(false);
    for (const [, page] of peers) {
      await setAutoSync(page, false);
      const context = await page.evaluate(() => window.__readInteractionContext());
      expect(context).toMatchObject({ connected: true, sourceId, localSourceId: sourceId });
      await expect.poll(() => page.locator('[data-room-video]').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(3);
      // Prewarm can legitimately inspect the empty context before first-source activation.
      // The rollback invariant starts here, before native play and the rejected ACK.
      await page.evaluate(() => { window.__interactionContextHistory.length = 0; window.__readInteractionContext(); });
    }
    const ackStart = pair.playbackAcks.host.length;
    // Deliberately recreate the original mismatch: native play, with no room user-action event.
    // Keep the authority paused; the real periodic timer must produce the rejection itself.
    for (const [, page] of peers) {
      await page.locator('[data-room-video]').evaluate(async video => {
        video.muted = true;
        video.playbackRate = 1.25;
        await video.play();
      });
    }
    await expect.poll(() => {
      rejectedAck = pair.playbackAcks.host.slice(ackStart).find(ack =>
        ack.request.action === 'periodic' && ack.decision.action === 'periodic' && ack.decision.accepted === false);
      return Boolean(rejectedAck);
    }, { timeout: 10_000, message: 'observe a real rejected periodic ACK, not an injected state' }).toBe(true);
    expect(rejectedAck.request).toMatchObject({ sourceId, playing: true, ready: true, seeking: false,
      baseRevision: activation.revision });
    expect(rejectedAck.playback).toMatchObject({ sourceId, playing: false, revision: activation.revision });
    expect(rejectedAck.decision).toMatchObject({ baseRevision: activation.revision, nextRevision: activation.revision });
    expect(pair.playbackAcks.host.slice(ackStart).some(ack => ack.decision.accepted === true)).toBe(false);
    // Let the page process both its ACK callback and the subsequent playback_state event.
    await host.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (const [, page] of peers) {
      const context = await page.evaluate(() => window.__readInteractionContext());
      expect(context, 'rejected periodic ACK must not restore the empty-room source').toMatchObject({
        connected: true, sourceId, localSourceId: sourceId,
      });
      expect(await page.evaluate(() => document.hidden)).toBe(false);
      expect(await page.locator('[data-room-video]').evaluate(video => video.paused)).toBe(false);
      await installObserver(page);
    }
    await guest.locator('[data-page-fullscreen]').click();
    await expect(guest.locator(shellSelector)).toHaveClass(/\bis-page-fullscreen\b/);
    await placeQuestion(guest);
    const hostEvent = await requireInteractionFrame(host);
    const guestEvent = await requireInteractionFrame(guest);
    expect(guestEvent.id).toBe(hostEvent.id);
    for (const [peer, page] of peers) {
      await requireOriginalExpiry(page, peer === 'host' ? hostEvent : guestEvent);
      const effect = await page.evaluate(() => Object.values(window.__interactionProbe.effects)[0]);
      expect(effect.removed - effect.added).toBeLessThanOrEqual(3000);
      expect(await page.evaluate(() => window.__readInteractionContext())).toMatchObject({
        connected: true, sourceId, localSourceId: sourceId,
      });
      expect(await page.evaluate(() => window.__interactionContextHistory.every(state => state.sourceId && state.sourceId === state.localSourceId)),
        `${peer} context must never roll back to an empty source during the reproduction`).toBe(true);
      expect(pair.playback[peer]).toMatchObject({ playing: false, sourceId, revision: activation.revision });
    }
    const hostIds = await host.evaluate(() => Object.keys(window.__interactionProbe.effects));
    expect(await guest.evaluate(() => Object.keys(window.__interactionProbe.effects))).toEqual(hostIds);
    expect(activation.revision).toBe(pair.emptyPlayback.revision + 1);
    expect(activation.updatedAt).toBeGreaterThan(pair.emptyPlayback.updatedAt);
    expect(pair.errors).toEqual([]);
  } finally {
    try {
      await attachDelivery(pair, testInfo);
      const contexts = {};
      for (const [peer, page] of peers) contexts[peer] = await page.evaluate(() => ({
        current: window.__readInteractionContext?.(), history: window.__interactionContextHistory,
        observations: window.__interactionProbe,
      })).catch(() => null);
      console.log('[interaction rejected periodic] ' + JSON.stringify({ activation, rejectedAck,
        hostContext: contexts.host?.current, guestContext: contexts.guest?.current }));
      await testInfo.attach('rejected-periodic-source-context', { contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ emptyPlayback: pair.emptyPlayback, activation,
          acks: pair.playbackAcks, rejectedAck, contexts }, null, 2)) });
    } finally {
      await closeRoomContexts(pair);
    }
  }
});

test('disabling effects locally drops real room broadcasts without disabling another member', async ({ browser, baseURL }, testInfo) => {
  const pair = await roomPair(browser, baseURL);
  const { hostPage: host, guestPage: guest } = pair;
  try {
    for (const page of [host, guest]) {
      await setAutoSync(page, false);
      await page.locator('[data-room-video]').evaluate(video => video.pause());
      await page.locator(shellSelector).scrollIntoViewIfNeeded();
    }
    await host.locator('[data-interaction-toggle]').click();
    await host.locator('[data-interaction-enabled]').uncheck();
    await expect(host.locator('#interactionPopover')).toBeVisible();
    await host.locator('[data-interaction-close]').click();
    await expect(host.locator('#interactionPopover')).toBeHidden();
    for (const page of [host, guest]) await installObserver(page);
    await guest.locator('[data-page-fullscreen]').click();
    await expect(guest.locator(shellSelector)).toHaveClass(/\bis-page-fullscreen\b/);
    await placeQuestion(guest);
    const event = await requireInteractionFrame(guest);
    await requireOriginalExpiry(guest, event);
    await expect.poll(() => host.evaluate(id => window.__interactionDelivery.received.some(event => event.id === id), event.id),
      { timeout: 4000, message: 'disabled peer must receive the real broadcast before its absence can prove local filtering' }).toBe(true);
    // Observe the entire broadcast lifetime, not just an immediate zero-count assertion.
    expect(await host.evaluate(() => Object.keys(window.__interactionProbe.effects))).toEqual([]);
    await expect(host.locator(effectsSelector)).toHaveCount(0);
    expect(await host.evaluate(() => localStorage.getItem('together-see:interactions'))).toBe('off');
    await screenshot(host, testInfo, 'real-room-effects-disabled');
    expect(pair.errors).toEqual([]);
  } finally {
    try { await attachDelivery(pair, testInfo); } finally { await closeRoomContexts(pair); }
  }
});

async function assertControlsLayout(page) {
  const issues = await page.locator('[data-player-controls]').evaluate(controls => {
    const visible = node => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    };
    const nodes = [...controls.querySelectorAll('.controls-row button, .controls-row input, .controls-row [data-player-playback-status]')].filter(visible);
    const issues = [];
    const label = node => node.getAttribute('aria-label') || node.outerHTML.slice(0, 100);
    const clip = controls.closest('[data-player-shell]').getBoundingClientRect();
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i], box = node.getBoundingClientRect();
      if (box.left < clip.left - 1 || box.right > clip.right + 1 || box.bottom > clip.bottom + 1) issues.push(`outside player: ${label(node)}`);
      for (const other of nodes.slice(i + 1)) {
        const b = other.getBoundingClientRect();
        if (Math.min(box.right, b.right) - Math.max(box.left, b.left) > 1 && Math.min(box.bottom, b.bottom) - Math.max(box.top, b.top) > 1) {
          issues.push(`overlap: ${label(node)} / ${label(other)}`);
        }
      }
      const icon = node.querySelector(':scope > svg');
      if (icon) {
        const svg = icon.getBoundingClientRect();
        if (Math.abs(svg.left + svg.width / 2 - box.left - box.width / 2) > 2 || Math.abs(svg.top + svg.height / 2 - box.top - box.height / 2) > 2) {
          issues.push(`off-center icon: ${label(node)}`);
        }
      }
    }
    return issues;
  });
  expect(issues).toEqual([]);
  await expect(page.locator('[data-interaction-toggle]')).toBeVisible();
}

test('toolbox controls remain usable on desktop, iPad-sized, mobile and fullscreen layouts', async ({ browser, baseURL }, testInfo) => {
  const pair = await roomPair(browser, baseURL);
  try {
    for (const [name, page, viewport] of [
      ['desktop', pair.hostPage, { width: 1440, height: 900 }],
      ['ipad', pair.hostPage, { width: 1024, height: 1366 }],
      ['mobile', pair.guestPage, null],
    ]) {
      if (viewport) await page.setViewportSize(viewport);
      await setAutoSync(page, false);
      await page.locator('[data-room-video]').evaluate(video => video.pause());
      await page.locator(shellSelector).scrollIntoViewIfNeeded();
      for (const fullscreen of [false, true]) {
        if (fullscreen) {
          await page.locator('[data-page-fullscreen]').click();
          await expect(page.locator(shellSelector)).toHaveClass(/\bis-page-fullscreen\b/);
        }
        await screenshot(page, testInfo, `${name}-${fullscreen ? 'fullscreen' : 'inline'}`);
        await assertControlsLayout(page);
        const beforeKeyboard = await page.locator('[data-room-video]').evaluate(video => ({ time: video.currentTime, paused: video.paused, rate: video.playbackRate }));
        await page.locator('[data-interaction-toggle]').press('Space');
        const popover = page.locator('#interactionPopover');
        await expect(popover).toBeVisible();
        if (await page.locator('[data-interaction-group-tab="other"]').isVisible()) await page.locator('[data-interaction-group-tab="other"]').click();
        await expect(page.locator('[data-interaction-asset="question"]')).toBeVisible();
        const geometry = await popover.evaluate(node => {
          const b = node.getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + 8);
          const first = [...node.querySelectorAll('.interaction-assets > button')].find(button => button.getClientRects().length)?.getBoundingClientRect();
          const left = b.left + node.clientLeft, top = b.top + node.clientTop;
          return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, viewport: innerWidth,
            firstFullyVisible: Boolean(first && first.width > 0 && first.height > 0
              && first.left >= left - 1 && first.right <= left + node.clientWidth + 1
              && first.top >= top - 1 && first.bottom <= top + node.clientHeight + 1),
            clippedTop: b.top < 0 || b.bottom > innerHeight, modal: node.matches(':modal'), hit: !!hit && node.contains(hit) };
        });
        await screenshot(page, testInfo, `${name}-${fullscreen ? 'fullscreen' : 'inline'}-toolbox`);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
        expect(geometry.top).toBeGreaterThanOrEqual(0);
        expect(geometry.clippedTop, 'toolbox must not be clipped by the player').toBe(false);
        expect(geometry.modal, 'fixed menu must use the top layer, not the video gesture surface').toBe(true);
        expect(geometry.hit, 'toolbox header must pass hit testing').toBe(true);
        expect(geometry.firstFullyVisible, 'first asset must fit entirely inside the popover scroll viewport without scrolling').toBe(true);
        await page.locator('[data-interaction-close]').click();
        await expect(popover).toBeHidden();
        await page.locator('[data-interaction-toggle]').press('Space');
        await page.locator('[data-interaction-asset="question"]').press('Space');
        await expect(page.locator(shellSelector)).toHaveClass(/\bis-interaction-placing\b/);
        await expect(page.locator('[data-player-center-play]')).toBeHidden();
        const pictureCenter = await picture(page);
        expect(await page.evaluate(({ left, top, width, height }) => {
          const hit = document.elementFromPoint(left + width / 2, top + height / 2);
          return Boolean(hit?.closest('[data-player-shell]')) && !hit.closest('[data-player-center-play]');
        }, pictureCenter), 'center play must not intercept placement').toBe(true);
        const afterKeyboard = await page.locator('[data-room-video]').evaluate(video => ({ time: video.currentTime, paused: video.paused, rate: video.playbackRate }));
        expect(beforeKeyboard.paused).toBe(true);
        expect(afterKeyboard.paused).toBe(true);
        expect(afterKeyboard.rate).toBe(beforeKeyboard.rate);
        expect(Math.abs(afterKeyboard.time - beforeKeyboard.time)).toBeLessThan(0.02);
        await page.keyboard.press('Escape');
        await expect(page.locator(shellSelector)).not.toHaveClass(/\bis-interaction-placing\b/);
        await expect(page.locator('.interaction-placement-cancel')).toBeHidden();
        await expect(page.locator(effectsSelector)).toHaveCount(0);
        // Escape may also exit page fullscreen; use its actual state rather than toggling blindly.
        if ((await page.locator(shellSelector).getAttribute('class')).includes('is-page-fullscreen')) {
          await page.locator('[data-page-fullscreen]').click();
        }
      }
    }
    await pair.hostPage.setViewportSize({ width: 1440, height: 900 });
    await pair.hostPage.locator('[data-player-fullscreen]').click();
    await expect.poll(() => pair.hostPage.evaluate(() => document.fullscreenElement?.matches('[data-player-shell]') || false)).toBe(true);
    await screenshot(pair.hostPage, testInfo, 'desktop-native-fullscreen');
    await assertControlsLayout(pair.hostPage);
    await pair.hostPage.locator('[data-interaction-toggle]').click();
    await expect.poll(() => pair.hostPage.locator('#interactionPopover').evaluate(node => node.matches(':modal'))).toBe(true);
    await pair.hostPage.locator('[data-interaction-group-tab="other"]').click();
    await pair.hostPage.locator('[data-interaction-asset="question"]').click();
    await expect(pair.hostPage.locator('#interactionPopover')).toBeHidden();
    await pair.hostPage.locator('.interaction-placement-cancel').click();
    await pair.hostPage.evaluate(() => document.exitFullscreen());
    expect(pair.errors).toEqual([]);
  } finally {
    await closeRoomContexts(pair);
  }
});

async function harness(page, baseURL, { authorizedAudio = false, controlledClock = false, warmup = false } = {}) {
  if (controlledClock) await page.clock.install({ time: new Date('2026-09-28T12:00:00Z') });
  const url = new URL('/__interaction_e2e_harness__', baseURL).href;
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <html><body><div data-player-shell style="position:relative;width:800px;height:500px">
    <video data-room-video style="width:800px;height:500px;object-fit:contain"></video>
    <div data-interaction-layer style="position:absolute"></div><div data-player-controls>
    <button data-interaction-toggle>Toolbox</button></div></div>
    <style>[data-interaction-layer],.interaction-effect{pointer-events:none}
    .interaction-effect{position:absolute;transform:translate(-50%,-50%)}[hidden]{display:none!important}</style>
    </body></html>` }));
  await page.goto(url);
  const catalog = await page.evaluate(async () => {
    const response = await fetch('/api/interactions', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Harness catalog request failed: ${response.status}`);
    return response.json();
  });
  expect(catalog.version).toBe(1);
  const asset = catalog.items.find(item => item.id === 'question');
  expect(asset?.revision).toMatch(/^[a-f0-9]{16}$/);
  await page.addScriptTag({ url: new URL('/assets/js/interactions.js', baseURL).href });
  await page.evaluate(({ asset, authorizedAudio, warmup }) => {
    const video = document.querySelector('video');
    Object.defineProperties(video, { videoWidth: { value: 1280 }, videoHeight: { value: 720 } });
    window.__h = { now: 10000, hidden: false, sent: [], audioStarts: 0, audioStops: 0, audioDecodes: 0, audioStartCalls: [], resumeAttempts: 0, asset,
      decodedAudio: { duration: 2.1, length: 92610, numberOfChannels: 2 },
      mediaReadyState: 0, health: { readyForAuthority: true, buffering: true, bufferedAhead: 8 },
      connected: true, sourceId: 'source-current', localSourceId: 'source-current' };
    if (warmup) Object.defineProperties(video, {
      src: { get: () => '/__warmup_main_fixture__' },
      readyState: { get: () => window.__h.mediaReadyState },
      seeking: { get: () => false }, ended: { get: () => false },
    });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__h.hidden });
    class TestAudioContext {
      state = authorizedAudio ? 'running' : 'suspended';
      resume() { window.__h.resumeAttempts++; return Promise.reject(new DOMException('No audio authorization', 'NotAllowedError')); }
      decodeAudioData() {
        window.__h.audioDecodes++;
        const buffer = { ...window.__h.decodedAudio };
        if (window.__h.holdNextDecode) {
          window.__h.holdNextDecode = false;
          return new Promise(resolve => { window.__h.releaseDecode = () => resolve(buffer); });
        }
        return Promise.resolve(buffer);
      }
      createBufferSource() {
        if (!authorizedAudio) { window.__h.audioStarts++; throw new Error('Audio must not start without authorization'); }
        let stopped = false;
        return {
          connect: node => node, disconnect() {},
          start(when, offset, duration) {
            window.__h.audioStarts++;
            window.__h.audioStartCalls.push({ when, offset, duration, at: performance.now() });
          },
          stop() {
            if (stopped) return;
            stopped = true;
            window.__h.audioStops++;
            queueMicrotask(() => this.onended?.());
          },
        };
      }
      createGain() { return { gain: { value: 1 }, connect: node => node, disconnect() {} }; }
    }
    window.AudioContext = TestAudioContext;
    window.webkitAudioContext = TestAudioContext;
    window.__interaction = window.TogetherSeeInteractions.create({ player: { video,
      ...(warmup ? { getPlaybackHealth: () => window.__h.health } : {}) },
      getContext: () => window.__h, send: payload => { window.__h.sent.push(payload); return Promise.resolve({ ok: true }); },
      showToast: () => {} });
  }, { asset, authorizedAudio, warmup });
  await page.evaluate(() => window.__interaction.refreshCatalog());
  await expect(page.locator('[data-interaction-asset="question"]')).toHaveCount(1);
  if (controlledClock) await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  return asset;
}

async function show(page, id, overrides = {}) {
  await page.evaluate(async ({ id, overrides }) => window.__interaction.show({
    id, assetId: 'question', sourceId: 'source-current', x: 0.4, y: 0.4,
    assetRevision: window.__h.asset.revision,
    sentAt: window.__h.now - 500, durationMs: window.__h.asset.durationMs, ...overrides,
  }), { id, overrides });
}

test('DOM harness drops expired, duplicate, stale-source and hidden events; locked audio does not suppress visuals', async ({ page, baseURL }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await harness(page, baseURL, { controlledClock: true });
  await page.locator('[data-interaction-toggle]').click();
  await page.locator('[data-interaction-close]').click();
  await show(page, 'expired', { sentAt: 7000 });
  await show(page, 'stale-source', { sourceId: 'source-old' });
  await show(page, 'future', { sentAt: 12000 });
  await show(page, 'missing-revision', { assetRevision: null });
  const staleRevision = await page.evaluate(() => (window.__h.asset.revision[0] === '0' ? '1' : '0') + window.__h.asset.revision.slice(1));
  await show(page, 'stale-revision', { assetRevision: staleRevision });
  await page.evaluate(() => { window.__h.localSourceId = 'source-loading'; });
  await show(page, 'local-source-mismatch');
  await page.evaluate(() => { window.__h.localSourceId = 'source-current'; window.__h.connected = false; });
  await show(page, 'disconnected');
  await page.evaluate(() => { window.__h.connected = true; window.__h.hidden = true; });
  await show(page, 'hidden');
  await page.evaluate(() => { window.__h.hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator(effectsSelector)).toHaveCount(0);

  await show(page, 'visible-no-audio');
  await show(page, 'visible-no-audio');
  await expect(page.locator(effectsSelector)).toHaveCount(1);
  const alpha = await page.locator(effectsSelector).evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return { visible: data.some((value, i) => i % 4 === 3 && value > 8), transparent: data.some((value, i) => i % 4 === 3 && value === 0) };
  });
  expect(alpha).toEqual({ visible: true, transparent: true });
  expect(await page.evaluate(() => window.__h.resumeAttempts)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__h.audioStarts)).toBe(0);
  await screenshot(page, testInfo, 'harness-audio-locked-visual');
  await page.clock.runFor(3000);
  await expect(page.locator(effectsSelector)).toHaveCount(0);
  await show(page, 'visible-no-audio', { sentAt: 10000 });
  await expect(page.locator(effectsSelector)).toHaveCount(0);

  await show(page, 'hide-active');
  await expect(page.locator(effectsSelector)).toHaveCount(1);
  await page.evaluate(() => { window.__h.hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator(effectsSelector)).toHaveCount(0);
  await page.evaluate(() => { window.__h.hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator(effectsSelector)).toHaveCount(0);

  await show(page, 'disable-active');
  await expect(page.locator(effectsSelector)).toHaveCount(1);
  await page.locator('[data-interaction-toggle]').click();
  await page.locator('[data-interaction-enabled]').uncheck();
  await expect(page.locator(effectsSelector)).toHaveCount(0);
  await show(page, 'disabled-incoming');
  await expect(page.locator(effectsSelector)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('together-see:interactions'))).toBe('off');
  await expect(page.locator('#interactionPopover')).toBeVisible();
  await page.locator('[data-interaction-enabled]').check();
  await page.locator('[data-interaction-close]').click();
  await chooseQuestion(page);
  await page.keyboard.press('Escape');
  await page.locator('[data-room-video]').click({ position: { x: 300, y: 200 } });
  expect(await page.evaluate(() => window.__h.sent)).toEqual([]);
  expect(errors).toEqual([]);
});

async function warmupHarness(page, baseURL, definitions) {
  const poster = '/assets/interactions/question/poster.png';
  const response = await page.request.get(new URL(poster, baseURL).href);
  expect(response.ok()).toBe(true);
  const bytes = await response.body();
  const items = definitions.map(({ id, ...overrides }) => ({
    id, label: id, revision: 'fedcba9876543210', type: 'sprite', durationMs: 2100,
    src: `/assets/interactions/prewarm-test/${id}.png`, poster,
    audio: `/assets/interactions/prewarm-test/${id}.wav`,
    width: 168, height: 320, columns: 1, frames: 1, visualBytes: 300000, ...overrides,
  }));
  let catalog = items;
  await page.route(new URL('/api/interactions', baseURL).href, route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ version: 1, items: catalog }),
  }));
  const requests = [], releases = new Map(), flights = new Set();
  const pattern = new URL('/assets/interactions/prewarm-test/**', baseURL).href;
  await page.route(pattern, route => {
    const task = (async () => {
      const name = new URL(route.request().url()).pathname.split('/').at(-1);
      requests.push(name);
      const status = await new Promise(resolve => { releases.set(name, resolve); });
      await route.fulfill({ status, contentType: 'image/png', body: status === 200 ? bytes : Buffer.alloc(0) });
    })();
    flights.add(task);
    void task.finally(() => flights.delete(task)).catch(() => {});
    return task;
  });
  await installContextProbe(page.context());
  await harness(page, baseURL, { controlledClock: true, warmup: true });
  await installObserver(page);
  return { items, requests,
    setCatalog: next => { catalog = next; },
    release: (name, status = 200) => { expect(releases.has(name)).toBe(true); releases.get(name)(status); },
    async close() {
      for (const release of releases.values()) release(200);
      await Promise.allSettled([...flights]);
      await page.unroute(pattern);
    },
  };
}

test('product prewarm defers to foreground buffering and cancels pending or stale work on hide and clear', async ({ page, baseURL }) => {
  const h = await warmupHarness(page, baseURL, [{ id: 'question' }, { id: 'second' }, { id: 'third' }]);
  try {
    await page.evaluate(() => {
      window.__h.mediaReadyState = 3;
      document.querySelector('video').dispatchEvent(new Event('loadeddata'));
    });
    await page.clock.runFor(512);
    expect(h.requests, 'readyState=3 and eight seconds buffered must not override buffering=true').toEqual([]);
    await page.evaluate(() => {
      window.__h.health.buffering = false;
      window.dispatchEvent(new CustomEvent('together-see:player-buffering-change', { detail: { buffering: false } }));
    });
    await page.clock.runFor(128);
    await page.evaluate(() => {
      window.__h.health.buffering = true;
      window.dispatchEvent(new CustomEvent('together-see:player-buffering-change', { detail: { buffering: true } }));
    });
    await page.clock.runFor(512);
    expect(h.requests).toEqual([]);
    await page.evaluate(() => {
      window.__h.health.buffering = false;
      document.querySelector('video').dispatchEvent(new Event('canplay'));
    });
    await page.clock.runFor(128);
    await page.evaluate(() => { window.__h.hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    await page.clock.runFor(512);
    expect(h.requests).toEqual([]);
    await page.evaluate(() => { window.__h.hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await page.clock.runFor(128);
    await page.evaluate(() => window.__interaction.clear());
    await page.clock.runFor(512);
    expect(h.requests).toEqual([]);
    // Catalog was ready before media; the real progress listener now triggers one cold request.
    await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('progress')));
    await page.clock.runFor(256);
    await expect.poll(() => h.requests.slice()).toEqual(['question.png']);
    await page.evaluate(() => {
      window.__h.hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
      window.__interaction.clear();
    });
    // Reopen the guard without a new trigger BEFORE completion, isolating generation cancellation.
    await page.evaluate(() => { window.__h.hidden = false; });
    h.release('question.png');
    await expect.poll(() => page.evaluate(() => window.__interactionDelivery.images.filter(image => image.type === 'load').length)).toBe(1);
    // The old generation must not chain another warmup or render anything.
    await page.clock.runFor(1024);
    expect(h.requests).toEqual(['question.png']);
    expect(await page.evaluate(() => Object.keys(window.__interactionProbe.effects))).toEqual([]);
    expect(await page.evaluate(() => window.__h.audioStarts)).toBe(0);
    const probe = await page.evaluate(() => window.__interactionProbe);
    for (const event of ['pause', 'play', 'seeking', 'seeked', 'loadstart', 'emptied']) expect(probe.events[event]).toBe(0);
    expect(probe.snapshots.every(sample => sample.paused === probe.before.paused && sample.time === probe.before.time)).toBe(true);
  } finally { await h.close(); }
});

test('product prewarm is serial and bounded across failures, source changes and catalogs without warming audio or video', async ({ page, baseURL }) => {
  const h = await warmupHarness(page, baseURL, [
    { id: 'question', visualBytes: 900000 },
    { id: 'missing', visualBytes: undefined }, { id: 'oversized', visualBytes: 1024 * 1024 + 1 },
    { id: 'fractional', visualBytes: 1.5 }, { id: 'zero', visualBytes: 0 },
    { id: 'video', type: 'video', src: '/assets/interactions/prewarm-test/video.webm' },
    { id: 'second', visualBytes: 1024 * 1024 }, { id: 'third', visualBytes: 1 },
  ]);
  try {
    // Media is ready before this changed catalog response; no manual image fetch or media event.
    await page.evaluate(() => { window.__h.mediaReadyState = 3; window.__h.health.buffering = false; });
    h.setCatalog(h.items.map(asset => ({ ...asset, label: `${asset.label} updated` })));
    await page.evaluate(() => window.__interaction.refreshCatalog());
    await page.clock.runFor(256);
    await expect.poll(() => h.requests.slice()).toEqual(['question.png']);
    await page.clock.runFor(1024);
    expect(h.requests, 'second image cannot start while the first is pending').toEqual(['question.png']);
    h.release('question.png', 503);
    await expect.poll(() => page.evaluate(() => window.__interactionDelivery.images.filter(image => image.type === 'error').length)).toBe(1);
    await page.clock.runFor(256);
    await expect.poll(() => h.requests.slice()).toEqual(['question.png', 'second.png']);
    h.release('second.png');
    await expect.poll(() => page.evaluate(() => window.__interactionDelivery.images.filter(image => image.type === 'load').length)).toBe(1);
    await page.clock.runFor(1024);
    await page.evaluate(() => {
      window.__interaction.clear();
      window.__h.sourceId = window.__h.localSourceId = 'source-new';
      document.querySelector('video').dispatchEvent(new Event('canplay'));
    });
    h.setCatalog(h.items.map(asset => ({ ...asset, label: `${asset.label} another catalog` })));
    await page.evaluate(() => window.__interaction.refreshCatalog());
    await page.clock.runFor(1024);
    expect(h.requests, 'failure consumes one attempt; clear/source/catalog changes do not reset the page budget')
      .toEqual(['question.png', 'second.png']);
    expect(900000 + 1024 * 1024).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(h.requests.some(name => /\.(wav|webm)$/.test(name))).toBe(false);
    // The warmed image must be reused, but a hot cache cannot renew an event's original TTL.
    const receivedAt = await page.evaluate(() => performance.now());
    await show(page, 'warm-reuse', { assetId: 'second', sourceId: 'source-new', sentAt: 8000 });
    await page.clock.runFor(64);
    expect(await observedVisible(page)).toBe(true);
    await page.clock.runFor(64);
    await expect(page.locator(effectsSelector)).toHaveCount(0);
    const effect = await page.evaluate(() => window.__interactionProbe.effects['warm-reuse']);
    expect(effect.removed - receivedAt).toBeGreaterThanOrEqual(100);
    expect(effect.removed - receivedAt).toBeLessThanOrEqual(132);
    await show(page, 'hot-but-expired', { assetId: 'second', sourceId: 'source-new', sentAt: 7000 });
    await page.clock.runFor(64);
    expect(await page.evaluate(() => window.__interactionProbe.effects['hot-but-expired'])).toBeUndefined();
    expect(h.requests).toEqual(['question.png', 'second.png']);
    expect(await page.evaluate(() => window.__h.audioStarts)).toBe(0);
  } finally { await h.close(); }
});

for (const boundary of ['before', 'at', 'after']) {
  test(`DOM harness cold image ready ${boundary} the original expiry obeys visual and sound lifetime`, async ({ page, baseURL }, testInfo) => {
    // Fetch fixture bytes outside the browser cache; gate the browser's very first image request.
    const catalogResponse = await page.request.get(new URL('/api/interactions', baseURL).href);
    expect(catalogResponse.ok()).toBe(true);
    const asset = (await catalogResponse.json()).items.find(item => item.id === 'question');
    expect(asset.type).toBe('sprite');
    expect(asset.audio).toBeTruthy();
    const imageUrl = new URL(asset.src, baseURL);
    imageUrl.searchParams.set('v', asset.revision);
    const imageResponse = await page.request.get(imageUrl.href);
    expect(imageResponse.ok()).toBe(true);
    const imageBytes = await imageResponse.body();
    let release;
    let requests = 0;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(imageUrl.href, async route => {
      requests++;
      await gate;
      await route.fulfill({ status: 200, contentType: 'image/png', body: imageBytes });
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await harness(page, baseURL, { authorizedAudio: true, controlledClock: true });
      await page.locator('[data-interaction-toggle]').click();
      await page.locator('[data-interaction-close]').click();
      await installObserver(page);
      const receivedAge = 500;
      const remaining = asset.durationMs - receivedAge;
      expect(remaining).toBeGreaterThan(700);
      const delay = remaining + (boundary === 'before' ? -640 : boundary === 'after' ? 64 : 0);
      const receivedAt = await page.evaluate(({ receivedAge, durationMs }) => {
        const at = performance.now();
        window.__pendingShow = window.__interaction.show({ id: 'cold-contract', assetId: 'question',
          assetRevision: window.__h.asset.revision, sourceId: 'source-current', x: 0.4, y: 0.4,
          sentAt: window.__h.now - receivedAge, durationMs });
        return at;
      }, { receivedAge, durationMs: asset.durationMs });
      await expect.poll(() => requests).toBe(1);
      await page.clock.runFor(delay);
      expect(await page.evaluate(() => Object.keys(window.__interactionProbe.effects))).toEqual([]);
      expect(await page.evaluate(() => window.__h.audioStarts)).toBe(0);
      expect(await page.evaluate(() => window.__h.now)).toBe(10000);
      release();
      await page.evaluate(() => window.__pendingShow);
      const readyAt = await page.evaluate(() => performance.now());
      expect(readyAt).toBe(receivedAt + delay);
      if (boundary === 'before') {
        await expect(page.locator(effectsSelector)).toHaveCount(1);
        await expect.poll(() => page.evaluate(() => window.__h.audioStarts)).toBe(1);
        await page.clock.runFor(64);
        expect(await observedVisible(page)).toBe(true);
        const sound = await page.evaluate(() => window.__h.audioStartCalls[0]);
        expect(sound.offset).toBeCloseTo((receivedAge + delay) / 1000, 3);
        expect(sound.duration).toBeCloseTo((remaining - delay) / 1000, 3);
        await page.clock.runFor(remaining - delay - 64 - 32);
        await expect(page.locator(effectsSelector)).toHaveCount(1);
        await page.clock.runFor(64);
        await expect(page.locator(effectsSelector)).toHaveCount(0);
        const effect = await page.evaluate(() => window.__interactionProbe.effects['cold-contract']);
        expect(effect.samples.some(sample => sample.visible > 50 && sample.transparent > 50
          && sample.at < receivedAt + remaining)).toBe(true);
        expect(effect.removed - receivedAt).toBeGreaterThanOrEqual(remaining);
        expect(effect.removed - receivedAt).toBeLessThanOrEqual(remaining + 32);
        expect(effect.removed - receivedAt).toBeLessThanOrEqual(3000);
        expect(await page.evaluate(() => window.__h.audioStops)).toBe(1);
      } else {
        await page.clock.runFor(3000);
        await expect(page.locator(effectsSelector)).toHaveCount(0);
        expect(await page.evaluate(() => Object.keys(window.__interactionProbe.effects))).toEqual([]);
        expect(await page.evaluate(() => window.__h.audioStarts)).toBe(0);
      }
      expect(requests).toBe(1);
      expect(errors).toEqual([]);
      await testInfo.attach(`cold-resource-${boundary}-expiry`, { contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ receivedAt, receivedAge, remaining, delay, readyAt,
          observations: await page.evaluate(() => window.__interactionProbe),
          audio: await page.evaluate(() => ({ starts: window.__h.audioStarts, stops: window.__h.audioStops,
            calls: window.__h.audioStartCalls })),
        }, null, 2)) });
    } finally {
      release();
      await page.unroute(imageUrl.href);
    }
  });
}

test('DOM harness clear invalidates an in-flight image without suppressing subsequent events', async ({ page, baseURL }) => {
  const asset = await harness(page, baseURL, { controlledClock: true });
  const imageUrl = new URL(asset.src, baseURL);
  imageUrl.searchParams.set('v', asset.revision);
  let requested = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(imageUrl.href, async route => {
    requested = true;
    await gate;
    await route.continue();
  });
  try {
    await page.evaluate(() => {
      window.__pendingShow = window.__interaction.show({
        id: 'clear-during-image-load', assetId: 'question', assetRevision: window.__h.asset.revision,
        sourceId: 'source-current', x: 0.4, y: 0.4, sentAt: window.__h.now - 500,
        durationMs: window.__h.asset.durationMs,
      });
    });
    await expect.poll(() => requested, { timeout: 2000 }).toBe(true);
    await page.evaluate(() => window.__interaction.clear());
    release();
    await page.evaluate(() => window.__pendingShow);
    await expect(page.locator(effectsSelector)).toHaveCount(0);
    await show(page, 'new-generation');
    await expect(page.locator(effectsSelector)).toHaveCount(1);
  } finally {
    release();
    await page.unroute(imageUrl.href);
  }
});

test('DOM harness stops the active sound when its source is evicted', async ({ page, baseURL }) => {
  await harness(page, baseURL, { authorizedAudio: true, controlledClock: true });
  await page.locator('[data-interaction-toggle]').click();
  await page.locator('[data-interaction-close]').click();
  await show(page, 'audible-old-source');
  await expect(page.locator(effectsSelector)).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.__h.audioStarts)).toBe(1);
  await page.evaluate(() => {
    window.__h.sourceId = 'source-new';
    window.__h.localSourceId = 'source-new';
  });
  await page.clock.runFor(32);
  await expect(page.locator(effectsSelector)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__h.audioStops)).toBe(1);
  await show(page, 'late-old-source');
  await expect(page.locator(effectsSelector)).toHaveCount(0);
  expect(await page.evaluate(() => window.__h.audioStarts)).toBe(1);
  await show(page, 'audible-new-source', { sourceId: 'source-new' });
  await expect(page.locator(effectsSelector)).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.__h.audioStarts)).toBe(2);
  await page.evaluate(() => window.__interaction.clear());
  await expect.poll(() => page.evaluate(() => window.__h.audioStops)).toBe(2);
});

test('DOM harness keeps pixel content and relative centers aligned across resize with a controlled monotonic clock', async ({ page, baseURL }, testInfo) => {
  await harness(page, baseURL, { controlledClock: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  // Advance RAF and performance together only when sampling; real room expiry remains unchanged.
  await page.locator(shellSelector).evaluate(shell => { shell.style.width = 'min(100%, 1000px)'; });
  await page.locator('[data-room-video]').evaluate(video => { video.style.width = '100%'; });
  const before = await picture(page);
  expect(before.boxWidth - before.width, 'fixture starts with pillarboxing').toBeGreaterThan(20);
  await page.setViewportSize(resizeViewport);
  await expect.poll(async () => Math.abs((await picture(page)).width - before.width)).toBeGreaterThan(10);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => Math.abs((await picture(page)).width - before.width)).toBeLessThan(2);
  await installObserver(page);
  await show(page, 'frozen-resize', point);
  await page.clock.runFor(352);
  await expect.poll(() => page.evaluate(width => window.__interactionProbe.effects['frozen-resize']?.samples
    .filter(sample => sample.visible > 50 && sample.transparent > 50 && sample.overlayError <= 2
      && Math.abs(sample.width - width) < 2).length || 0, before.width)).toBeGreaterThan(5);
  await screenshot(page, testInfo, 'harness-resize-before');
  await page.setViewportSize(resizeViewport);
  await page.clock.runFor(352);
  await expect.poll(() => page.evaluate(width => window.__interactionProbe.effects['frozen-resize']?.samples
    .filter(sample => sample.visible > 50 && sample.transparent > 50 && sample.overlayError <= 2
      && Math.abs(sample.width - width) > 10).length || 0, before.width)).toBeGreaterThan(5);
  await screenshot(page, testInfo, 'harness-resize-after');
  const effect = await page.evaluate(() => window.__interactionProbe.effects['frozen-resize']);
  expect(effect.removed).toBeNull();
  const stable = effect.samples.filter(sample => sample.overlayError <= 2);
  expect(stable.some(sample => Math.abs(sample.width - before.width) < 2)).toBe(true);
  expect(stable.some(sample => Math.abs(sample.width - before.width) > 10)).toBe(true);
  for (const sample of stable) {
    expect(Math.abs(sample.x - point.x)).toBeLessThan(0.015);
    expect(Math.abs(sample.y - point.y)).toBeLessThan(0.015);
  }
  expect(effect.samples.filter(sample => sample.overlayError > 2).length).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => window.__h.now)).toBe(10000);
  await testInfo.attach('frozen-resize-observations', { body: Buffer.from(JSON.stringify(effect, null, 2)), contentType: 'application/json' });
  await page.clock.runFor(3000 - 704);
  await expect(page.locator(effectsSelector)).toHaveCount(0);
  const expired = await page.evaluate(() => window.__interactionProbe.effects['frozen-resize']);
  expect(expired.removed).not.toBeNull();
  expect(expired.removed - expired.added).toBeLessThanOrEqual(3000);
});

for (const direction of [-1, 1]) {
  test(`DOM harness wall clock ${direction < 0 ? 'rollback' : 'advance'} cannot change visual or audio TTL`, async ({ page, baseURL }, testInfo) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const asset = await harness(page, baseURL, { authorizedAudio: true, controlledClock: true });
    const receivedAge = 500;
    const remaining = asset.durationMs - receivedAge;
    expect(remaining).toBeGreaterThan(600);
    expect(asset.durationMs).toBeLessThanOrEqual(3000);
    await page.locator('[data-interaction-toggle]').click();
    await page.locator('[data-interaction-close]').click();
    await page.evaluate(() => {
      Object.defineProperty(window.__h, 'now', { configurable: true, get: () => Date.now() });
      window.__h.holdNextDecode = true;
    });
    await installObserver(page);
    const receivedAt = await page.evaluate(() => performance.now());
    const id = `wall-jump-${direction}`;
    await show(page, id);
    await expect.poll(() => page.evaluate(() => window.__h.audioDecodes)).toBe(1);
    await page.clock.runFor(128);
    expect(await observedVisible(page)).toBe(true);
    const wallBefore = await page.evaluate(() => Date.now());
    await page.clock.setSystemTime(wallBefore + direction * 60 * 60 * 1000);
    expect(await page.evaluate(() => performance.now())).toBe(receivedAt + 128);
    expect(await page.evaluate(() => window.__h.now)).toBe(wallBefore + direction * 60 * 60 * 1000);
    await page.clock.runFor(400);
    await expect(page.locator(effectsSelector)).toHaveCount(1);
    // A decode completing after the wall jump must still use the original monotonic audio offset.
    await page.evaluate(() => { window.__h.releaseDecode(); });
    await expect.poll(() => page.evaluate(() => window.__h.audioStarts)).toBe(1);
    const sound = await page.evaluate(() => window.__h.audioStartCalls[0]);
    expect(sound.offset).toBeCloseTo((receivedAge + 528) / 1000, 3);
    expect(sound.duration).toBeCloseTo(Math.min(2.1, asset.durationMs / 1000) - sound.offset, 3);
    await page.clock.runFor(remaining - 528 - 32);
    await expect(page.locator(effectsSelector)).toHaveCount(1);
    expect(await page.evaluate(() => window.__h.audioStops)).toBe(0);
    await page.clock.runFor(64);
    await expect(page.locator(effectsSelector)).toHaveCount(0);
    expect(await page.evaluate(() => window.__h.audioStops)).toBe(1);
    const effect = await page.evaluate(id => window.__interactionProbe.effects[id], id);
    expect(effect.removed - receivedAt).toBeGreaterThanOrEqual(remaining);
    expect(effect.removed - receivedAt).toBeLessThanOrEqual(remaining + 32);
    expect(effect.removed - receivedAt).toBeLessThanOrEqual(3000);
    await page.clock.runFor(3000 - remaining - 32);
    await expect(page.locator(effectsSelector)).toHaveCount(0);
    expect(await page.evaluate(() => window.__h.audioStarts)).toBe(1);
    expect(errors).toEqual([]);
    await testInfo.attach(`wall-jump-${direction}`, { body: Buffer.from(JSON.stringify({ receivedAt, receivedAge,
      remaining, wallBefore, direction, sound, effect }, null, 2)), contentType: 'application/json' });
  });
}

for (const rejection of ['content-length', 'stream', 'duration']) {
  test(`DOM harness rejects audio ${rejection} budget violations without suppressing visuals`, async ({ page, baseURL }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const asset = await harness(page, baseURL, { authorizedAudio: true, controlledClock: true });
    expect(asset.audio).toBeTruthy();
    const audioUrl = new URL(asset.audio, baseURL);
    audioUrl.searchParams.set('v', asset.revision);
    const response = await page.request.get(audioUrl.href);
    expect(response.ok()).toBe(true);
    const validBytes = await response.body();
    expect(validBytes.length).toBeLessThanOrEqual(1024 * 1024);
    let requests = 0;
    await page.route(audioUrl.href, route => {
      requests++;
      const body = requests === 1 && rejection !== 'duration' ? Buffer.alloc(1024 * 1024 + 1) : validBytes;
      return route.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'content-length': String(body.length) }, body });
    });
    await page.evaluate(rejection => {
      window.__h.audioAborts = 0;
      window.__h.audioReadCancels = 0;
      if (rejection === 'duration') window.__h.decodedAudio = { duration: 3.01, length: 132741, numberOfChannels: 2 };
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.pathname !== window.__h.asset.audio) return nativeFetch(input, init);
        init?.signal?.addEventListener('abort', () => { window.__h.audioAborts++; }, { once: true });
        let response = await nativeFetch(input, init);
        if (rejection === 'stream') {
          // Exercise the streaming byte counter even when no trustworthy Content-Length is available.
          const headers = new Headers(response.headers);
          headers.delete('content-length');
          response = new Response(response.body, { status: response.status, headers });
          const getReader = response.body.getReader.bind(response.body);
          response.body.getReader = (...args) => {
            const reader = getReader(...args);
            const cancel = reader.cancel.bind(reader);
            reader.cancel = (...args) => { window.__h.audioReadCancels++; return cancel(...args); };
            return reader;
          };
        }
        return response;
      };
    }, rejection);
    await page.locator('[data-interaction-toggle]').click();
    await page.locator('[data-interaction-close]').click();
    await installObserver(page);
    await show(page, `audio-rejected-${rejection}`);
    await expect.poll(() => requests).toBe(1);
    const completionCounter = rejection === 'duration' ? 'audioDecodes' : rejection === 'stream' ? 'audioReadCancels' : 'audioAborts';
    await expect.poll(() => page.evaluate(key => window.__h[key], completionCounter)).toBe(1);
    await page.clock.runFor(64);
    expect(await observedVisible(page)).toBe(true);
    await expect(page.locator(effectsSelector)).toHaveCount(1);
    expect(await page.evaluate(() => window.__h.audioDecodes)).toBe(rejection === 'duration' ? 1 : 0);
    expect(await page.evaluate(() => window.__h.audioStarts)).toBe(0);
    await page.clock.runFor(3000 - 64);
    await expect(page.locator(effectsSelector)).toHaveCount(0);
    const effect = await page.evaluate(id => window.__interactionProbe.effects[id], `audio-rejected-${rejection}`);
    expect(effect.removed).not.toBeNull();
    expect(effect.removed - effect.added).toBeLessThanOrEqual(3000);
    expect(await page.evaluate(() => window.__h.audioStarts)).toBe(0);
    // The same URL must remain retryable, and a valid mock buffer must actually start.
    await page.evaluate(() => { window.__h.decodedAudio = { duration: 2.1, length: 92610, numberOfChannels: 2 }; });
    await show(page, `audio-valid-${rejection}`);
    await expect.poll(() => requests).toBe(2);
    await expect.poll(() => page.evaluate(() => window.__h.audioStarts)).toBe(1);
    expect(await page.evaluate(() => window.__h.audioDecodes)).toBe(rejection === 'duration' ? 2 : 1);
    await page.clock.runFor(3000);
    await expect(page.locator(effectsSelector)).toHaveCount(0);
    expect(await page.evaluate(() => window.__h.audioStops)).toBe(1);
    expect(errors).toEqual([]);
  });
}

const smokeRevision = '0123456789abcdef';
const smokePoster = '/assets/interactions/question/poster.png';

async function routeSmokeCatalog(page, baseURL, items) {
  await page.route(new URL('/api/interactions', baseURL).href, route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, items }),
  }));
}

async function prepareSmokeMainVideo(page, baseURL) {
  const mediaUrl = `${new URL('/assets/interactions/test.webm', baseURL).href}?v=${smokeRevision}`;
  const clip = buildRepeatedFixtureWebM({ name: 'interaction-type-smoke.webm', durationSeconds: 8 });
  await installRemoteWebMFixture(page.context(), {
    inputUrl: mediaUrl, mediaUrl, title: 'Interaction type smoke', buffer: clip.buffer,
  });
  await page.locator('[data-room-video]').evaluate(async (video, url) => {
    video.muted = true;
    await new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('Main WebM fixture failed to decode')), { once: true });
      video.src = url;
    });
    video.currentTime = 0.25;
    if (video.seeking) await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
    video.pause();
    if (video.playbackRate !== 1.25) {
      await new Promise(resolve => {
        video.addEventListener('ratechange', resolve, { once: true });
        video.playbackRate = 1.25;
      });
    }
  }, mediaUrl);
  await expect.poll(() => page.locator('[data-room-video]').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(2);
  expect(await page.locator('[data-room-video]').evaluate(video => video.playbackRate), 'smoke baseline rate before observer').toBe(1.25);
  await page.evaluate(() => Object.defineProperty(window.__h, 'now', { configurable: true, get: () => Date.now() }));
  await installObserver(page);
  expect(await page.evaluate(() => window.__interactionProbe.before.rate)).toBe(1.25);
}

function assertSmokeMainUnchanged(probe) {
  expect(probe.before.src).toContain('/assets/interactions/test.webm');
  expect(probe.before.paused).toBe(true);
  expect(probe.before.rate).toBe(1.25);
  expect(probe.snapshots.length).toBeGreaterThan(0);
  expect(Object.values(probe.events)).toEqual(Object.values(probe.events).map(() => 0));
  for (const sample of probe.snapshots) {
    expect(sample.src).toBe(probe.before.src);
    expect(sample.currentSrc).toBe(probe.before.currentSrc);
    expect(sample.paused).toBe(true);
    expect(sample.rate).toBe(1.25);
    expect(Math.abs(sample.time - probe.before.time)).toBeLessThan(0.02);
  }
}

test('DOM harness deferred unchanged catalog preserves the focused asset and Space selection without touching the main video', async ({ page, baseURL }) => {
  const catalogUrl = new URL('/api/interactions', baseURL).href;
  const response = await page.request.get(catalogUrl);
  expect(response.ok()).toBe(true);
  const catalogBody = await response.text();
  let deferRefresh = false;
  let deferredRequests = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(catalogUrl, async route => {
    if (deferRefresh) {
      deferredRequests++;
      await gate;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: catalogBody });
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await harness(page, baseURL);
    await prepareSmokeMainVideo(page, baseURL);
    await page.locator('[data-interaction-toggle]').click();
    await page.evaluate(() => window.__interaction.refreshCatalog());
    await page.locator('[data-interaction-close]').click();
    await expect(page.locator('#interactionPopover')).toBeHidden();
    await page.evaluate(() => {
      window.__unhandledInteractionSpace = [];
      document.addEventListener('keydown', event => {
        if (event.key === ' ' || event.key === 'Spacebar') {
          window.__unhandledInteractionSpace.push(event.target.tagName);
        }
      });
    });
    deferRefresh = true;
    await page.locator('[data-interaction-toggle]').press('Space');
    await expect.poll(() => deferredRequests).toBe(1);
    await expect(page.locator('#interactionPopover')).toBeVisible();
    await page.locator('[data-interaction-group-tab="other"]').click();
    const assetButton = page.locator('[data-interaction-asset="question"]');
    await assetButton.focus();
    await expect(assetButton).toBeFocused();
    await page.evaluate(() => {
      window.__focusedInteractionAsset = document.activeElement;
      // Join the already pending UI refresh, so the next assertion waits for its DOM work too.
      window.__catalogRefreshDone = window.__interaction.refreshCatalog();
    });
    release();
    await page.evaluate(() => window.__catalogRefreshDone);
    expect(deferredRequests, 'joining the pending refresh must not issue another request').toBe(1);
    expect(await page.evaluate(() => ({
      connected: window.__focusedInteractionAsset.isConnected,
      sameNode: document.querySelector('[data-interaction-asset="question"]') === window.__focusedInteractionAsset,
      focused: document.activeElement === window.__focusedInteractionAsset,
    }))).toEqual({ connected: true, sameNode: true, focused: true });
    // Do not use locator.press here: it would re-focus a replacement button and conceal the regression.
    await page.keyboard.press('Space');
    await expect(page.locator(shellSelector)).toHaveClass(/\bis-interaction-placing\b/);
    await expect(page.locator('#interactionPopover')).toBeHidden();
    expect(await page.evaluate(() => window.__unhandledInteractionSpace)).toEqual([]);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const probe = await page.evaluate(() => { window.__interactionProbe.done = true; return window.__interactionProbe; });
    assertSmokeMainUnchanged(probe);
    expect(errors).toEqual([]);
  } finally {
    release();
    await page.evaluate(() => window.__catalogRefreshDone).catch(() => {});
    await page.unroute(catalogUrl);
  }
});

for (const type of ['image', 'video']) {
  test(`DOM harness ${type} asset decodes visible pixels and expires without touching the main video`, async ({ page, baseURL }, testInfo) => {
    const asset = { id: 'question', label: 'Type smoke', type, revision: smokeRevision,
      src: type === 'image' ? smokePoster : '/assets/interactions/test.webm', poster: smokePoster,
      durationMs: 2100, width: type === 'image' ? 168 : 320, height: type === 'image' ? 320 : 180 };
    await routeSmokeCatalog(page, baseURL, [asset]);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await harness(page, baseURL);
    await prepareSmokeMainVideo(page, baseURL);
    const id = `${type}-smoke`;
    await show(page, id);
    await expect.poll(() => page.evaluate(({ id, type }) => window.__interactionProbe.effects[id]?.samples.some(sample =>
      sample.kind === (type === 'image' ? 'IMG' : 'VIDEO') && sample.visible > 50 && sample.colorRange > 5
      && (type === 'image' ? sample.transparent > 50 : sample.decodedFrames > 0 && sample.effectPaused === false)) || false,
    { id, type }), { timeout: 1800, intervals: [30, 50] }).toBe(true);
    await screenshot(page, testInfo, `${type}-decoded`);
    await expect.poll(() => page.evaluate(id => {
      const effect = window.__interactionProbe.effects[id];
      return Boolean(effect && effect.removed !== null);
    }, id),
      { timeout: 3000, intervals: [30, 50] }).toBe(true);
    await expect(page.locator('[data-interaction-layer] .interaction-effect')).toHaveCount(0);
    const probe = await page.evaluate(() => { window.__interactionProbe.done = true; return window.__interactionProbe; });
    expect(probe.effects[id].removed - probe.effects[id].added).toBeLessThanOrEqual(3000);
    const decoded = probe.effects[id].samples.filter(sample => sample.visible > 50 && sample.colorRange > 5);
    expect(decoded.length).toBeGreaterThan(0);
    for (const sample of decoded) {
      expect(sample.effectHeight).toBeGreaterThan(0);
      expect(sample.effectWidth / sample.effectHeight, `${type} must preserve its asset aspect ratio`).toBeCloseTo(asset.width / asset.height, 2);
    }
    assertSmokeMainUnchanged(probe);
    expect(errors).toEqual([]);
    await testInfo.attach(`${type}-observations`, { body: Buffer.from(JSON.stringify(probe, null, 2)), contentType: 'application/json' });
  });
}

test('DOM harness rejects unsafe catalogs and failed images without changing the main video', async ({ page, baseURL }) => {
  const valid = { id: 'question', label: 'Safe image', type: 'image', revision: smokeRevision,
    src: smokePoster, poster: smokePoster, durationMs: 2100, width: 168, height: 320 };
  await routeSmokeCatalog(page, baseURL, [valid,
    { ...valid, id: 'external-image', src: 'https://interaction-test.invalid/external.png' },
    { ...valid, id: 'external-video', type: 'video', src: 'https://interaction-test.invalid/external.webm' },
    { ...valid, id: 'too-long', durationMs: 3001 },
    { ...valid, id: 'wrong-type', type: 'html' },
    { ...valid, id: 'failed-image', src: '/assets/interactions/missing-test.png' },
  ]);
  const forbiddenRequests = [];
  await page.route('https://interaction-test.invalid/**', async route => {
    forbiddenRequests.push(route.request().url());
    await route.abort();
  });
  let failedImageRequests = 0;
  await page.route('**/assets/interactions/missing-test.png*', async route => {
    failedImageRequests++;
    await route.fulfill({ status: 404, body: '' });
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await harness(page, baseURL);
  await prepareSmokeMainVideo(page, baseURL);
  for (const id of ['external-image', 'external-video', 'too-long', 'wrong-type']) {
    await expect(page.locator(`[data-interaction-asset="${id}"]`)).toHaveCount(0);
    await show(page, `invalid-${id}`, { assetId: id });
  }
  await show(page, 'unknown', { assetId: 'not-in-catalog' });
  await show(page, 'invalid-coordinate', { x: -0.1 });
  await show(page, 'failed-image', { assetId: 'failed-image' });
  expect(failedImageRequests).toBe(1);
  expect(forbiddenRequests).toEqual([]);
  await expect(page.locator('[data-interaction-layer] .interaction-effect')).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(window.__interactionProbe.effects))).toEqual([]);
  // Positive control proves that rejects were not caused by an unusable harness or revision mismatch.
  await show(page, 'valid-after-rejects');
  await expect.poll(() => observedVisible(page), { timeout: 1800, intervals: [30, 50] }).toBe(true);
  await page.evaluate(() => window.__interaction.clear());
  await expect(page.locator('[data-interaction-layer] .interaction-effect')).toHaveCount(0);
  const probe = await page.evaluate(() => { window.__interactionProbe.done = true; return window.__interactionProbe; });
  assertSmokeMainUnchanged(probe);
  expect(errors).toEqual([]);
});

for (const pendingStage of ['fetch', 'decode']) {
  test(`DOM harness clear cancels pending audio ${pendingStage} and retries the same URL`, async ({ page, baseURL }, testInfo) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const asset = await harness(page, baseURL, { authorizedAudio: true, controlledClock: true });
    expect(asset.audio).toBeTruthy();
    const audioUrl = new URL(asset.audio, baseURL);
    audioUrl.searchParams.set('v', asset.revision);
    const response = await page.request.get(audioUrl.href);
    expect(response.ok()).toBe(true);
    const audioBytes = await response.body();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const requestedUrls = [];
    let cleared = false;
    let finishFirstRoute;
    const firstRouteFinished = new Promise(resolve => { finishFirstRoute = resolve; });
    await page.route(audioUrl.href, async route => {
      requestedUrls.push(route.request().url());
      const first = requestedUrls.length === 1;
      if (first && pendingStage === 'fetch') await gate;
      try {
        await route.fulfill({ status: 200, contentType: 'audio/wav', body: audioBytes });
      } catch (error) {
        // Chromium may already have discarded the first interception after AbortController.abort().
        if (!(first && pendingStage === 'fetch' && cleared)) throw error;
      } finally {
        if (first) finishFirstRoute();
      }
    });
    try {
      await page.evaluate(stage => {
        window.__h.holdNextDecode = stage === 'decode';
        window.__h.audioAborts = 0;
        const nativeFetch = window.fetch.bind(window);
        // Observe the real fetch signal without changing its response or cancellation behavior.
        window.fetch = (input, init) => {
          const url = new URL(typeof input === 'string' ? input : input.url, location.href);
          if (url.pathname === window.__h.asset.audio) {
            init?.signal?.addEventListener('abort', () => { window.__h.audioAborts++; }, { once: true });
          }
          return nativeFetch(input, init);
        };
      }, pendingStage);
      await page.locator('[data-interaction-toggle]').click();
      await page.locator('[data-interaction-close]').click();
      await installObserver(page);
      await show(page, `pending-${pendingStage}`);
      await expect.poll(() => requestedUrls.length, { timeout: 2000 }).toBe(1);
      await expect.poll(() => page.evaluate(() => window.__h.audioDecodes), { timeout: 2000 })
        .toBe(pendingStage === 'decode' ? 1 : 0);
      await page.clock.runFor(64);
      await expect.poll(() => observedVisible(page), { timeout: 1800, intervals: [30, 50] }).toBe(true);
      expect(await page.evaluate(() => window.__h.audioStarts)).toBe(0);
      await page.evaluate(() => window.__interaction.clear());
      cleared = true;
      // This must pass while the fetch/decode gate is still held: clear, not gate release, cancels it.
      expect(await page.evaluate(() => window.__h.audioAborts)).toBe(1);
      await expect(page.locator(effectsSelector)).toHaveCount(0);
      release();
      await firstRouteFinished;
      await show(page, `retry-${pendingStage}`);
      await expect.poll(() => requestedUrls.length, { timeout: 2000 }).toBe(2);
      await expect.poll(() => page.evaluate(() => window.__h.audioStarts), { timeout: 2000 }).toBe(1);
      await expect(page.locator(effectsSelector)).toHaveCount(1);
      expect(requestedUrls).toEqual([audioUrl.href, audioUrl.href]);
      expect(await page.evaluate(() => window.__h.audioDecodes)).toBe(pendingStage === 'decode' ? 2 : 1);
      await page.evaluate(() => { window.__h.releaseDecode?.(); });
      await page.clock.runFor(16);
      expect(await page.evaluate(() => window.__h.audioStarts), 'late old decode must not start an orphan sound').toBe(1);
      expect(await page.evaluate(() => window.__h.now), 'no expiry clock advancement masks cancellation').toBe(10000);
      await page.evaluate(() => window.__interaction.clear());
      expect(await page.evaluate(() => window.__h.audioStops)).toBe(1);
      await expect(page.locator(effectsSelector)).toHaveCount(0);
      expect(errors).toEqual([]);
      await testInfo.attach(`audio-${pendingStage}-retry`, { body: Buffer.from(JSON.stringify({ requestedUrls,
        counters: await page.evaluate(() => ({ starts: window.__h.audioStarts, stops: window.__h.audioStops,
          decodes: window.__h.audioDecodes, aborts: window.__h.audioAborts, now: window.__h.now })) }, null, 2)), contentType: 'application/json' });
    } finally {
      release();
      await page.evaluate(() => { window.__h.releaseDecode?.(); window.__interaction.clear(); }).catch(() => {});
      await page.unroute(audioUrl.href);
    }
  });
}
