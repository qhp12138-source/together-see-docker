import { test, expect, devices } from '@playwright/test';
import { createRoomFromHome, openRoomTab, waitForRemoteMediaReady, uniqueRoomName } from './helpers/room.mjs';
import { buildRepeatedFixtureWebM, installRemoteWebMFixture } from './helpers/media.mjs';

test.describe.configure({ timeout: 90_000 });
const shell = '[data-player-shell]';
const toolbox = '[data-interaction-toggle]';
const panel = '#interactionPopover';

async function setup(browser, baseURL, mobile = false, width = 393, height = 852) {
  const context = await browser.newContext(mobile ? { ...devices['Pixel 7'], viewport: { width, height } } : { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const clip = buildRepeatedFixtureWebM({ name: 'interaction-controls.webm', durationSeconds: 60 });
  const mediaUrl = 'https://93.184.216.34/interaction-controls.webm';
  await installRemoteWebMFixture(context, { inputUrl: mediaUrl, mediaUrl, title: 'Controls fixture', buffer: clip.buffer, mockParser: true });
  await createRoomFromHome(page, baseURL, { roomName: uniqueRoomName('CONTROLS') });
  await openRoomTab(page, 'playlist');
  await page.locator('[data-playlist-form] input').fill(mediaUrl);
  await page.locator('[data-playlist-form]').evaluate(form => form.requestSubmit());
  await waitForRemoteMediaReady(page, 'Controls fixture');
  for (const button of await page.getByRole('button', { name: '关闭提示', exact: true }).all()) {
    if (await button.isVisible()) await button.click();
  }
  await page.locator('[data-room-video]').evaluate(video => { video.muted = true; });
  await page.locator('[data-room-video]').click({ position: { x: 30, y: 30 } });
  await page.locator('[data-player-play]').click();
  await expect.poll(() => page.locator('[data-room-video]').evaluate(video => video.paused)).toBe(false);
  return { page, context, errors };
}

for (const viewport of [{ width: 852, height: 393 }, { width: 1280, height: 592 }]) {
test(`landscape interaction modal ${viewport.width} isolates a real touch swipe and keeps the public sprite visible`, async ({ browser, baseURL }, testInfo) => {
  const { page, context, errors } = await setup(browser, baseURL, true, viewport.width, viewport.height);
  try {
    await page.locator(shell).scrollIntoViewIfNeeded();
    await page.locator('[data-room-video]').tap({ position: { x: 30, y: 30 } });
    await page.locator('[data-page-fullscreen]').tap();
    await page.locator(toolbox).tap();
    await expect(page.getByRole('dialog', { name: '互动', exact: true })).toBeVisible();
    await expect(page.locator('[data-interaction-group-tab="builtin"]')).toHaveText('预设');
    expect(await page.locator('[data-interaction-asset]:visible').evaluateAll(nodes => nodes.map(node => node.dataset.interactionAsset)))
      .toEqual(['heart', 'fireworks', 'sakura', 'birthday']);
    await page.locator('[data-interaction-group-tab="other"]').tap();
    expect(await page.locator('[data-interaction-asset]:visible').evaluateAll(nodes => nodes.map(node => node.dataset.interactionAsset)))
      .toEqual(['question']);
    await expect(page.locator('.interaction-pagination')).toBeHidden();
    const before = await page.locator('[data-room-video]').evaluate(video => {
      window.__gestureMediaEvents = [];
      for (const type of ['volumechange', 'pause', 'seeking', 'loadstart', 'ratechange']) video.addEventListener(type, () => window.__gestureMediaEvents.push(type));
      window.__cancelledMoves = 0;
      document.querySelector('#interactionPopover').addEventListener('touchmove', event => { if (event.defaultPrevented) window.__cancelledMoves++; });
      return { volume: video.volume, time: video.currentTime };
    });
    const geometry = await page.locator(panel).evaluate(node => {
      const box = node.getBoundingClientRect();
      return { box: box.toJSON(), fullyVisible: [...node.querySelectorAll('[data-interaction-asset]')].filter(n => !n.hidden).every(n => {
        const b = n.getBoundingClientRect(); return b.top >= box.top && b.bottom <= box.bottom && b.left >= box.left && b.right <= box.right;
      }), overflow: node.scrollHeight - node.clientHeight };
    });
    expect(geometry.fullyVisible).toBe(true);
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    const cdp = await context.newCDPSession(page);
    const point = { x: geometry.box.left + geometry.box.width / 2, y: geometry.box.bottom - 30 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    for (let step = 1; step <= 8; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y - step * 12 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    await page.waitForTimeout(3200);
    await expect(page.locator(panel)).toBeVisible();
    expect(await page.evaluate(() => window.__cancelledMoves)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__gestureMediaEvents)).toEqual([]);
    expect(await page.locator('[data-room-video]').evaluate(video => video.volume)).toBe(before.volume);
    expect(await page.locator('[data-room-video]').evaluate(video => video.currentTime)).toBeGreaterThan(before.time);
    await testInfo.attach('landscape-fixed-menu', { body: await page.screenshot(), contentType: 'image/png' });
    await page.locator('[data-interaction-asset="question"]').tap();
    await expect(page.locator(panel)).toBeHidden();
    await expect(page.locator(shell)).toHaveClass(/is-interaction-placing/);
    await page.locator('.interaction-placement-cancel').tap();
    await page.locator(toolbox).tap();
    await page.keyboard.press('Escape');
    await expect(page.locator(panel)).toBeHidden();
    await expect(page.locator(shell)).not.toHaveClass(/is-interaction-placing/);
    await expect(page.locator(toolbox)).toBeFocused();
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
}

for (const fullscreen of [false, true]) {
  test(`real player lock remains escapable with interaction panel, page fullscreen=${fullscreen}`, async ({ browser, baseURL }, testInfo) => {
    const { page, context, errors } = await setup(browser, baseURL);
    try {
      await page.locator(shell).hover();
      if (fullscreen) await page.locator('[data-page-fullscreen]').click();
      await page.locator(toolbox).click();
      await page.mouse.move(1, 1);
      await page.waitForTimeout(3000);
      await expect(page.locator(panel)).toBeVisible();
      await expect.poll(() => page.locator('[data-player-controls]').evaluate(el => getComputedStyle(el).opacity)).toBe('1');
      await page.locator('[data-interaction-asset="heart"]').click();
      await page.locator('[data-player-control-lock]').click();
      await expect(page.locator(shell)).toHaveClass(/is-controls-locked/);
      await expect(page.locator(shell)).not.toHaveClass(/is-interaction-placing/);
      await expect(page.locator(panel)).toBeHidden();
      await page.mouse.move(1, 1);
      await page.waitForTimeout(2800);
      await expect(page.locator('[data-player-control-lock]')).toBeVisible();
      await expect(page.locator('[data-player-controls]')).toHaveJSProperty('inert', true);
      // Ended/paused events must not expose an unusable toolbar while locked.
      await page.locator('[data-room-video]').evaluate(video => { video.pause(); video.dispatchEvent(new Event('ended')); });
      await expect(page.locator('[data-player-controls]')).toBeHidden();
      await page.locator('[data-player-control-lock]').click();
      await expect(page.locator('[data-player-controls]')).toHaveJSProperty('inert', false);
      await page.locator(toolbox).click();
      await page.locator('[data-interaction-group-tab="other"]').click();
      await page.locator('[data-interaction-asset="question"]').click();
      await expect(page.locator(shell)).toHaveClass(/is-interaction-placing/);
      await page.keyboard.press('Escape');
      await expect(page.locator(shell)).not.toHaveClass(/is-interaction-placing|is-page-fullscreen/);
      await page.locator(shell).hover();
      await page.locator('[data-player-control-lock]').click();
      await page.keyboard.press('Escape');
      await expect(page.locator(shell)).not.toHaveClass(/is-controls-locked/);
      await testInfo.attach('unlocked-controls', { body: await page.screenshot(), contentType: 'image/png' });
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
}

for (const width of [393, 320]) {
test(`touch toolbox ${width}px stays open and Other is selectable without a swipe or media changes`, async ({ browser, baseURL }, testInfo) => {
  const { page, context, errors } = await setup(browser, baseURL, true, width);
  try {
    await page.locator('[data-room-video]').tap({ position: { x: 30, y: 30 } });
    await page.locator(toolbox).tap();
    await page.waitForTimeout(3200);
    await expect(page.locator(panel)).toBeVisible();
    await expect.poll(() => page.locator('[data-player-controls]').evaluate(el => getComputedStyle(el).opacity)).toBe('1');
    await page.locator('[data-room-video]').evaluate(video => {
      window.__uiMediaEvents = [];
      for (const name of ['loadstart', 'seeking', 'pause', 'ratechange', 'volumechange']) video.addEventListener(name, () => window.__uiMediaEvents.push(name));
      window.__escapedTouches = 0;
      document.querySelector('[data-player-shell]').addEventListener('touchmove', () => window.__escapedTouches++);
    });
    await page.locator('[data-interaction-group-tab="other"]').tap();
    await expect(page.locator('[data-interaction-asset="question"]')).toBeVisible();
    await expect(page.locator('[data-interaction-asset="heart"]')).toBeHidden();
    const metrics = await page.locator(panel).evaluate(el => {
      const touch = new Event('touchmove', { bubbles: true, cancelable: true });
      el.dispatchEvent(touch);
      const style = getComputedStyle(el), box = el.getBoundingClientRect();
      const item = el.querySelector('[data-interaction-asset="question"]').getBoundingClientRect();
      return { touch: style.touchAction, overscroll: style.overscrollBehaviorY, cancelled: touch.defaultPrevented, inside: item.top >= box.top && item.bottom <= box.bottom, escaped: window.__escapedTouches };
    });
    const geometry = await page.locator(panel).evaluate(el => [...el.children, ...el.querySelector('[data-interaction-assets]').children].map(node => ({ tag: node.tagName, cls: node.className, box: node.getBoundingClientRect().toJSON(), margin: getComputedStyle(node).margin, display: getComputedStyle(node).display })));
    expect(metrics, JSON.stringify(geometry)).toEqual({ touch: 'none', overscroll: 'none', cancelled: true, inside: true, escaped: 0 });
    await testInfo.attach('mobile-other-tab', { body: await page.screenshot(), contentType: 'image/png' });
    await page.locator('[data-interaction-asset="question"]').tap();
    await expect(page.locator(shell)).toHaveClass(/is-interaction-placing/);
    await page.waitForTimeout(2800);
    await expect(page.locator('.interaction-placement-cancel')).toBeVisible();
    await page.locator('.interaction-placement-cancel').tap();
    await expect(page.locator(shell)).not.toHaveClass(/is-interaction-placing/);
    expect(await page.evaluate(() => window.__uiMediaEvents)).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
}
