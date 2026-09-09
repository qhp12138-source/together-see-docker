import { test, expect } from '@playwright/test';
import {
  capturePageErrors,
  captureReconnectIdentity,
  chooseLocalVideo,
  closeRoomContexts,
  createRoomContexts,
  createRoomFromHome,
  expectChatMessage,
  expectFullscreenDanmakuInputStable,
  expectReconnectIdentityRestored,
  installFullscreenShim,
  joinRoomFromHome,
  openRoomTab,
  sendChatMessage,
  uniqueRoomName,
  waitForMediaReady,
} from './helpers/room.mjs';
import { loadFixtureWebM } from './helpers/media.mjs';

test('mobile reconnect and fullscreen danmaku controls preserve identity and input', async ({ browser, baseURL }) => {
  const roomName = uniqueRoomName('CONNECTION');
  const { hostContext, guestContext } = await createRoomContexts(browser);
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();
  const hostErrors = capturePageErrors(hostPage, 'connection host');
  const guestErrors = capturePageErrors(guestPage, 'connection guest');

  try {
    await test.step('create and join room', async () => {
      await createRoomFromHome(hostPage, baseURL, { roomName, nickname: 'Desktop Host' });
      await joinRoomFromHome(guestPage, baseURL, { roomName, nickname: 'Mobile Guest' });
    });
    await expect(hostPage.locator('[data-toolbar-member-count]')).toHaveText('2');
    await expect(guestPage.locator('[data-toolbar-member-count]')).toHaveText('2');

    const joinedSystemMessage = hostPage.locator('.chat-line.system p', { hasText: 'Mobile Guest 加入了房间' });
    await expect(joinedSystemMessage).toHaveCount(1);
    await test.step('disconnect and reconnect mobile guest', async () => {
      await captureReconnectIdentity(guestPage, roomName);
      await guestContext.setOffline(true);
      await expect(guestPage.locator('body')).toHaveAttribute('data-socket-connected', 'false', { timeout: 60_000 });
      await expect(guestPage.locator('body')).toHaveAttribute('data-room-access', 'granted');
      await expect(hostPage.locator('[data-toolbar-member-count]')).toHaveText('1', { timeout: 60_000 });
      await guestContext.setOffline(false);
      await expect(guestPage.locator('body')).toHaveAttribute('data-socket-connected', 'true', { timeout: 60_000 });
      await expect(guestPage.locator('body')).toHaveAttribute('data-room-access', 'granted');
      await expect(hostPage.locator('[data-toolbar-member-count]')).toHaveText('2');
      await expect(guestPage.locator('[data-toolbar-member-count]')).toHaveText('2');
      await expectReconnectIdentityRestored(guestPage, roomName);
    });
    await expect(joinedSystemMessage).toHaveCount(1);
    await expect(hostPage.locator('.chat-line.system p', { hasText: 'Mobile Guest 离开了房间' })).toHaveCount(0);
    const reconnectMessage = `reconnected-${Date.now()}`;
    await sendChatMessage(guestPage, reconnectMessage);
    await expectChatMessage(hostPage, reconnectMessage);

    const clip = await test.step('load local media on both clients', async () => {
      const localClip = loadFixtureWebM({
        name: 'controls.webm',
      });
      await openRoomTab(hostPage, 'playlist');
      await chooseLocalVideo(hostPage, localClip);
      await waitForMediaReady(hostPage, localClip.name);
      await openRoomTab(guestPage, 'playlist');
      await chooseLocalVideo(guestPage, localClip);
      await waitForMediaReady(guestPage, localClip.name);
      return localClip;
    });
    expect(clip.name).toBe('controls.webm');

    const pageFullscreenMessage = `page-fullscreen-${Date.now()}`;
    await test.step('desktop page fullscreen input', async () => {
      await expectFullscreenDanmakuInputStable(hostPage, {
        mode: 'page',
        message: pageFullscreenMessage,
        assertAutoHide: true,
      });
    });
    await expectChatMessage(guestPage, pageFullscreenMessage);

    const nativeFullscreenMessage = `native-fullscreen-${Date.now()}`;
    await test.step('desktop native fullscreen input', async () => {
      await installFullscreenShim(hostPage);
      await expectFullscreenDanmakuInputStable(hostPage, {
        mode: 'native',
        message: nativeFullscreenMessage,
      });
    });
    await expectChatMessage(guestPage, nativeFullscreenMessage);

    const mobileFullscreenMessage = `mobile-fullscreen-${Date.now()}`;
    await test.step('mobile page fullscreen input', async () => {
      await expectFullscreenDanmakuInputStable(guestPage, {
        mode: 'page',
        message: mobileFullscreenMessage,
      });
    });
    await expectChatMessage(hostPage, mobileFullscreenMessage);

    expect(hostErrors).toEqual([]);
    expect(guestErrors).toEqual([]);
  } finally {
    await closeRoomContexts({ hostContext, guestContext, hostPage, guestPage });
  }
});
