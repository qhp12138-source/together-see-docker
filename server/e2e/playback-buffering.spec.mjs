import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { buildRepeatedFixtureWebM, installRemoteWebMFixture } from './helpers/media.mjs';

const asset = name => fs.readFileSync(new URL(`../../assets/js/${name}`, import.meta.url), 'utf8');
const fixture = buildRepeatedFixtureWebM({ name: 'buffering.webm', durationSeconds: 90 });
const origin = 'https://buffering.example';

async function bootPlayer(page, withHls = false) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(`<div data-player-shell>
    <video data-room-video muted playsinline width="640" height="360"></video>
    <button data-player-play></button><button data-player-rate></button>
    <span data-player-playback-status></span>
  </div>`);
  await page.addScriptTag({ content: asset('recovery.js') });
  await page.addScriptTag({ content: asset('direct-media.js') });
  if (withHls) await page.addScriptTag({ content: asset('hls.js') });
  await page.evaluate(() => {
    window.__buffering = { commands: [], events: [], hls: [] };
    window.addEventListener('together-see:playback-user-action', event => {
      window.__buffering.commands.push(event.detail.action);
    });
    const video = document.querySelector('video');
    for (const name of ['pause', 'play', 'loadstart', 'emptied']) {
      video.addEventListener(name, () => window.__buffering.events.push(name));
    }
    if (window.Hls) {
      const NativeHls = window.Hls;
      window.Hls = new Proxy(NativeHls, {
        construct(target, args) {
          const instance = Reflect.construct(target, args);
          const entry = { instance, starts: 0 };
          window.__buffering.hls.push(entry);
          const startLoad = instance.startLoad.bind(instance);
          instance.startLoad = (...params) => { entry.starts += 1; return startLoad(...params); };
          return instance;
        },
      });
      const canPlayType = video.canPlayType.bind(video);
      video.canPlayType = type => /mpegurl/i.test(type) ? '' : canPlayType(type);
    }
  });
  await page.addScriptTag({ content: asset('player.js') });
  return errors;
}

test('real hls.js does not abort a slow fragment on pause refill or repeated paused snapshots', async ({ page }) => {
  // Real Hls.js/MSE loading, mocked HTTP manifests and a held segment response.
  // This checks loader lifecycle, not TS decoding or third-party availability.
  let releaseFragment;
  const fragmentGate = new Promise(resolve => { releaseFragment = resolve; });
  let fragmentRequests = 0;
  let failedFragments = 0;
  const unexpected = [];
  page.on('requestfailed', request => {
    if (request.url() === `${origin}/slow.ts`) failedFragments += 1;
  });
  await page.route(`${origin}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/slow.ts') {
      fragmentRequests += 1;
      await fragmentGate;
      await route.abort().catch(() => {});
      return;
    }
    const body = pathname === '/master.m3u8'
      ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.42e01e,mp4a.40.2"\nmedia.m3u8\n'
      : pathname === '/media.m3u8'
        ? '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nslow.ts\n#EXT-X-ENDLIST\n'
        : null;
    if (!body) { unexpected.push(pathname); await route.abort(); return; }
    await route.fulfill({ status: 200, body, contentType: 'application/vnd.apple.mpegurl',
      headers: { 'access-control-allow-origin': '*' } });
  });
  const errors = await bootPlayer(page, true);
  try {
    await page.evaluate(url => {
      window.TogetherSeePlayer.loadSource({ id: 'slow-hls', sourceType: 'hls',
        sourceUrl: url, clientDirectOnly: true }, { useProxy: false });
    }, `${origin}/master.m3u8`);
    await expect.poll(() => fragmentRequests).toBe(1);
    await page.evaluate(() => {
      const player = window.TogetherSeePlayer;
      player.video.dispatchEvent(new Event('pause'));
      for (let index = 0; index < 12; index++) player.resumeBuffering();
    });
    await page.waitForTimeout(4000); // Cross the production 3500 ms pause-refill timer.
    expect(fragmentRequests).toBe(1);
    expect(failedFragments).toBe(0);
    expect(await page.evaluate(() => ({ starts: window.__buffering.hls[0].starts,
      loading: window.__buffering.hls[0].instance.loadingEnabled,
      paused: window.TogetherSeePlayer.video.paused,
      commands: window.__buffering.commands }))).toEqual({ starts: 1, loading: true, paused: true, commands: [] });
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(() => window.TogetherSeePlayer.clearSource()).catch(() => {});
    releaseFragment();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

async function prepareRateFixture(page) {
  await installRemoteWebMFixture(page.context(), {
    mediaUrl: `${origin}/clip.webm`, buffer: fixture.buffer, mimeType: fixture.mimeType,
  });
  const errors = await bootPlayer(page);
  await page.evaluate(url => window.TogetherSeePlayer.loadSource({
    id: 'rate-video', sourceType: 'video', sourceUrl: url, clientDirectOnly: true,
  }, { playWhenReady: true, playbackRate: 1.5 }), `${origin}/clip.webm`);
  await expect.poll(() => page.evaluate(() => {
    const video = window.TogetherSeePlayer.video;
    return !video.paused && !video.seeking && video.readyState >= 3;
  })).toBe(true);
  await page.evaluate(() => {
    const player = window.TogetherSeePlayer;
    player.setDesiredPlaybackState({ activeSourceId: 'rate-video', playbackRate: 1.5, playing: true });
    // Real decoding/playback; only the buffer observation is controlled deterministically.
    window.__buffering.ahead = 20;
    window.__buffering.gap = 0;
    Object.defineProperty(player.video, 'buffered', { configurable: true, get() {
      const start = this.currentTime + window.__buffering.gap;
      return { length: 1, start: () => start, end: () => start + window.__buffering.ahead };
    } });
    window.__buffering.events = [];
  });
  return errors;
}

test('draining buffer cancels catch-up without pausing, reloading or resurrecting stale acceleration', async ({ page }) => {
  const errors = await prepareRateFixture(page);
  const result = await page.evaluate(() => {
    const player = window.TogetherSeePlayer;
    const video = player.video;
    const time = video.currentTime;
    player.setExternalPlaybackRate(2, { temporary: true });
    const healthy = video.playbackRate;
    window.__buffering.ahead = 3;
    video.dispatchEvent(new Event('timeupdate'));
    const starved = video.playbackRate;
    window.__buffering.ahead = 6;
    player.setExternalPlaybackRate(2, { temporary: true });
    const hysteresis = video.playbackRate;
    window.__buffering.ahead = 20;
    video.dispatchEvent(new Event('progress'));
    const afterRefill = video.playbackRate;
    player.setExternalPlaybackRate(2, { temporary: true });
    const fresh = video.playbackRate;
    return { healthy, starved, hysteresis, afterRefill, fresh, time,
      generation: player.getLoadToken().generation, commands: window.__buffering.commands };
  });
  expect(result).toMatchObject({ healthy: 2, starved: 1.5, hysteresis: 1.5, afterRefill: 1.5, fresh: 2, commands: [] });
  await expect.poll(() => page.evaluate(() => window.TogetherSeePlayer.video.currentTime)).toBeGreaterThan(result.time + 1);
  expect(await page.evaluate(() => ({ paused: window.TogetherSeePlayer.video.paused,
    generation: window.TogetherSeePlayer.getLoadToken().generation, events: window.__buffering.events })))
    .toEqual({ paused: false, generation: result.generation, events: [] });
  expect(errors).toEqual([]);
});

test('future buffered ranges are not runway and explicit pause/base speed remain authoritative', async ({ page }) => {
  const errors = await prepareRateFixture(page);
  const result = await page.evaluate(() => {
    const player = window.TogetherSeePlayer;
    const video = player.video;
    window.__buffering.gap = 10;
    player.setExternalPlaybackRate(2, { temporary: true });
    const gap = { ahead: player.getForwardBufferSeconds(), rate: video.playbackRate };
    player.setDesiredPlaybackState(null);
    player.setExternalPlaybackRate(2);
    const explicitRate = video.playbackRate;
    video.pause();
    player.setExternalPlaybackRate(2.5, { temporary: true });
    video.dispatchEvent(new Event('progress'));
    return { gap, explicitRate, paused: video.paused, finalRate: video.playbackRate,
      generation: player.getLoadToken().generation, commands: window.__buffering.commands };
  });
  expect(result).toMatchObject({ gap: { ahead: 0, rate: 1.5 }, explicitRate: 2, paused: true, finalRate: 2, commands: [] });
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => ({ paused: window.TogetherSeePlayer.video.paused,
    rate: window.TogetherSeePlayer.video.playbackRate, generation: window.TogetherSeePlayer.getLoadToken().generation })))
    .toEqual({ paused: true, rate: 2, generation: result.generation });
  expect(errors).toEqual([]);
});
