import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { createRoomContexts, createRoomFromHome, joinRoomFromHome, openRoomTab, playlistItem,
  readMediaState, waitForRemoteMediaReady, uniqueRoomName, sendChatMessage } from './helpers/room.mjs';
import { buildRepeatedFixtureWebM, installRemoteWebMFixture } from './helpers/media.mjs';

test('source preparation and interrupted guest play converge without repeated loads', async ({ browser, baseURL }) => {
  const { hostContext, guestContext } = await createRoomContexts(browser);
  let blockHost = true;
  const clip = buildRepeatedFixtureWebM({ durationSeconds: 60 });
  try {
    for (const context of [hostContext, guestContext]) {
      for (const name of ['A', 'B']) {
        await installRemoteWebMFixture(context, {
          inputUrl: `https://93.184.216.34/prepare-${name}.webm`,
          mediaUrl: `https://93.184.216.34/prepare-${name}.webm`,
          title: `Prepare ${name}`, buffer: clip.buffer, mockParser: true,
          ...(context === hostContext && name === 'B' ? { networkProfile: () => ({ blocked: blockHost }) } : {}),
        });
      }
    }
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const errors = [];
    host.on('pageerror', error => errors.push(error.message));
    guest.on('pageerror', error => errors.push(error.message));
    const roomName = uniqueRoomName('PREP');
    await createRoomFromHome(host, baseURL, { roomName });
    await joinRoomFromHome(guest, baseURL, { roomName });
    await openRoomTab(host, 'playlist');
    async function add(name) {
      const form = host.locator('[data-playlist-form]');
      await form.locator('input').fill(`https://93.184.216.34/prepare-${name}.webm`);
      await form.evaluate(node => node.requestSubmit());
      await expect(playlistItem(host, `Prepare ${name}`)).toHaveCount(1);
    }
    await add('A');
    await waitForRemoteMediaReady(host, 'Prepare A');
    await waitForRemoteMediaReady(guest, 'Prepare A');
    await host.locator('label.toggle-row').click();
    await expect(host.locator('[data-autoplay-next]')).toBeChecked();
    await add('B');
    await guest.evaluate(() => {
      const video = window.TogetherSeePlayer.video;
      const play = video.play.bind(video);
      window.__playCalls = 0;
      video.play = () => {
        window.__playCalls += 1;
        return window.__playCalls === 1 ? Promise.reject(new DOMException('fixture', 'AbortError')) : play();
      };
    });
    await playlistItem(host, 'Prepare B').click();
    await waitForRemoteMediaReady(guest, 'Prepare B');
    await guest.waitForTimeout(1000);
    expect((await readMediaState(guest)).paused).toBe(true);
    expect((await readMediaState(guest)).currentTime).toBeLessThan(0.2);
    expect(await guest.evaluate(() => window.__playCalls)).toBe(0);
    blockHost = false;
    await waitForRemoteMediaReady(host, 'Prepare B');
    await expect.poll(async () => (await readMediaState(host)).paused).toBe(false);
    await expect.poll(async () => (await readMediaState(guest)).paused).toBe(false);
    expect(await guest.evaluate(() => window.__playCalls)).toBe(2);
    await expect.poll(async () => (await readMediaState(guest)).currentTime).toBeGreaterThan(0.5);

    await guest.evaluate(() => {
      const player = window.TogetherSeePlayer;
      player.setTimelineDanmaku(Array.from({ length: 300 }, (_, i) => ({
        id: `source-${i}`, text: 'source fixture', time: player.video.currentTime + i / 100,
      })), 'dense-fixture');
    });
    await openRoomTab(host, 'chat');
    await sendChatMessage(host, 'live one');
    const live = guest.locator('.is-room-danmaku').filter({ hasText: 'live one' });
    await expect(live).toHaveCount(1, { timeout: 1500 });
    await sendChatMessage(host, 'live two');
    await expect(guest.locator('.is-room-danmaku').filter({ hasText: 'live two' })).toHaveCount(1, { timeout: 2000 });
    const original = await live.getAttribute('data-danmaku-id');
    await guest.evaluate(() => { window.TogetherSeePlayer.video.currentTime += 0.2; });
    await expect(guest.locator(`[data-danmaku-id="${original}"]`)).toHaveCount(1);

    await host.locator('[data-player-play]').click({ force: true });
    await expect.poll(async () => (await readMediaState(guest)).paused).toBe(true);
    await guest.evaluate(() => {
      const video = window.TogetherSeePlayer.video;
      window.__nativePlay = HTMLMediaElement.prototype.play.bind(video);
      window.__deniedCalls = 0;
      video.play = () => { window.__deniedCalls += 1; return Promise.reject(new DOMException('fixture', 'NotAllowedError')); };
    });
    await host.locator('[data-player-play]').click({ force: true });
    await expect.poll(() => guest.evaluate(() => window.__deniedCalls)).toBe(1);
    await guest.waitForTimeout(2800);
    expect(await guest.evaluate(() => window.__deniedCalls)).toBe(1);
    expect((await readMediaState(guest)).paused).toBe(true);
    await guest.evaluate(() => { window.TogetherSeePlayer.video.play = window.__nativePlay; });
    await guest.locator('[data-player-center-play]').click({ force: true });
    await expect.poll(async () => (await readMediaState(guest)).paused).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    blockHost = false;
    await guestContext.close();
    await hostContext.close();
  }
});

test('first-item autoplay and manual intent survive a delayed source ACK', async ({ browser, baseURL }) => {
  const { hostContext, guestContext } = await createRoomContexts(browser);
  const clip = buildRepeatedFixtureWebM({ durationSeconds: 60 });
  const roomScript = await fs.readFile(new URL('../../assets/js/room.js', import.meta.url), 'utf8');
  await hostContext.route('**/assets/js/room.js*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `{
      const originalIo = window.io;
      window.io = function (...args) {
        const socket = originalIo(...args);
        const emit = socket.emit.bind(socket);
        window.__playbackActions = [];
        socket.emit = function (event, payload, ack) {
          if (event === 'playback_update') {
            window.__playbackActions.push(payload.action);
            if (payload.action === 'source' && window.__delaySourceAck) {
              return emit(event, payload, (...values) => {
                window.__releaseSourceAck = () => {
                  window.__releaseSourceAck = null;
                  ack(...values);
                };
              });
            }
          }
          return emit(event, payload, ack);
        };
        return socket;
      };
    }\n${roomScript}`,
  }));
  try {
    for (const context of [hostContext, guestContext]) {
      for (const name of ['A', 'B']) {
        await installRemoteWebMFixture(context, {
          inputUrl: `https://93.184.216.34/intent-${name}.webm`,
          mediaUrl: `https://93.184.216.34/intent-${name}.webm`,
          title: `Intent ${name}`, buffer: clip.buffer, mockParser: true,
        });
      }
    }
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const roomName = uniqueRoomName('INTENT');
    await createRoomFromHome(host, baseURL, { roomName });
    await joinRoomFromHome(guest, baseURL, { roomName });
    await openRoomTab(host, 'playlist');
    await host.locator('label.toggle-row').click();
    await expect(host.locator('[data-autoplay-next]')).toBeChecked();
    for (const name of ['A', 'B']) {
      const form = host.locator('[data-playlist-form]');
      await form.locator('input').fill(`https://93.184.216.34/intent-${name}.webm`);
      await form.evaluate(node => node.requestSubmit());
      await expect(playlistItem(host, `Intent ${name}`)).toHaveCount(1);
      if (name === 'A') {
        await waitForRemoteMediaReady(host, 'Intent A');
        await waitForRemoteMediaReady(guest, 'Intent A');
        await expect.poll(async () => (await readMediaState(guest)).paused).toBe(false);
        expect(await host.evaluate(() => window.__playbackActions.filter(action => action === 'play').length)).toBe(1);
      }
    }
    await host.locator('[data-player-play]').click({ force: true });
    await expect.poll(async () => (await readMediaState(guest)).paused).toBe(true);
    await host.evaluate(() => { window.__delaySourceAck = true; window.__playbackActions = []; });
    await playlistItem(host, 'Intent B').click();
    await waitForRemoteMediaReady(host, 'Intent B');
    await waitForRemoteMediaReady(guest, 'Intent B');
    await expect.poll(() => host.evaluate(() => typeof window.__releaseSourceAck)).toBe('function');
    await host.locator('[data-player-play]').click({ force: true });
    expect((await readMediaState(host)).paused).toBe(false);
    expect((await readMediaState(guest)).paused).toBe(true);
    expect(await host.evaluate(() => window.__playbackActions)).toEqual(['source']);
    await host.evaluate(() => window.__releaseSourceAck());
    await expect.poll(async () => (await readMediaState(guest)).paused).toBe(false);
    expect(await host.evaluate(() => window.__playbackActions.filter(action => action === 'play').length)).toBe(1);

    await host.evaluate(() => { window.__playbackActions = []; });
    await playlistItem(host, 'Intent A').click();
    await waitForRemoteMediaReady(host, 'Intent A');
    await waitForRemoteMediaReady(guest, 'Intent A');
    await expect.poll(() => host.evaluate(() => typeof window.__releaseSourceAck)).toBe('function');
    await host.locator('[data-player-play]').click({ force: true });
    await expect.poll(async () => (await readMediaState(host)).paused).toBe(false);
    await host.locator('[data-player-play]').click({ force: true });
    await host.evaluate(() => window.__releaseSourceAck());
    await guest.waitForTimeout(1500);
    expect((await readMediaState(host)).paused).toBe(true);
    expect((await readMediaState(guest)).paused).toBe(true);
    expect(await host.evaluate(() => window.__playbackActions.filter(action => action === 'play').length)).toBe(0);

    await host.locator('label.toggle-row').click();
    await expect(host.locator('[data-autoplay-next]')).not.toBeChecked();
    await host.evaluate(() => { window.__playbackActions = []; });
    await playlistItem(host, 'Intent B').click();
    await waitForRemoteMediaReady(host, 'Intent B');
    await waitForRemoteMediaReady(guest, 'Intent B');
    await expect.poll(() => host.evaluate(() => typeof window.__releaseSourceAck)).toBe('function');
    await host.evaluate(() => {
      const video = window.TogetherSeePlayer.video;
      const play = video.play.bind(video);
      video.play = () => play().then(() => new Promise(resolve => {
        window.__completeManualPlay = () => { video.play = play; resolve(); };
      }));
    });
    await host.locator('[data-player-play]').click({ force: true });
    await expect.poll(() => host.evaluate(() => typeof window.__completeManualPlay)).toBe('function');
    await host.evaluate(() => window.__releaseSourceAck());
    expect(await host.evaluate(() => window.__playbackActions)).toEqual(['source']);
    await host.evaluate(() => window.__completeManualPlay());
    await expect.poll(async () => (await readMediaState(guest)).paused).toBe(false);
    expect(await host.evaluate(() => window.__playbackActions.filter(action => action === 'play').length)).toBe(1);
  } finally {
    await guestContext.close();
    await hostContext.close();
  }
});
