import { test, expect } from '@playwright/test';
import {
  applyLocalPlaybackAction,
  capturePageErrors,
  chooseLocalVideo,
  closeRoomContexts,
  createRoomContexts,
  createRoomFromHome,
  expectChatMessage,
  expectTimeNear,
  installMediaCounters,
  joinRoomFromHome,
  openRoomTab,
  playlistItem,
  readMediaCounters,
  readMediaState,
  sendChatMessage,
  setAutoSync,
  uniqueRoomName,
  waitForMediaReady,
  waitForRemoteMediaReady,
} from './helpers/room.mjs';
import {
  buildRepeatedFixtureWebM,
  installRemoteWebMFixture,
  loadFixtureWebM,
  mediaResponse,
} from './helpers/media.mjs';

test('desktop host and mobile guest keep playback stable across playlist and sync changes', async ({ browser, baseURL }) => {
  const roomName = uniqueRoomName('PW');
  const { hostContext, guestContext } = await createRoomContexts(browser);
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();
  const hostErrors = capturePageErrors(hostPage, 'host');
  const guestErrors = capturePageErrors(guestPage, 'guest');

  try {
    await createRoomFromHome(hostPage, baseURL, { roomName, nickname: 'Desktop Host' });
    await joinRoomFromHome(guestPage, baseURL, { roomName, nickname: 'Mobile Guest' });
    await expect(hostPage.locator('[data-toolbar-member-count]')).toHaveText('2');
    await expect(guestPage.locator('[data-toolbar-member-count]')).toHaveText('2');

    const hostMessage = `host-${Date.now()}`;
    const guestMessage = `guest-${Date.now()}`;
    await sendChatMessage(hostPage, hostMessage);
    await expectChatMessage(guestPage, hostMessage);
    await sendChatMessage(guestPage, guestMessage);
    await expectChatMessage(hostPage, guestMessage);

    const clipA = buildRepeatedFixtureWebM({
      name: 'clip-a.webm',
      durationSeconds: 20,
    });
    const clipB = buildRepeatedFixtureWebM({
      name: 'clip-b.webm',
      durationSeconds: 20,
    });

    await openRoomTab(hostPage, 'playlist');
    await chooseLocalVideo(hostPage, clipA);
    await waitForMediaReady(hostPage, clipA.name);

    await openRoomTab(guestPage, 'playlist');
    await expect(playlistItem(guestPage, clipA.name)).toHaveCount(1);
    await chooseLocalVideo(guestPage, clipA);
    await waitForMediaReady(guestPage, clipA.name);

    const bufferingReadiness = await hostPage.evaluate(async () => {
      const video = document.querySelector('[data-room-video]');
      video.muted = true;
      await video.play();
      const before = window.TogetherSeePlayer.isMediaReadyForSync();
      video.dispatchEvent(new Event('waiting'));
      const during = window.TogetherSeePlayer.isMediaReadyForSync();
      video.dispatchEvent(new Event('canplaythrough'));
      const after = window.TogetherSeePlayer.isMediaReadyForSync();
      video.pause();
      return { before, during, after };
    });
    expect(bufferingReadiness).toEqual({ before: true, during: false, after: true });

    await hostPage.locator('[data-room-video]').evaluate((video) => { video.muted = true; });
    await hostPage.locator('[data-player-play]').click({ force: true });
    await expect.poll(async () => (await readMediaState(guestPage)).paused).toBe(false);
    await hostPage.locator('[data-room-video]').evaluate((video) => {
      Object.defineProperty(video, 'readyState', { configurable: true, get: () => 2 });
      Object.defineProperty(video, 'buffered', {
        configurable: true,
        get: () => ({ length: 0, start: () => 0, end: () => 0 }),
      });
      video.dispatchEvent(new Event('waiting'));
    });
    await expect.poll(async () => (await readMediaState(guestPage)).paused, { timeout: 3000 }).toBe(true);
    await hostPage.locator('[data-room-video]').evaluate((video) => {
      delete video.readyState;
      delete video.buffered;
      video.dispatchEvent(new Event('playing'));
    });
    await expect.poll(async () => (await readMediaState(guestPage)).paused, { timeout: 3000 }).toBe(false);
    await hostPage.locator('[data-player-play]').click({ force: true });
    await expect.poll(async () => (await readMediaState(guestPage)).paused).toBe(true);

    await installMediaCounters(hostPage);
    await installMediaCounters(guestPage);
    const hostA = await readMediaState(hostPage);
    const guestA = await readMediaState(guestPage);
    const hostCountersA = await readMediaCounters(hostPage);
    const guestCountersA = await readMediaCounters(guestPage);

    const inputUrl = 'https://93.184.216.34/e2e-input-b.webm';
    const mediaUrl = 'https://93.184.216.34/e2e-clip-b.webm';
    await installRemoteWebMFixture(hostContext, {
      inputUrl,
      mediaUrl,
      title: 'Clip B',
      buffer: clipB.buffer,
      mimeType: clipB.mimeType,
      mockParser: true,
    });
    await installRemoteWebMFixture(guestContext, {
      inputUrl,
      mediaUrl,
      title: 'Clip B',
      buffer: clipB.buffer,
      mimeType: clipB.mimeType,
    });

    const playlistForm = hostPage.locator('[data-playlist-form]');
    await playlistForm.locator('input[name="videoLink"]').fill(inputUrl);
    await playlistForm.evaluate((form) => form.requestSubmit());
    await expect(playlistItem(hostPage, 'Clip B')).toHaveCount(1);
    await expect(playlistItem(guestPage, 'Clip B')).toHaveCount(1);

    const hostAfterAdd = await readMediaState(hostPage);
    const guestAfterAdd = await readMediaState(guestPage);
    expect(hostAfterAdd.sourceId).toBe(hostA.sourceId);
    expect(guestAfterAdd.sourceId).toBe(guestA.sourceId);
    expect(hostAfterAdd.currentSrc).toBe(hostA.currentSrc);
    expect(guestAfterAdd.currentSrc).toBe(guestA.currentSrc);
    expect(await readMediaCounters(hostPage)).toEqual(hostCountersA);
    expect(await readMediaCounters(guestPage)).toEqual(guestCountersA);

    await setAutoSync(guestPage, false);
    await guestPage.locator('[data-player-rate]').click({ force: true });
    await expect(guestPage.locator('[data-player-rate]')).toHaveText('1.25x');
    await applyLocalPlaybackAction(guestPage, { currentTime: 0.35, action: 'seek' });
    const guestLocalA = await readMediaState(guestPage);
    const hostBeforeSwitch = await readMediaState(hostPage);
    await expect.poll(() => readMediaState(hostPage)).toMatchObject({
      sourceId: hostBeforeSwitch.sourceId,
      playbackRate: hostBeforeSwitch.playbackRate,
    });

    await playlistItem(hostPage, 'Clip B').click();
    await waitForRemoteMediaReady(hostPage, 'Clip B');
    await waitForRemoteMediaReady(guestPage, 'Clip B');
    const guestLocalB = await readMediaState(guestPage);
    expect(guestLocalB.paused).toBe(guestLocalA.paused);
    expect(guestLocalB.playbackRate).toBeCloseTo(guestLocalA.playbackRate, 2);
    expectTimeNear(guestLocalB.currentTime, 0, 0.2);

    await applyLocalPlaybackAction(hostPage, { currentTime: 1.25, playbackRate: 1, action: 'seek' });
    await expect.poll(() => readMediaState(hostPage)).toMatchObject({ currentTime: expect.any(Number) });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const guestStillLocal = await readMediaState(guestPage);
    expectTimeNear(guestStillLocal.currentTime, 0, 0.2);

    await setAutoSync(guestPage, true);
    await expect.poll(async () => {
      const [hostState, guestState] = await Promise.all([readMediaState(hostPage), readMediaState(guestPage)]);
      return Math.abs(hostState.currentTime - guestState.currentTime);
    }).toBeLessThanOrEqual(0.25);

    expect(hostErrors).toEqual([]);
    expect(guestErrors).toEqual([]);
  } finally {
    await closeRoomContexts({ hostContext, guestContext, hostPage, guestPage });
  }
});

test('Bilibili media preserves playback intent across one fallback and compact controls stay centered', async ({ browser, baseURL }) => {
  const roomName = uniqueRoomName('BILI');
  const { hostContext, guestContext } = await createRoomContexts(browser);
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();
  const media = buildRepeatedFixtureWebM({
    name: 'bilibili-direct.webm',
    durationSeconds: 30,
  });
  const mediaUrl = 'https://93.184.216.34/e2e-bilibili-direct.webm';
  const fallbackMediaUrl = 'https://upos-hz-mirrorakam.akamaized.net/e2e-bilibili-fallback.webm';
  const proxyRequests = [];
  let directFallbackRequests = 0;

  hostPage.on('request', (request) => {
    if (request.url().includes('/api/proxy/media')) proxyRequests.push(request.url());
  });

  try {
    await installRemoteWebMFixture(hostContext, {
      inputUrl: mediaUrl,
      mediaUrl,
      title: 'Bilibili Direct',
      buffer: media.buffer,
      mimeType: media.mimeType,
    });
    await hostContext.route(fallbackMediaUrl, async (route) => {
      directFallbackRequests += 1;
      await route.abort('failed');
    });
    await hostContext.route('**/api/proxy/media?fixture=bilibili-fallback', async (route) => {
      await route.fulfill(mediaResponse(media.buffer, media.mimeType, route.request().headers().range));
    });
    await createRoomFromHome(hostPage, baseURL, { roomName, nickname: 'Direct Host' });
    await hostPage.setViewportSize({ width: 797, height: 818 });

    const loaded = await hostPage.evaluate((source) => window.TogetherSeePlayer.loadSource(source, {
      playWhenReady: false,
    }), {
      id: 'bilibili-direct-source',
      title: 'Bilibili Direct',
      pageUrl: 'https://www.bilibili.com/video/BV1182FBRExJ',
      refererUrl: 'https://www.bilibili.com/video/BV1182FBRExJ',
      sourceUrl: mediaUrl,
      sourceType: 'video',
      bilibili: {
        bvid: 'BV1182FBRExJ',
        cid: 1,
        page: 1,
        quality: 64,
        qualityLabel: '720P 高清',
        danmakuAvailable: true,
        danmakuEnabled: false,
      },
    });
    expect(loaded).toBe(true);
    await expect.poll(() => readMediaState(hostPage)).toMatchObject({
      sourceId: 'bilibili-direct-source',
      readyState: expect.any(Number),
    });
    await expect.poll(async () => (await readMediaState(hostPage)).readyState).toBeGreaterThanOrEqual(3);

    const playbackMode = await hostPage.evaluate(() => {
      const video = document.querySelector('[data-room-video]');
      return {
        mediaProxy: video.dataset.mediaProxy,
        referrerPolicy: video.referrerPolicy,
        currentSrc: video.currentSrc,
      };
    });
    expect(playbackMode.mediaProxy).toBe('false');
    expect(playbackMode.referrerPolicy).toBe('no-referrer');
    expect(playbackMode.currentSrc).toBe(mediaUrl);
    expect(proxyRequests).toEqual([]);

    await hostContext.route('**/api/proxy/media?fixture=bilibili-stall', async (route) => {
      await route.fulfill(mediaResponse(media.buffer, media.mimeType, route.request().headers().range));
    });
    await hostPage.evaluate(async () => {
      const video = document.querySelector('[data-room-video]');
      window.TogetherSeeRoomProxy.request = () => {
        delete video.readyState;
        delete video.buffered;
        return Promise.resolve({
          proxyUrl: `${window.location.origin}/api/proxy/media?fixture=bilibili-stall`,
        });
      };
      video.muted = true;
      await video.play();
      Object.defineProperty(video, 'readyState', { configurable: true, get: () => 2 });
      Object.defineProperty(video, 'buffered', {
        configurable: true,
        get: () => ({ length: 0, start: () => 0, end: () => 0 }),
      });
      video.dispatchEvent(new Event('waiting'));
    });
    await expect.poll(async () => hostPage.locator('[data-room-video]').evaluate((video) => ({
      mediaProxy: video.dataset.mediaProxy,
      paused: video.paused,
    })), { timeout: 12_000 }).toEqual({ mediaProxy: 'true', paused: false });
    expect(proxyRequests).toHaveLength(1);

    const fallbackLoaded = await hostPage.evaluate((source) => {
      window.TogetherSeeRoomProxy.request = () => Promise.resolve({
        proxyUrl: `${window.location.origin}/api/proxy/media?fixture=bilibili-fallback`,
      });
      return window.TogetherSeePlayer.loadSource(source, {
        playWhenReady: true,
        startTime: 1.25,
        playbackRate: 1.25,
      });
    }, {
      id: 'bilibili-fallback-source',
      title: 'Bilibili Fallback',
      pageUrl: 'https://www.bilibili.com/video/BV1182FBRExJ',
      refererUrl: 'https://www.bilibili.com/video/BV1182FBRExJ',
      sourceUrl: fallbackMediaUrl,
      sourceType: 'video',
      bilibili: {
        bvid: 'BV1182FBRExJ',
        cid: 2,
        page: 1,
        quality: 64,
        qualityLabel: '720P 高清',
        danmakuAvailable: true,
        danmakuEnabled: false,
      },
    });
    expect(fallbackLoaded).toBe(true);
    await expect.poll(async () => hostPage.evaluate(() => {
      const video = document.querySelector('[data-room-video]');
      return {
        mediaProxy: video.dataset.mediaProxy,
        paused: video.paused,
        currentTime: video.currentTime,
        playbackRate: video.playbackRate,
      };
    })).toMatchObject({
      mediaProxy: 'true',
      paused: false,
      currentTime: expect.any(Number),
      playbackRate: 1.25,
    });
    await expect.poll(async () => (await readMediaState(hostPage)).currentTime).toBeGreaterThan(1.5);
    expect(directFallbackRequests).toBe(1);
    expect(proxyRequests).toHaveLength(2);

    const iconOffsets = await hostPage.locator('[data-player-prev], [data-player-play], [data-player-next], [data-player-volume]').evaluateAll((buttons) => buttons.map((button) => {
      const icon = button.querySelector('svg');
      const buttonBox = button.getBoundingClientRect();
      const iconBox = icon.getBoundingClientRect();
      return {
        x: Math.abs((buttonBox.left + buttonBox.width / 2) - (iconBox.left + iconBox.width / 2)),
        y: Math.abs((buttonBox.top + buttonBox.height / 2) - (iconBox.top + iconBox.height / 2)),
      };
    }));
    for (const offset of iconOffsets) {
      expect(offset.x).toBeLessThanOrEqual(0.5);
      expect(offset.y).toBeLessThanOrEqual(0.5);
    }
  } finally {
    await closeRoomContexts({ hostContext, guestContext, hostPage, guestPage });
  }
});

test('shared Bilibili danmaku becomes locally visible and survives unrelated playlist updates', async ({ browser, baseURL }) => {
  const roomName = uniqueRoomName('BILI-DM');
  const { hostContext, guestContext } = await createRoomContexts(browser);
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();
  const errors = capturePageErrors(hostPage, 'bilibili-danmaku');
  const media = loadFixtureWebM({ name: 'bilibili-danmaku.webm' });
  const secondMedia = loadFixtureWebM({ name: 'queued-video.webm' });
  const biliPageUrl = 'https://www.bilibili.com/video/BV1182FBRExJ';
  const biliMediaUrl = 'https://upos-hz-mirrorakam.akamaized.net/e2e-bilibili-danmaku.webm';
  const queuedInputUrl = 'https://93.184.216.34/e2e-queued-input.webm';
  const queuedMediaUrl = 'https://93.184.216.34/e2e-queued-video.webm';

  try {
    await installRemoteWebMFixture(hostContext, {
      inputUrl: biliPageUrl,
      mediaUrl: biliMediaUrl,
      title: 'Bilibili Danmaku',
      buffer: media.buffer,
      mimeType: media.mimeType,
      mockParser: true,
      parserResult: {
        pageUrl: biliPageUrl,
        finalUrl: biliPageUrl,
        refererUrl: biliPageUrl,
        bilibili: {
          bvid: 'BV1182FBRExJ',
          cid: 33755434897,
          page: 1,
          quality: 64,
          qualityLabel: '720P 高清',
          danmakuAvailable: true,
          danmakuEnabled: false,
        },
      },
    });
    await installRemoteWebMFixture(hostContext, {
      inputUrl: queuedInputUrl,
      mediaUrl: queuedMediaUrl,
      title: 'Queued Video',
      buffer: secondMedia.buffer,
      mimeType: secondMedia.mimeType,
      mockParser: true,
    });
    await hostContext.route('**/api/bilibili/danmaku*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          success: true,
          items: [
            { id: 'dm-a', time: 0.35, text: '原生弹幕一', color: '#ffffff', fontSize: 25, mode: 'scroll' },
            { id: 'dm-b', time: 0.75, text: '原生弹幕二', color: '#ffffff', fontSize: 25, mode: 'scroll' },
          ],
        }),
      });
    });

    await createRoomFromHome(hostPage, baseURL, { roomName, nickname: 'Danmaku Host' });
    await openRoomTab(hostPage, 'playlist');
    await hostPage.evaluate(() => window.TogetherSeePlayer.setDanmakuVisible(false));
    await hostPage.locator('[data-playlist-form] input[name="videoLink"]').fill(biliPageUrl);
    await hostPage.locator('[data-playlist-form]').evaluate((form) => form.requestSubmit());
    const biliItem = playlistItem(hostPage, 'Bilibili Danmaku');
    await expect(biliItem).toHaveCount(1);
    await expect.poll(() => hostPage.locator('[data-room-video]').evaluate((video) => video.readyState)).toBeGreaterThanOrEqual(2);
    const danmakuToggle = biliItem.locator('[data-bilibili-danmaku-toggle]');
    await expect(danmakuToggle).toBeEnabled();
    await danmakuToggle.evaluate((input) => {
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(danmakuToggle).toBeChecked();
    await expect(biliItem.locator('[data-bilibili-danmaku-status]')).toContainText('2条');
    await expect.poll(() => hostPage.evaluate(() => window.TogetherSeePlayer.getTimelineDanmakuState())).toEqual({
      count: 2,
      keyPresent: true,
      visible: true,
      hasSource: true,
    });

    await installMediaCounters(hostPage);
    const before = await readMediaState(hostPage);
    await hostPage.locator('[data-room-video]').evaluate(async (video) => {
      video.muted = true;
      video.currentTime = 0;
      await video.play();
    });
    await expect.poll(
      () => hostPage.locator('.danmaku-item.is-source-danmaku').count(),
      { timeout: 3000 },
    ).toBeGreaterThan(0);

    await hostPage.locator('[data-playlist-form] input[name="videoLink"]').fill(queuedInputUrl);
    await hostPage.locator('[data-playlist-form]').evaluate((form) => form.requestSubmit());
    await expect(playlistItem(hostPage, 'Queued Video')).toHaveCount(1);
    const after = await readMediaState(hostPage);
    const counters = await readMediaCounters(hostPage);
    expect(after.sourceId).toBe(before.sourceId);
    expect(after.currentSrc).toBe(before.currentSrc);
    expect(counters).toEqual({ loadstart: 0, emptied: 0 });
    await expect.poll(() => hostPage.evaluate(() => window.TogetherSeePlayer.getTimelineDanmakuState().count)).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    await closeRoomContexts({ hostContext, guestContext, hostPage, guestPage });
  }
});
