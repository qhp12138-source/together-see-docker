import { test, expect } from '@playwright/test';
import {
  createRoomContexts, createRoomFromHome, joinRoomFromHome, openRoomTab,
  waitForRemoteMediaReady, uniqueRoomName, closeRoomContexts,
} from './helpers/room.mjs';
import { buildRepeatedFixtureWebM, installRemoteWebMFixture } from './helpers/media.mjs';

test.use({ actionTimeout: 10_000 });
test.describe.configure({ timeout: 60_000 });

const builtins = ['heart', 'fireworks', 'sakura', 'birthday'];
const shellSelector = '[data-player-shell]';
const canvasSelector = '[data-interaction-layer] canvas';
const placing = /\bis-interaction-placing\b/;
const revision = '0123456789abcdef';
const center = { x: 0.45, y: 0.42 };
const fixtureItems = builtins.map(id => ({
  id, label: id, type: 'builtin', effect: id, group: 'builtin',
  visualBytes: 0, revision, durationMs: 3000,
}));
const other = {
  id: 'other-image', label: 'Other image', type: 'image', group: 'other',
  src: '/assets/interactions/question/poster.png', visualBytes: 1,
  revision, durationMs: 2100, width: 168, height: 320,
};

// Deliberately independent of TogetherSeeInteractions.pictureRect.
async function picture(page) {
  return page.locator('[data-room-video]').evaluate(video => {
    const box = video.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const width = video.videoWidth * scale, height = video.videoHeight * scale;
    return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
  });
}

async function clickPicture(page, point = center, options = {}) {
  const rect = await picture(page);
  await page.mouse.click(rect.left + rect.width * point.x, rect.top + rect.height * point.y, options);
}

async function choose(page, id) {
  await page.locator(shellSelector).hover();
  await page.locator('[data-interaction-toggle]').click();
  await expect(page.locator('#interactionPopover')).toBeVisible();
  await page.locator(`[data-interaction-group-tab="${builtins.includes(id) ? 'builtin' : 'other'}"]`).click();
  await page.locator(`[data-interaction-asset="${id}"]`).click();
  await expect(page.locator(shellSelector)).toHaveClass(placing);
}

async function advanceTo(page, target) {
  const remaining = target - await page.evaluate(() => performance.now());
  expect(remaining, 'controlled observation must not already have passed its boundary').toBeGreaterThanOrEqual(0);
  if (remaining) await page.clock.runFor(remaining);
}

async function attachScreenshot(page, testInfo, name) {
  await testInfo.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
}

// Install before sending: retain frames even if driver/socket scheduling outlives the effect.
function installVisualProbe() {
  const layer = document.querySelector('[data-interaction-layer]');
  const video = document.querySelector('[data-room-video]');
  const probe = window.__effectPixels = { effects: {}, errors: [], maxActive: 0 };
  const sample = canvas => {
    const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let visible = 0, transparent = 0, green = 0, maxGreenAlpha = 0, maxGreenExcess = 0, hash = 2166136261;
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] > 8) visible++;
      if (!rgba[i + 3]) transparent++;
      const excess = rgba[i + 1] - Math.max(rgba[i], rgba[i + 2]);
      if (rgba[i + 3] > 8 && excess > 12) {
        green++;
        maxGreenAlpha = Math.max(maxGreenAlpha, rgba[i + 3]);
        maxGreenExcess = Math.max(maxGreenExcess, excess);
      }
      hash = Math.imul(hash ^ rgba[i], 16777619);
      hash = Math.imul(hash ^ rgba[i + 1], 16777619);
      hash = Math.imul(hash ^ rgba[i + 2], 16777619);
      hash = Math.imul(hash ^ rgba[i + 3], 16777619);
    }
    const box = video.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const width = video.videoWidth * scale, height = video.videoHeight * scale;
    const left = box.left + (box.width - width) / 2, top = box.top + (box.height - height) / 2;
    const bounds = canvas.getBoundingClientRect(), overlay = layer.getBoundingClientRect();
    return { at: performance.now(), hash: hash >>> 0, visible, transparent, green, maxGreenAlpha, maxGreenExcess,
      hidden: document.hidden, ...(window.__compareSpritePixels?.(canvas, rgba) || {}),
      width: bounds.width, height: bounds.height, pictureWidth: width,
      x: (bounds.left + bounds.width / 2 - left) / width,
      y: (bounds.top + bounds.height / 2 - top) / height,
      overflow: Math.max(0, left - bounds.left, top - bounds.top, bounds.right - left - width, bounds.bottom - top - height),
      overlayError: Math.max(Math.abs(overlay.left - left), Math.abs(overlay.top - top),
        Math.abs(overlay.width - width), Math.abs(overlay.height - height)) };
  };
  window.__sampleEffectCanvas = sample;
  const observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        const id = node.dataset?.interactionId;
        if (id) probe.effects[id] = { added: performance.now(), removed: null, samples: [],
          effect: node.dataset.interactionEffect, variant: node.dataset.interactionVariant };
      }
      for (const node of record.removedNodes) {
        const entry = probe.effects[node.dataset?.interactionId];
        if (entry) entry.removed = performance.now();
      }
    }
  });
  observer.observe(layer, { childList: true });
  let lastSample = -Infinity;
  function tick() {
    const nodes = layer.querySelectorAll('canvas[data-interaction-id]');
    probe.maxActive = Math.max(probe.maxActive, nodes.length);
    if (performance.now() - lastSample >= 48) {
      lastSample = performance.now();
      for (const canvas of nodes) {
        const entry = probe.effects[canvas.dataset.interactionId];
        if (!entry || entry.samples.length >= 100) continue;
        try { entry.samples.push(sample(canvas)); }
        catch (error) { probe.errors.push(error.message); }
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

async function harness(page, baseURL, items = [...fixtureItems, other], { liveCatalog = false } = {}) {
  await page.clock.install({ time: new Date('2026-09-29T12:00:00Z') });
  const url = new URL('/__interaction_effects_harness__', baseURL).href;
  if (!liveCatalog) await page.route(new URL('/api/interactions', baseURL).href, route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ version: 1, items }),
  }));
  await page.route(url, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <html><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/assets/css/main.css">
    <style>body{margin:0;padding:12px;background:#14181e} [data-player-shell]{position:relative;width:min(800px,100%);height:500px;margin:auto;background:#080b10}
    [data-room-video]{display:block;width:100%;height:100%;object-fit:contain}
    [data-player-controls]{position:absolute;left:12px;right:12px;bottom:12px;height:36px}
    [data-interaction-toggle]{float:right} [hidden]{display:none!important}</style></head>
    <body><div data-player-shell><video data-room-video></video>
    <div class="interaction-layer" data-interaction-layer></div>
    <div data-player-controls><button data-interaction-toggle>Toolbox</button></div></div></body></html>` }));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.addScriptTag({ url: new URL('/assets/js/interactions.js', baseURL).href });
  await page.evaluate(items => {
    const video = document.querySelector('video');
    Object.defineProperties(video, { videoWidth: { value: 1280 }, videoHeight: { value: 720 } });
    const state = window.__effectsHarness = { items, hidden: false, sent: [], selections: [], notices: [],
      connected: true, sourceId: 'source-current', localSourceId: 'source-current', clockOffset: 0 };
    Object.defineProperty(state, 'now', { get: () => Date.now() + state.clockOffset });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => state.hidden });
    document.addEventListener('click', event => {
      const button = event.target.closest('[data-interaction-asset]');
      if (button) state.selections.push({ id: button.dataset.interactionAsset, at: performance.now() });
    }, true);
    window.__effects = window.TogetherSeeInteractions.create({ player: { video }, getContext: () => state,
      send: payload => {
        state.sent.push({ ...payload, at: performance.now() });
        if (state.holdAck) return new Promise(resolve => { state.resolveAck = resolve; });
        return Promise.resolve({ ok: true });
      },
      showToast: message => state.notices.push(message),
    });
  }, items);
  await page.evaluate(() => window.__effects.refreshCatalog());
  await expect(page.locator('[data-interaction-asset="heart"]')).toHaveCount(1);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.evaluate(installVisualProbe);
  return errors;
}

async function show(page, id, assetId = 'heart', overrides = {}) {
  return page.evaluate(async ({ id, assetId, overrides }) => {
    const state = window.__effectsHarness;
    const asset = state.items.find(item => item.id === assetId);
    const payload = { id, assetId, assetRevision: asset.revision, sourceId: state.sourceId,
      ...{ x: 0.45, y: 0.42 }, sentAt: state.now, durationMs: asset.durationMs, ...overrides };
    const receivedAt = performance.now(), receivedAge = state.now - payload.sentAt;
    await window.__effects.show(payload);
    return { ...payload, receivedAt, receivedAge,
      deadline: receivedAt + Math.min(asset.durationMs, payload.durationMs, 3000) - Math.max(0, receivedAge) };
  }, { id, assetId, overrides });
}

function assertPixels(samples, point = center) {
  const visible = samples.filter(frame => frame.visible > 50 && frame.transparent > 50 && !frame.hidden);
  expect(visible.length, 'at least two nonblank frames').toBeGreaterThanOrEqual(2);
  expect(new Set(visible.map(frame => frame.hash)).size, 'pixels must move, not just allocate a canvas').toBeGreaterThan(1);
  for (const frame of visible) {
    expect(frame.width).toBeGreaterThan(0);
    expect(frame.height).toBeGreaterThan(0);
    expect(frame.x).toBeCloseTo(point.x, 2);
    expect(frame.y).toBeCloseTo(point.y, 2);
    expect(frame.overlayError).toBeLessThanOrEqual(1);
    expect(frame.overflow).toBeLessThanOrEqual(1);
  }
}

async function assertNoOverflow(page) {
  const result = await page.evaluate(() => {
    const popover = document.querySelector('#interactionPopover');
    const box = popover.getBoundingClientRect();
    return { pageOverflow: document.documentElement.scrollWidth - innerWidth,
      innerOverflow: popover.scrollWidth - popover.clientWidth,
      left: box.left, right: box.right, viewport: innerWidth };
  });
  expect(result.pageOverflow).toBeLessThanOrEqual(1);
  expect(result.innerOverflow).toBeLessThanOrEqual(1);
  expect(result.left).toBeGreaterThanOrEqual(0);
  expect(result.right).toBeLessThanOrEqual(result.viewport + 1);
}

test('public catalog exposes exactly four source-free builtins and the question sprite', async ({ request, baseURL }) => {
  const response = await request.get(new URL('/api/interactions', baseURL).href);
  expect(response.ok()).toBe(true);
  const catalog = await response.json();
  expect(catalog.version).toBe(1);
  expect(catalog.items.map(item => item.id).sort()).toEqual([...builtins, 'question'].sort());
  expect(catalog.items.filter(item => item.type === 'builtin').map(item => item.id).sort()).toEqual([...builtins].sort());
  for (const id of builtins) {
    const asset = catalog.items.find(item => item.id === id);
    expect(asset).toMatchObject({ id, type: 'builtin', effect: id, group: 'builtin', visualBytes: 0 });
    expect(asset.revision).toMatch(/^[a-f0-9]{16}$/);
    expect(asset.durationMs).toBeGreaterThan(0);
    expect(asset.durationMs).toBeLessThanOrEqual(3000);
    for (const key of ['src', 'poster', 'audio']) expect(asset).not.toHaveProperty(key);
  }
  const media = catalog.items.filter(item => item.type !== 'builtin');
  expect(media).toHaveLength(1);
  for (const asset of media) {
    expect(asset).toMatchObject({ id: 'question', type: 'sprite' });
    expect(asset.group).toBe('other');
    expect(asset.src).toBe('/assets/interactions/question/spritesheet.png');
    expect(asset.poster).toBe('/assets/interactions/question/poster.png');
    expect(asset.audio).toBe('/assets/interactions/question/audio.wav');
    expect(asset.visualBytes).toBeGreaterThan(0);
  }
});

test('fixed interaction menu pages larger catalogs without scrolling or closing on preferences', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const items = Array.from({ length: 14 }, (_, index) => ({ ...other, id: `extra-${index}`, label: `Effect ${index}` }));
  const errors = await harness(page, baseURL, [...fixtureItems, ...items]);
  await page.locator('[data-interaction-toggle]').click();
  const dialog = page.locator('#interactionPopover');
  await page.locator('[data-interaction-enabled]').uncheck();
  await expect(dialog).toBeVisible();
  await page.locator('[data-interaction-enabled]').check();
  await page.locator('[data-interaction-group-tab="other"]').click();
  for (let index = 0; index < 3; index++) {
    await expect(page.locator('[data-interaction-page]')).toHaveText(`${index + 1} / 3`);
    expect(await page.locator('[data-interaction-asset]:visible').evaluateAll(nodes => nodes.map(n => n.dataset.interactionAsset)))
      .toEqual(items.slice(index * 6, index * 6 + 6).map(item => item.id));
    expect(await dialog.evaluate(node => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(1);
    if (index < 2) await page.locator('[data-interaction-next]').click();
  }
  await expect(page.locator('[data-interaction-next]')).toBeDisabled();
  await page.locator('[data-interaction-prev]').click();
  await expect(page.locator('[data-interaction-page]')).toHaveText('2 / 3');
  await page.locator('[data-interaction-group-tab="builtin"]').click();
  await expect(page.locator('.interaction-pagination')).toBeHidden();
  await page.mouse.click(1, 1);
  await expect(dialog).toBeVisible();
  await page.locator('[data-interaction-close]').click();
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});

async function inspectRealSpriteAndAudio(page, asset) {
  return page.evaluate(async asset => {
    const url = key => {
      const result = new URL(asset[key], location.href);
      result.searchParams.set('v', asset.revision);
      return result.href;
    };
    const imageResponse = await fetch(url('src'));
    if (!imageResponse.ok) throw new Error(`Sprite HTTP ${imageResponse.status}: ${asset.id}`);
    const imageBytes = await imageResponse.arrayBuffer();
    const signature = Array.from(new Uint8Array(imageBytes).subarray(0, 12));
    const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    const format = pngSignature.every((byte, index) => signature[index] === byte) ? 'png'
      : String.fromCharCode(...signature.slice(0, 4)) === 'RIFF'
        && String.fromCharCode(...signature.slice(8, 12)) === 'WEBP' ? 'webp' : null;
    if (!format) throw new Error(`Unsupported sprite image signature for ${asset.id}: ${signature}`);
    const blobUrl = URL.createObjectURL(new Blob([imageBytes], { type: `image/${format}` }));
    const image = new Image();
    const frames = [];
    let sheet;
    try {
      image.src = blobUrl;
      await image.decode();
      sheet = { width: image.naturalWidth, height: image.naturalHeight, bytes: imageBytes.byteLength, signature, format };
      if (!sheet.width || !sheet.height || sheet.width * sheet.height > 8 * 1024 * 1024) {
        throw new Error(`Decoded sprite exceeds the 8M-pixel budget: ${JSON.stringify(sheet)}`);
      }
      const tile = document.createElement('canvas');
      tile.width = asset.width;
      tile.height = asset.height;
      const ctx = tile.getContext('2d', { willReadFrequently: true });
      window.__spriteReference = { asset, pixels: [] };
      // Inspect every declared tile, including blank entrance/blink/sound-tail frames.
      for (let frame = 0; frame < asset.frames; frame++) {
        const x = frame % asset.columns * asset.width, y = Math.floor(frame / asset.columns) * asset.height;
        if (x + asset.width > sheet.width || y + asset.height > sheet.height) {
          throw new Error(`Frame ${frame} extends beyond decoded sheet for ${asset.id}`);
        }
        ctx.clearRect(0, 0, tile.width, tile.height);
        ctx.drawImage(image, x, y, asset.width, asset.height, 0, 0, tile.width, tile.height);
        const { visible, transparent, green, maxGreenAlpha, maxGreenExcess, hash } = window.__sampleEffectCanvas(tile);
        window.__spriteReference.pixels.push(ctx.getImageData(0, 0, tile.width, tile.height).data);
        frames.push({ frame, visible, transparent, green, maxGreenAlpha, maxGreenExcess, hash });
      }
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
    const audioResponse = await fetch(url('audio'));
    if (!audioResponse.ok) throw new Error(`Audio HTTP ${audioResponse.status}: ${asset.id}`);
    const audioBytes = await audioResponse.arrayBuffer();
    const header = new Uint8Array(audioBytes, 0, 12);
    const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(audioBytes.slice(0));
    let peak = 0;
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      for (const sample of audio.getChannelData(channel)) peak = Math.max(peak, Math.abs(sample));
    }
    return { sheet, frames, audio: { bytes: audioBytes.byteLength,
      riff: String.fromCharCode(...header.slice(0, 4)), wave: String.fromCharCode(...header.slice(8, 12)),
      duration: audio.duration, samples: audio.length, channels: audio.numberOfChannels, sampleRate: audio.sampleRate, peak } };
  }, asset);
}

async function installSpritePixelComparison(page, eventId) {
  await page.evaluate(eventId => {
    const { asset, pixels } = window.__spriteReference;
    let draw;
    const nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      const result = nativeDrawImage.apply(this, args);
      if (this.canvas.dataset.interactionId === eventId) {
        const [, x, y, width, height, dx, dy, dw, dh] = args;
        const frame = y / asset.height * asset.columns + x / asset.width;
        draw = { drawnAt: performance.now(), frame,
          cropValid: args.length === 9 && Number.isInteger(frame) && frame >= 0 && frame < asset.frames
            && x === frame % asset.columns * asset.width && y === Math.floor(frame / asset.columns) * asset.height
            && width === asset.width && height === asset.height && dx === 0 && dy === 0 && dw === width && dh === height };
      }
      return result;
    };
    window.__compareSpritePixels = (canvas, actual) => {
      if (canvas.dataset.interactionId !== eventId) return null;
      if (!draw?.cropValid) return { cropValid: false };
      const expected = pixels[draw.frame];
      let differingPixels = 0, alphaMismatches = 0, maxRGBDelta = 0;
      for (let i = 0; i < actual.length; i += 4) {
        const alphaDiffers = actual[i + 3] !== expected[i + 3];
        if (alphaDiffers) alphaMismatches++;
        let differs = alphaDiffers;
        for (let channel = 0; channel < 3; channel++) {
          const delta = Math.abs(actual[i + channel] - expected[i + channel]);
          maxRGBDelta = Math.max(maxRGBDelta, delta);
          differs ||= delta > 0;
        }
        if (differs) differingPixels++;
      }
      return { ...draw, differingPixels, alphaMismatches, maxRGBDelta };
    };
  }, eventId);
}

function assertKeyedFrame(frame, asset, format) {
  const label = `${asset.id} frame ${frame.frame ?? frame.at}`;
  if (format !== 'webp') {
    expect(frame.green, `dominant-green pixels in ${label}`).toBe(0);
    return;
  }
  // Measured lossy WebP residue: <=3 pixels/frame, alpha <=34, green excess <=29.
  expect(frame.green, `isolated WebP chroma residue in ${label}`).toBeLessThanOrEqual(4);
  expect(frame.green / (asset.width * asset.height), `green area in ${label}`).toBeLessThanOrEqual(0.0001);
  expect(frame.green / Math.max(1, frame.visible), `green fraction of visible pixels in ${label}`).toBeLessThanOrEqual(0.01);
  expect(frame.maxGreenAlpha, `no opaque green background in ${label}`).toBeLessThanOrEqual(40);
  expect(frame.maxGreenExcess, `no saturated green background in ${label}`).toBeLessThanOrEqual(32);
}

function assertSpriteFrame(frame, asset, event) {
  expect(frame.cropValid, 'renderer must draw one complete declared tile').toBe(true);
  expect(frame.frame, 'tile index must follow the original event timeline').toBe(Math.min(asset.frames - 1,
    Math.floor((frame.drawnAt - event.receivedAt + Math.max(0, event.receivedAge)) / event.durationMs * asset.frames)));
  expect(frame.alphaMismatches, 'decoded tile alpha must match exactly').toBe(0);
  // Default/read-optimized canvas readback can round unpremultiplied RGB differently.
  expect(frame.maxRGBDelta, 'decoded tile RGB may differ by at most one 8-bit rounding level').toBeLessThanOrEqual(1);
}

for (const id of ['question']) {
  test(`public ${id} sprite uses real PNG and WAV, transparent moving frames and one-shot placement within its original TTL`, async ({ page, baseURL }, testInfo) => {
    const response = await page.request.get(new URL('/api/interactions', baseURL).href);
    expect(response.ok()).toBe(true);
    const catalog = await response.json();
    expect(catalog.version).toBe(1);
    const asset = catalog.items.find(item => item.id === id);
    expect(asset, `The finalized public catalog must include ${id}`).toMatchObject({ id, type: 'sprite', group: 'other' });
    expect(asset.revision).toMatch(/^[a-f0-9]{16}$/);
    expect(asset.src).toMatch(new RegExp(`^/assets/interactions/${id}/[^/]+\\.(png|webp)$`));
    expect(asset.audio).toMatch(new RegExp(`^/assets/interactions/${id}/[^/]+\\.wav$`));
    expect(asset.visualBytes).toBeGreaterThan(0);
    expect(asset.visualBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(asset.durationMs).toBeGreaterThan(0);
    expect(asset.durationMs).toBeLessThanOrEqual(3000);
    for (const key of ['width', 'height', 'columns', 'frames']) {
      expect(Number.isSafeInteger(asset[key]), `${id}.${key}`).toBe(true);
      expect(asset[key]).toBeGreaterThan(0);
    }
    expect(asset.width).toBeLessThanOrEqual(2048);
    expect(asset.height).toBeLessThanOrEqual(2048);
    expect(asset.columns).toBeLessThanOrEqual(Math.min(asset.frames, 64));
    expect(asset.frames).toBeLessThanOrEqual(256);
    const errors = await harness(page, baseURL, catalog.items, { liveCatalog: true });
    const decoded = await inspectRealSpriteAndAudio(page, asset);
    await testInfo.attach(`${id}-decoded-assets`, { contentType: 'application/json', body: Buffer.from(JSON.stringify(decoded, null, 2)) });
    expect(['png', 'webp']).toContain(decoded.sheet.format);
    expect(new URL(asset.src, baseURL).pathname.endsWith(`.${decoded.sheet.format}`),
      'catalog image extension must match the downloaded format signature').toBe(true);
    expect(decoded.sheet.bytes).toBe(asset.visualBytes);
    expect(decoded.sheet.width * decoded.sheet.height).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(decoded.sheet.width).toBe(asset.columns * asset.width);
    expect(decoded.sheet.height).toBe(Math.ceil(asset.frames / asset.columns) * asset.height);
    expect(decoded.frames).toHaveLength(asset.frames);
    const visibleFrames = decoded.frames.filter(frame => frame.visible > 50);
    expect(visibleFrames.length, 'some frames may intentionally be blank, but the animation must be visible').toBeGreaterThan(1);
    expect(new Set(visibleFrames.map(frame => frame.hash)).size).toBeGreaterThan(1);
    for (const frame of decoded.frames) {
      expect(frame.transparent, `transparent background in ${id} frame ${frame.frame}`).toBeGreaterThan(50);
      assertKeyedFrame(frame, asset, decoded.sheet.format);
    }
    expect(decoded.audio).toMatchObject({ riff: 'RIFF', wave: 'WAVE' });
    expect(decoded.audio.bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(decoded.audio.duration).toBeGreaterThan(0);
    expect(decoded.audio.duration).toBeLessThanOrEqual(3);
    expect(decoded.audio.samples * decoded.audio.channels * 4).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(decoded.audio.peak, 'real decoded WAV must not be silent').toBeGreaterThan(0);

    // Audio was decoded above without mocks; mute playback so visual clock control does not play sound.
    await page.locator('[data-room-video]').evaluate(video => { video.muted = true; });
    await choose(page, id);
    await clickPicture(page);
    await expect(page.locator(shellSelector)).not.toHaveClass(placing);
    await clickPicture(page);
    expect(await page.evaluate(() => window.__effectsHarness.sent.map(item => item.assetId))).toEqual([id]);
    await page.evaluate(() => window.__effects.clear());
    await installSpritePixelComparison(page, `${id}-real-sprite`);
    const event = await show(page, `${id}-real-sprite`, id);
    expect(event.receivedAge).toBe(0);
    const canvas = page.locator(canvasSelector);
    await expect(canvas).toHaveCount(1);
    const first = await canvas.evaluate(node => ({ ...window.__sampleEffectCanvas(node),
      pixelWidth: node.width, pixelHeight: node.height }));
    expect(first.at).toBe(event.receivedAt);
    expect(first.pixelWidth).toBe(asset.width);
    expect(first.pixelHeight).toBe(asset.height);
    expect(first.frame, 'age-zero render must show tile zero, including a legitimate blank entrance').toBe(0);
    assertSpriteFrame(first, asset, event);

    // Pick the strongest real frame, not a fixed midpoint which could be a blank entrance or tail.
    const strongest = visibleFrames.reduce((best, frame) => frame.visible > best.visible ? frame : best);
    const frameMs = asset.durationMs / asset.frames;
    const screenshotAge = Math.min(asset.durationMs - 1, Math.round((strongest.frame + 0.5) * frameMs));
    await advanceTo(page, event.receivedAt + screenshotAge);
    const fullFrame = await canvas.evaluate(node => window.__sampleEffectCanvas(node));
    expect(fullFrame.visible, 'screenshot captures the animation, not an intentional blank tail').toBeGreaterThan(50);
    await attachScreenshot(page, testInfo, `${id}-full-animation-frame`);
    await advanceTo(page, event.deadline - 1);
    await expect(canvas).toHaveCount(1);
    const effect = await page.evaluate(id => window.__effectPixels.effects[id], event.id);
    assertPixels(effect.samples);
    for (const frame of [first, fullFrame, ...effect.samples]) {
      expect(frame.at).toBeLessThan(event.deadline);
      assertKeyedFrame(frame, asset, decoded.sheet.format);
      assertSpriteFrame(frame, asset, event);
    }
    expect(new Set(effect.samples.filter(frame => frame.visible > 50).map(frame => frame.frame)).size,
      'distinct visible source frames must reach the renderer').toBeGreaterThan(1);
    await advanceTo(page, event.deadline + 32);
    await expect(canvas).toHaveCount(0);
    const removed = await page.evaluate(id => window.__effectPixels.effects[id].removed, event.id);
    expect(removed).toBeGreaterThanOrEqual(event.deadline);
    expect(removed).toBeLessThanOrEqual(event.deadline + 32);

    await choose(page, 'heart');
    const selectedAt = await page.evaluate(() => window.__effectsHarness.selections.at(-1).at);
    await clickPicture(page);
    await clickPicture(page, { x: 0.6, y: 0.45 });
    await expect(page.locator(shellSelector)).toHaveClass(placing);
    expect(await page.evaluate(() => window.__effectsHarness.sent.map(item => item.assetId))).toEqual([id, 'heart', 'heart']);
    await advanceTo(page, selectedAt + 3016);
    await expect(page.locator(shellSelector)).not.toHaveClass(placing);
    await clickPicture(page);
    expect(await page.evaluate(() => window.__effectsHarness.sent.length)).toBe(3);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.__effectPixels.errors)).toEqual([]);
    await testInfo.attach(`${id}-real-asset-observations`, { contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ asset, decoded, event, first, fullFrame, samples: effect.samples, removed,
        screenshotFrame: strongest.frame }, null, 2)) });
  });
}

for (const viewport of [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`${viewport.name}: groups are ordered and every builtin canvas is nonblank, moving, centered and bounded`, async ({ page, baseURL }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    // Scramble the catalog so the UI, not the fixture, supplies builtin grouping/order.
    const errors = await harness(page, baseURL, [other, fixtureItems[3], fixtureItems[1], fixtureItems[0], fixtureItems[2]]);
    await page.locator('[data-interaction-toggle]').click();
    await expect(page.locator('[data-interaction-group]')).toHaveText(['\u9884\u8bbe', '\u5176\u5b83']);
    expect(await page.locator('[data-interaction-assets]').evaluate(node => Array.from(node.children).map(child =>
      child.dataset.interactionGroup ? `group:${child.dataset.interactionGroup}` : child.dataset.interactionAsset)))
      .toEqual(['group:builtin', ...builtins, 'group:other', other.id]);
    for (const id of builtins) {
      const preview = page.locator(`[data-interaction-asset="${id}"] canvas`);
      await expect(preview).toHaveCount(1);
      expect(await preview.evaluate(canvas => window.__sampleEffectCanvas(canvas).visible)).toBeGreaterThan(50);
      await expect(page.locator(`[data-interaction-asset="${id}"] img`)).toHaveCount(0);
    }
    await assertNoOverflow(page);
    await attachScreenshot(page, testInfo, `${viewport.name}-groups`);
    await page.locator('[data-interaction-close]').click();
    for (const id of builtins) {
      const event = await show(page, `${viewport.name}-${id}`, id);
      await page.clock.runFor(720);
      const effect = await page.evaluate(id => window.__effectPixels.effects[id], event.id);
      expect(effect.effect).toBe(id);
      assertPixels(effect.samples);
      expect(effect.samples.every(sample => sample.at < event.deadline)).toBe(true);
      await attachScreenshot(page, testInfo, `${viewport.name}-${id}-moving`);
      await page.setViewportSize({ width: Math.min(720, viewport.width - 40), height: viewport.height });
      const resizedAt = await page.evaluate(() => performance.now());
      await page.clock.runFor(192);
      const resized = await page.evaluate(({ id, at }) => window.__effectPixels.effects[id].samples.filter(sample => sample.at > at + 48),
        { id: event.id, at: resizedAt });
      assertPixels(resized);
      expect(resized[0].pictureWidth).toBeLessThan(effect.samples[0].pictureWidth);
      await page.evaluate(() => window.__effects.clear());
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    }
    // Edge clicks clamp the canvas inside the video picture, not the shell's letterbox.
    await show(page, 'edge', 'fireworks', { x: 0.99, y: 0.01 });
    await page.clock.runFor(256);
    const edge = await page.locator(canvasSelector).evaluate(canvas => window.__sampleEffectCanvas(canvas));
    expect(edge.visible).toBeGreaterThan(50);
    expect(edge.overflow).toBeLessThanOrEqual(1);
    expect(edge.x).toBeLessThan(0.99);
    expect(edge.y).toBeGreaterThan(0.01);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.__effectPixels.errors)).toEqual([]);
  });
}

for (const direction of [-1, 1]) {
  test(`builtin repeat mode ends three monotonic seconds from selection despite wall-clock ${direction < 0 ? 'rollback' : 'advance'}`, async ({ page, baseURL }) => {
    await harness(page, baseURL);
    await choose(page, 'heart');
    const selectedAt = await page.evaluate(() => window.__effectsHarness.selections.at(-1).at);
    await advanceTo(page, selectedAt + 1100);
    await clickPicture(page);
    await expect(page.locator(shellSelector)).toHaveClass(placing);
    await page.clock.setSystemTime(await page.evaluate(delta => new Date(Date.now() + delta), direction * 3_600_000));
    await page.evaluate(delta => { window.__effectsHarness.clockOffset += delta; }, direction * 60_000);
    await advanceTo(page, selectedAt + 2250);
    await clickPicture(page, { x: 0.6, y: 0.45 });
    await expect(page.locator(shellSelector)).toHaveClass(placing);
    const sent = await page.evaluate(() => window.__effectsHarness.sent);
    expect(sent).toHaveLength(2);
    for (const event of sent) expect(event).toMatchObject({ assetId: 'heart', sourceId: 'source-current' });
    expect(sent[0].x).toBeCloseTo(center.x, 2);
    expect(sent[1].x).toBeCloseTo(0.6, 2);
    await advanceTo(page, selectedAt + 2990);
    await expect(page.locator(shellSelector)).toHaveClass(placing);
    await advanceTo(page, selectedAt + 3016);
    await expect(page.locator(shellSelector)).not.toHaveClass(placing);
    await clickPicture(page);
    await clickPicture(page, { x: 0.6, y: 0.45 });
    expect(await page.evaluate(() => window.__effectsHarness.sent.length)).toBe(2);
  });
}

test('unused builtin selection auto-exits; other media stays one-shot', async ({ page, baseURL }) => {
  await harness(page, baseURL);
  await choose(page, 'sakura');
  const selectedAt = await page.evaluate(() => window.__effectsHarness.selections.at(-1).at);
  await advanceTo(page, selectedAt + 3016);
  await expect(page.locator(shellSelector)).not.toHaveClass(placing);
  await clickPicture(page);
  expect(await page.evaluate(() => window.__effectsHarness.sent)).toEqual([]);
  await choose(page, other.id);
  await page.clock.runFor(3200);
  await expect(page.locator(shellSelector)).toHaveClass(placing);
  await clickPicture(page);
  await expect(page.locator(shellSelector)).not.toHaveClass(placing);
  await clickPicture(page);
  expect(await page.evaluate(() => window.__effectsHarness.sent.map(item => item.assetId))).toEqual([other.id]);
});

for (const method of ['Escape', 'cancel-button', 'contextmenu', 'visibility', 'source', 'local-source', 'disconnect', 'emptied', 'clear', 'disable']) {
  test(`builtin selection is invalidated by ${method} without leaking the next click`, async ({ page, baseURL }) => {
    await harness(page, baseURL);
    await choose(page, 'birthday');
    if (method === 'Escape') await page.keyboard.press('Escape');
    else if (method === 'cancel-button') await page.locator('.interaction-placement-cancel').click();
    else if (method === 'contextmenu') await clickPicture(page, center, { button: 'right' });
    else if (method === 'disable') {
      await page.locator('[data-interaction-toggle]').click();
      await page.locator('[data-interaction-enabled]').uncheck();
      await expect(page.locator('#interactionPopover')).toBeVisible();
      await page.locator('[data-interaction-close]').click();
    } else await page.evaluate(method => {
      const state = window.__effectsHarness;
      if (method === 'visibility') { state.hidden = true; document.dispatchEvent(new Event('visibilitychange')); }
      if (method === 'source') state.sourceId = state.localSourceId = 'source-replaced';
      if (method === 'local-source') state.localSourceId = 'source-loading';
      if (method === 'disconnect') state.connected = false;
      if (method === 'emptied') document.querySelector('video').dispatchEvent(new Event('emptied'));
      if (method === 'clear') window.__effects.clear();
    }, method);
    await page.clock.runFor(32);
    await expect(page.locator(shellSelector)).not.toHaveClass(placing);
    await page.evaluate(() => {
      Object.assign(window.__effectsHarness, { hidden: false, connected: true, sourceId: 'source-current', localSourceId: 'source-current' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await clickPicture(page);
    expect(await page.evaluate(() => window.__effectsHarness.sent)).toEqual([]);
    await choose(page, 'heart');
    await clickPicture(page);
    expect(await page.evaluate(() => window.__effectsHarness.sent.map(item => item.assetId))).toEqual(['heart']);
  });
}

test('late ACK from an old selection cannot cancel a new builtin selection', async ({ page, baseURL }) => {
  await harness(page, baseURL);
  await page.evaluate(() => { window.__effectsHarness.holdAck = true; });
  await choose(page, 'heart');
  await clickPicture(page);
  await page.keyboard.press('Escape');
  await choose(page, 'birthday');
  await page.evaluate(() => {
    window.__effectsHarness.holdAck = false;
    window.__effectsHarness.resolveAck({ ok: false, message: 'Old request failed' });
  });
  await expect(page.locator(shellSelector)).toHaveClass(placing);
  expect(await page.evaluate(() => window.__effectsHarness.notices)).toEqual([]);
  await clickPicture(page);
  expect(await page.evaluate(() => window.__effectsHarness.sent.map(item => item.assetId))).toEqual(['heart', 'birthday']);
});

for (const durationMs of [1200, 3000, 9000]) {
  test(`builtin arrival keeps the original TTL with duration ${durationMs}, duplication and clock corrections`, async ({ page, baseURL }) => {
    await harness(page, baseURL);
    const sentAt = await page.evaluate(() => window.__effectsHarness.now - 650);
    const event = await show(page, `ttl-${durationMs}`, 'heart', { sentAt, durationMs });
    await expect(page.locator(canvasSelector)).toHaveCount(1);
    await page.clock.runFor(128);
    await show(page, event.id, 'heart', { sentAt: await page.evaluate(() => window.__effectsHarness.now) });
    await expect(page.locator(canvasSelector)).toHaveCount(1);
    await page.clock.setSystemTime(await page.evaluate(() => new Date(Date.now() - 3_600_000)));
    await page.evaluate(() => { window.__effectsHarness.clockOffset -= 60_000; });
    await advanceTo(page, event.deadline - 32);
    await expect(page.locator(canvasSelector)).toHaveCount(1);
    await advanceTo(page, event.deadline + 32);
    await expect(page.locator(canvasSelector)).toHaveCount(0);
    const effect = await page.evaluate(id => window.__effectPixels.effects[id], event.id);
    expect(effect.removed).toBeGreaterThanOrEqual(event.deadline);
    expect(effect.removed).toBeLessThanOrEqual(event.deadline + 32);
    expect(effect.removed - effect.added).toBeLessThanOrEqual(Math.min(durationMs, 3000) - 650 + 32);
    await show(page, event.id);
    await expect(page.locator(canvasSelector)).toHaveCount(0);
    await show(page, 'already-expired', 'heart', { sentAt: await page.evaluate(() => window.__effectsHarness.now - 3000) });
    await expect(page.locator(canvasSelector)).toHaveCount(0);
  });
}

test('builtin active canvases stay capped at eight and clear on hide or source invalidation', async ({ page, baseURL }) => {
  await harness(page, baseURL);
  for (let i = 0; i < 12; i++) await show(page, `capacity-${i}`, builtins[i % builtins.length]);
  expect(await page.locator(canvasSelector).evaluateAll(nodes => nodes.map(node => node.dataset.interactionId)))
    .toEqual(Array.from({ length: 8 }, (_, i) => `capacity-${i + 4}`));
  await page.clock.runFor(128);
  expect(await page.evaluate(() => window.__effectPixels.maxActive)).toBe(8);
  await page.evaluate(() => { window.__effectsHarness.hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator(canvasSelector)).toHaveCount(0);
  await show(page, 'while-hidden');
  await page.evaluate(() => { window.__effectsHarness.hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await page.clock.runFor(32);
  await expect(page.locator(canvasSelector)).toHaveCount(0);
  await show(page, 'before-source-change');
  await page.evaluate(() => { window.__effectsHarness.sourceId = window.__effectsHarness.localSourceId = 'source-new'; });
  await page.clock.runFor(32);
  await expect(page.locator(canvasSelector)).toHaveCount(0);
  await show(page, 'stale-source', 'heart', { sourceId: 'source-current' });
  await expect(page.locator(canvasSelector)).toHaveCount(0);
  await show(page, 'new-source');
  await expect(page.locator(canvasSelector)).toHaveCount(1);
});

test('birthday event IDs select varying deterministic models and pixel output', async ({ page, baseURL }, testInfo) => {
  await harness(page, baseURL);
  const result = await page.evaluate(async () => {
    const api = window.TogetherSeeInteractions;
    const render = (id, progress) => {
      const model = api.createBuiltinEffect('birthday', id);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 320;
      api.drawBuiltinEffect(canvas.getContext('2d'), model, progress);
      const pixels = window.__sampleEffectCanvas(canvas);
      return { model, hash: pixels.hash, visible: pixels.visible };
    };
    const result = [];
    for (let index = 0; index < 24; index++) {
      const id = `birthday-seed-${index}`;
      const asset = window.__effectsHarness.items.find(item => item.id === 'birthday');
      await window.__effects.show({ id, assetId: asset.id, assetRevision: asset.revision,
        sourceId: 'source-current', x: 0.45, y: 0.42,
        sentAt: window.__effectsHarness.now - 1260, durationMs: 3000 });
      const canvas = document.querySelector('[data-interaction-layer] canvas');
      const received = { hash: window.__sampleEffectCanvas(canvas).hash,
        variant: Number(canvas.dataset.interactionVariant) };
      result.push({ id, received, first: render(id, 0.42), repeated: render(id, 0.42), later: render(id, 0.66) });
      window.__effects.clear();
    }
    return result;
  });
  for (const item of result) {
    expect(item.first).toEqual(item.repeated);
    expect(item.received).toEqual({ hash: item.first.hash, variant: item.first.model.variant });
    expect(item.first.visible).toBeGreaterThan(50);
    expect(item.later.hash).not.toBe(item.first.hash);
  }
  expect(new Set(result.map(item => item.first.model.variant)).size).toBeGreaterThan(1);
  expect(new Set(result.map(item => item.first.hash)).size).toBeGreaterThan(1);
  await testInfo.attach('birthday-seeds', { contentType: 'application/json', body: Buffer.from(JSON.stringify(result.map(item => ({
    id: item.id, variant: item.first.model.variant, hash: item.first.hash, laterHash: item.later.hash,
  })), null, 2)) });
});

async function installDeliveryProbe(context) {
  await context.addInitScript(() => {
    const state = window.__effectDelivery = { received: [], sent: [] };
    let module;
    Object.defineProperty(window, 'TogetherSeeInteractions', {
      configurable: true, get: () => module,
      set(value) {
        module = value;
        const create = value.create;
        value.create = function (options) {
          state.context = options.getContext;
          const api = create.call(this, { ...options, send: payload => {
            state.sent.push({ ...payload, at: performance.now() });
            return options.send(payload);
          } });
          const show = api.show;
          api.show = function (payload) {
            const context = options.getContext(), at = performance.now();
            const age = context.now - payload.sentAt;
            state.received.push({ ...payload, receivedAt: at, age,
              deadline: at + Math.min(payload.durationMs, 3000) - Math.max(0, age),
              context: { ...context, hidden: document.hidden } });
            return show.call(this, payload);
          };
          return api;
        };
      },
    });
  });
}

test('real desktop/mobile sockets deliver repeated builtin clicks with shared IDs and original deadlines', async ({ browser, baseURL }, testInfo) => {
  const contexts = await createRoomContexts(browser);
  await installDeliveryProbe(contexts.hostContext);
  await installDeliveryProbe(contexts.guestContext);
  const hostPage = await contexts.hostContext.newPage(), guestPage = await contexts.guestContext.newPage();
  const pair = { ...contexts, hostPage, guestPage };
  const wire = { host: [], guest: [] }, errors = [];
  for (const [peer, page] of [['host', hostPage], ['guest', guestPage]]) {
    page.on('pageerror', error => errors.push(`${peer}: ${error.message}`));
    page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string' || !/^42\d*\[/.test(payload)) return;
      try {
        const [name, event] = JSON.parse(payload.slice(payload.indexOf('[')));
        if (name === 'interaction_play') wire[peer].push(event);
      } catch { /* Ignore transport packets other than complete Socket.IO events. */ }
    }));
  }
  try {
    const clip = buildRepeatedFixtureWebM({ name: 'builtin-effects.webm', durationSeconds: 60 });
    const mediaUrl = 'https://93.184.216.34/builtin-effects-e2e.webm';
    for (const context of [contexts.hostContext, contexts.guestContext]) await installRemoteWebMFixture(context, {
      inputUrl: mediaUrl, mediaUrl, title: 'Builtin effects fixture', buffer: clip.buffer, mockParser: true,
    });
    const roomName = uniqueRoomName('BUILTIN');
    await createRoomFromHome(hostPage, baseURL, { roomName, nickname: 'Builtin Host' });
    await joinRoomFromHome(guestPage, baseURL, { roomName, nickname: 'Builtin Guest' });
    await expect(guestPage.locator('body')).toHaveAttribute('data-room-user-role', 'follower');
    await expect(hostPage.locator('[data-toolbar-member-count]')).toHaveText('2');
    await openRoomTab(hostPage, 'playlist');
    const form = hostPage.locator('[data-playlist-form]');
    await form.locator('input').fill(mediaUrl);
    await form.evaluate(node => node.requestSubmit());
    for (const [name, page] of [['desktop', hostPage], ['mobile', guestPage]]) {
      await waitForRemoteMediaReady(page, 'Builtin effects fixture');
      await expect.poll(() => page.evaluate(() => {
        const state = window.__effectDelivery.context();
        return Boolean(state.connected && state.sourceId && state.sourceId === state.localSourceId && !document.hidden);
      })).toBe(true);
      await page.evaluate(installVisualProbe);
      await page.locator(shellSelector).hover();
      await page.locator('[data-interaction-toggle]').click();
      await expect(page.locator('[data-interaction-group]')).toHaveText(['\u9884\u8bbe', '\u5176\u5b83']);
      await assertNoOverflow(page);
      await attachScreenshot(page, testInfo, `${name}-real-room-groups`);
      await page.locator('[data-interaction-close]').click();
    }
    await choose(guestPage, 'birthday');
    await clickPicture(guestPage);
    await clickPicture(guestPage, { x: 0.6, y: 0.45 });
    expect(await guestPage.evaluate(() => window.__effectDelivery.sent.length)).toBe(2);
    // Delivery and rendering have separate bounds; never sleep a fresh TTL after receipt.
    for (const [peer, page] of [['host', hostPage], ['guest', guestPage]]) {
      await expect.poll(() => wire[peer].length, { timeout: 6000 }).toBe(2);
      await expect.poll(() => page.evaluate(() => window.__effectDelivery.received.length)).toBe(2);
      const events = await page.evaluate(() => window.__effectDelivery.received);
      for (const event of events) {
        expect(event.assetId).toBe('birthday');
        expect(event.durationMs).toBeGreaterThan(0);
        expect(event.durationMs).toBeLessThanOrEqual(3000);
        expect(Number.isFinite(event.deadline)).toBe(true);
        expect(event.age).toBeGreaterThanOrEqual(-1000);
        expect(event.age).toBeLessThan(event.durationMs);
        expect(event.context).toMatchObject({ connected: true, hidden: false, sourceId: event.sourceId, localSourceId: event.sourceId });
        await expect.poll(() => page.evaluate(({ id, deadline }) => {
          const effect = window.__effectPixels.effects[id];
          return new Set((effect?.samples || []).filter(sample => sample.at < deadline && sample.visible > 50
            && sample.transparent > 50 && !sample.hidden).map(sample => sample.hash)).size;
        }, { id: event.id, deadline: event.deadline }), { timeout: 4000 }).toBeGreaterThan(1);
        const effect = await page.evaluate(id => window.__effectPixels.effects[id], event.id);
        assertPixels(effect.samples.filter(sample => sample.at < event.deadline), { x: event.x, y: event.y });
      }
      await expect.poll(() => page.evaluate(() => window.__effectDelivery.received.every(event =>
        Number.isFinite(window.__effectPixels.effects[event.id]?.removed))), { timeout: 5000 }).toBe(true);
      const effects = await page.evaluate(() => window.__effectPixels.effects);
      for (const event of events) {
        expect(effects[event.id].removed).toBeGreaterThanOrEqual(event.deadline - 1);
        // A real browser may schedule its removal frame late; controlled tests enforce the tight bound.
        expect(effects[event.id].removed).toBeLessThanOrEqual(event.deadline + 500);
      }
    }
    expect(wire.host.map(event => event.id)).toEqual(wire.guest.map(event => event.id));
    expect(new Set(wire.host.map(event => event.id)).size).toBe(2);
    const hostVariants = await hostPage.evaluate(() => Object.values(window.__effectPixels.effects).map(effect => effect.variant));
    const guestVariants = await guestPage.evaluate(() => Object.values(window.__effectPixels.effects).map(effect => effect.variant));
    expect(hostVariants).toEqual(guestVariants);
    await expect(guestPage.locator(shellSelector)).not.toHaveClass(placing);
    await clickPicture(guestPage);
    expect(await guestPage.evaluate(() => window.__effectDelivery.sent.length)).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    for (const [peer, page] of [['host', hostPage], ['guest', guestPage]]) {
      const observations = await page.evaluate(() => ({ received: window.__effectDelivery?.received, pixels: window.__effectPixels })).catch(() => null);
      await testInfo.attach(`${peer}-builtin-delivery`, { contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ wire: wire[peer], observations, errors }, null, 2)) });
    }
    await closeRoomContexts(pair);
  }
});
