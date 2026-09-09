import { expect, devices } from '@playwright/test';

export function uniqueRoomName(prefix = 'E2E') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createRoomContexts(browser) {
  const mobileDescriptor = devices['Pixel 7'];
  const hostContext = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
  });
  const guestContext = await browser.newContext({
    locale: 'zh-CN',
    userAgent: mobileDescriptor.userAgent,
    viewport: mobileDescriptor.viewport,
    deviceScaleFactor: mobileDescriptor.deviceScaleFactor,
    hasTouch: mobileDescriptor.hasTouch,
    isMobile: mobileDescriptor.isMobile,
  });
  return { hostContext, guestContext };
}

export function capturePageErrors(page, label) {
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(`${label} pageerror: ${error.stack || error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${label} console: ${message.text()}`);
  });
  return errors;
}

export async function waitForRoomAccess(page) {
  await expect(page.locator('body')).toHaveAttribute('data-room-access', 'granted');
  await expect.poll(() => page.locator('.room-main').evaluate((node) => !node.hasAttribute('inert'))).toBe(true);
  await expect(page.locator('[data-room-connection-status]')).toContainText('已连接');
}

export async function createRoomFromHome(page, baseURL, { roomName, nickname = 'Host' }) {
  await page.goto(`${baseURL}/`);
  await page.locator('#roomNameInput').fill(roomName);
  await page.locator('[data-create-room-form]').evaluate((form) => form.requestSubmit());
  await expect(page.locator('[data-home-create-modal]')).toBeVisible();
  await page.locator('[data-home-create-nickname]').fill(nickname);
  await page.locator('[data-home-create-dialog-form]').evaluate((form) => form.requestSubmit());
  await page.waitForURL((url) => url.pathname.endsWith('/room.html') && url.searchParams.get('room') === roomName);
  await waitForRoomAccess(page);
}

export async function joinRoomFromHome(page, baseURL, { roomName, nickname = 'Guest' }) {
  await page.goto(`${baseURL}/`);
  await page.locator('#roomCodeInput').fill(roomName);
  await page.locator('[data-room-form]').evaluate((form) => form.requestSubmit());
  await expect(page.locator('[data-home-join-modal]')).toBeVisible();
  await page.locator('[data-home-join-nickname]').fill(nickname);
  await page.locator('[data-home-join-dialog-form]').evaluate((form) => form.requestSubmit());
  await page.waitForURL((url) => url.pathname.endsWith('/room.html') && url.searchParams.get('room') === roomName);
  await waitForRoomAccess(page);
}

export async function openRoomTab(page, tab) {
  await page.locator(`[data-room-tab="${tab}"]`).click();
  await expect(page.locator(`[data-room-panel="${tab}"]`)).toHaveClass(/\bactive\b/);
}

export async function sendChatMessage(page, text) {
  const form = page.locator('[data-message-form]');
  await form.locator('input[name="message"]').fill(text);
  await form.evaluate((node) => node.requestSubmit());
}

export async function expectChatMessage(page, text) {
  await expect(page.locator('.chat-line p', { hasText: text })).toHaveCount(1);
}

export function playlistItem(page, title) {
  return page.locator('li[data-playlist-item]').filter({
    has: page.locator('[data-playlist-title]', { hasText: title }),
  });
}

export async function chooseLocalVideo(page, file) {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('[data-local-video-button]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(file);
}

export async function waitForMediaReady(page, expectedTitle) {
  const item = playlistItem(page, expectedTitle);
  await expect(item).toHaveCount(1);
  const sourceId = await item.getAttribute('data-source-id');
  await expect(item).toHaveClass(/\bis-current\b/);
  await expect.poll(() => page.locator('[data-room-video]').evaluate((video) => ({
    readyState: video.readyState,
    sourceId: video.dataset.sourceId || '',
    src: video.currentSrc || video.src || '',
  }))).toMatchObject({ readyState: expect.any(Number), sourceId, src: expect.stringContaining('blob:') });
  await expect.poll(() => page.locator('[data-room-video]').evaluate((video) => video.readyState)).toBeGreaterThanOrEqual(2);
  return sourceId;
}

export async function waitForRemoteMediaReady(page, expectedTitle) {
  const item = playlistItem(page, expectedTitle);
  await expect(item).toHaveCount(1);
  const sourceId = await item.getAttribute('data-source-id');
  await expect(item).toHaveClass(/\bis-current\b/);
  await expect.poll(() => page.locator('[data-room-video]').evaluate((video) => video.dataset.sourceId || '')).toBe(sourceId);
  await expect.poll(() => page.locator('[data-room-video]').evaluate((video) => video.readyState)).toBeGreaterThanOrEqual(2);
  return sourceId;
}

export async function installMediaCounters(page) {
  await page.locator('[data-room-video]').evaluate((video) => {
    window.__togetherSeeE2EMediaEvents = { loadstart: 0, emptied: 0 };
    video.addEventListener('loadstart', () => { window.__togetherSeeE2EMediaEvents.loadstart += 1; });
    video.addEventListener('emptied', () => { window.__togetherSeeE2EMediaEvents.emptied += 1; });
  });
}

export async function readMediaCounters(page) {
  return page.evaluate(() => ({ ...window.__togetherSeeE2EMediaEvents }));
}

export async function installMediaTelemetry(page) {
  await page.locator('[data-room-video]').evaluate((video) => {
    const counts = {
      loadstart: 0,
      emptied: 0,
      waiting: 0,
      stalled: 0,
      playing: 0,
      error: 0,
      seeking: 0,
      seeked: 0,
      ended: 0,
    };
    window.__togetherSeeE2ETelemetry = { counts };
    for (const name of Object.keys(counts)) {
      video.addEventListener(name, () => { counts[name] += 1; });
    }
  });
}

export async function readMediaTelemetry(page) {
  return page.evaluate(() => ({
    counts: { ...(window.__togetherSeeE2ETelemetry?.counts || {}) },
  }));
}

export async function installPlaybackStatusTelemetry(page) {
  await page.evaluate(() => {
    const player = window.TogetherSeePlayer;
    if (!player?.setPlaybackStatus || window.__togetherSeeE2EPlaybackStatuses) return;
    const original = player.setPlaybackStatus.bind(player);
    window.__togetherSeeE2EPlaybackStatuses = [];
    player.setPlaybackStatus = (text) => {
      window.__togetherSeeE2EPlaybackStatuses.push({ text: String(text || ''), at: Date.now() });
      original(text);
    };
  });
}

export async function readPlaybackStatusTelemetry(page) {
  return page.evaluate(() => [...(window.__togetherSeeE2EPlaybackStatuses || [])]);
}

export async function readMediaState(page) {
  return page.locator('[data-room-video]').evaluate((video) => ({
    currentSrc: video.currentSrc || video.src || '',
    sourceId: video.dataset.sourceId || '',
    currentTime: Number(video.currentTime || 0),
    playbackRate: Number(video.playbackRate || 1),
    paused: video.paused,
    ended: video.ended,
    duration: Number(video.duration || 0),
    readyState: video.readyState,
    networkState: video.networkState,
    bufferedAhead: (() => {
      const time = Number(video.currentTime || 0);
      for (let index = 0; index < video.buffered.length; index += 1) {
        if (video.buffered.start(index) <= time && video.buffered.end(index) >= time) {
          return Math.max(0, video.buffered.end(index) - time);
        }
      }
      return 0;
    })(),
  }));
}

export async function setAutoSync(page, enabled) {
  const button = page.locator('[data-player-auto-sync]');
  const expected = enabled ? 'true' : 'false';
  if (await button.getAttribute('data-sync-on') !== expected) await button.click({ force: true });
  await expect(button).toHaveAttribute('data-sync-on', expected);
}

export async function applyLocalPlaybackAction(page, { currentTime, playbackRate, action = 'seek' }) {
  await page.locator('[data-room-video]').evaluate((video, next) => {
    video.pause();
    if (Number.isFinite(next.currentTime)) video.currentTime = next.currentTime;
    if (Number.isFinite(next.playbackRate)) video.playbackRate = next.playbackRate;
    window.dispatchEvent(new CustomEvent('together-see:playback-user-action', {
      detail: { action: next.action },
    }));
  }, { currentTime, playbackRate, action });
}

export async function captureReconnectIdentity(page, roomName) {
  await page.evaluate((code) => {
    window.__togetherSeeE2EReconnect = {
      memberId: window.sessionStorage.getItem('together-see:member-id') || '',
      token: window.sessionStorage.getItem(`together-see:room-member-token:${code}`) || '',
    };
  }, roomName);
  await expect.poll(() => page.evaluate(() => Boolean(
    window.__togetherSeeE2EReconnect?.memberId
    && window.__togetherSeeE2EReconnect?.token
  ))).toBe(true);
}

export async function expectReconnectIdentityRestored(page, roomName) {
  await expect.poll(() => page.evaluate((code) => {
    const before = window.__togetherSeeE2EReconnect;
    const memberId = window.sessionStorage.getItem('together-see:member-id') || '';
    const token = window.sessionStorage.getItem(`together-see:room-member-token:${code}`) || '';
    return Boolean(before?.memberId && memberId === before.memberId && token && token !== before.token);
  }, roomName)).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const memberId = window.__togetherSeeE2EReconnect?.memberId || '';
    return memberId
      ? document.querySelectorAll(`[data-member-id="${CSS.escape(memberId)}"]`).length
      : 0;
  })).toBe(1);
}

export async function installFullscreenShim(page) {
  await page.evaluate(() => {
    const state = { element: null };
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => state.element,
    });
    document.exitFullscreen = async () => {
      state.element = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    };
    const shell = document.querySelector('[data-player-shell]');
    shell.requestFullscreen = async () => {
      state.element = shell;
      document.dispatchEvent(new Event('fullscreenchange'));
    };
  });
}

export async function expectFullscreenDanmakuInputStable(page, {
  mode = 'page',
  message,
  assertAutoHide = false,
}) {
  let timeout;
  const run = async () => {
    const shell = page.locator('[data-player-shell]');
    const controls = page.locator('[data-player-controls]');
    const input = page.locator('[data-danmaku-input]');
    const button = page.locator(mode === 'native' ? '[data-player-fullscreen]' : '[data-page-fullscreen]');
    await page.locator('[data-room-video]').evaluate((video) => {
      // The playback suite covers real media playback. This controls-focused
      // check uses a deterministic playing-state shim so headless media
      // promises cannot stall fullscreen/input assertions.
      Object.defineProperty(video, 'paused', {
        configurable: true,
        get: () => false,
      });
    });
    await expect.poll(() => page.locator('[data-room-video]').evaluate((video) => video.paused)).toBe(false);
    await button.click({ force: true });
    await expect(shell).toHaveClass(mode === 'native' ? /\bis-native-fullscreen\b/ : /\bis-page-fullscreen\b/);
    await expect(input).toBeVisible();
    await input.focus();
    await input.pressSequentially(message, { delay: 45 });
    await page.waitForTimeout(2700);
    await expect(input).toHaveValue(message);
    await expect.poll(() => input.evaluate((node) => document.activeElement === node)).toBe(true);
    await expect(shell).toHaveClass(/\bis-controls-visible\b/);
    await expect(shell).not.toHaveClass(/\bis-controls-hidden\b/);
    await expect.poll(() => controls.evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
    await input.press('Enter');
    await expectChatMessage(page, message);
    await expect(page.locator('.danmaku-item.is-room-danmaku', { hasText: message })).toHaveCount(1);
    if (assertAutoHide) {
      await page.locator('[data-room-video]').click({ force: true });
      await page.mouse.move(1, 1);
      await page.waitForTimeout(1000);
      await expect(shell).toHaveClass(/\bis-controls-hidden\b/);
    }
    await button.click({ force: true });
    await expect(shell).not.toHaveClass(mode === 'native' ? /\bis-native-fullscreen\b/ : /\bis-page-fullscreen\b/);
  };
  try {
    await Promise.race([
      run(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${mode} fullscreen danmaku check exceeded 30 seconds`)), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function closeRoomContexts({ hostContext, guestContext, hostPage, guestPage }) {
  let timeout;
  try {
    await Promise.race([
      (async () => {
        await Promise.allSettled([
          hostPage.goto('about:blank', { waitUntil: 'commit' }),
          guestPage.goto('about:blank', { waitUntil: 'commit' }),
        ]);
        await Promise.allSettled([hostContext.close(), guestContext.close()]);
      })(),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, 5000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function expectTimeNear(actual, expected, tolerance = 0.2) {
  expect(Math.abs(actual - expected), `expected ${actual}s to remain within ${tolerance}s of ${expected}s`).toBeLessThanOrEqual(tolerance);
}
