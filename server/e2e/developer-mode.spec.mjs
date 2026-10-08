import fs from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { createRoomFromHome, joinRoomFromHome, openRoomTab, uniqueRoomName, waitForRoomAccess } from './helpers/room.mjs';

async function expectPublicSecurityUi(page, canManage) {
  await openRoomTab(page, 'members');
  const panel = page.locator('[data-room-security-panel]');
  if (!(await panel.evaluate(node => node.open))) await panel.locator('summary').click();
  await expect(page.locator('[data-developer-media-form], [data-developer-media-key], [data-developer-media-status], #developerMediaKey')).toHaveCount(0);
  if (canManage) {
    await expect(page.locator('[data-room-password-input]')).toBeVisible();
    await expect(page.locator('[data-room-password-input]')).toBeEnabled();
    await expect(page.locator('[data-room-admin-recovery-form]')).toBeHidden();
  } else {
    await expect(page.locator('[data-room-password-input]')).toBeDisabled();
    await expect(page.locator('[data-room-password-form]')).toBeHidden();
    await expect(page.locator('[data-room-admin-recovery-input]')).toBeVisible();
    await expect(page.locator('[data-room-admin-recovery-input]')).toBeEnabled();
  }
}

test('public frontend assets contain no developer mode implementation', async () => {
  for (const file of ['assets/js/room.js', 'assets/js/site.js', 'room.html']) {
    const source = await fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    expect(source, file).not.toMatch(/devmod|developerMedia|developerKey|developer_access_denied|data-developer-media/i);
  }
});

test('home create and join never propagate the devmod query', async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const owner = await context.newPage();
    const guest = await guestContext.newPage();
    const roomName = uniqueRoomName('PUBLIC-HOME');
    // Keep the real home forms and requests; only add an untrusted URL parameter.
    for (const page of [owner, guest]) {
      await page.addInitScript(() => {
        if (location.pathname !== '/' && !location.pathname.endsWith('/index.html')) return;
        const url = new URL(location.href);
        url.searchParams.set('devmod', 'true');
        history.replaceState(null, '', url);
      });
    }
    await createRoomFromHome(owner, baseURL, { roomName });
    expect(new URL(owner.url()).searchParams.has('devmod')).toBe(false);
    await expectPublicSecurityUi(owner, true);
    await joinRoomFromHome(guest, baseURL, { roomName });
    expect(new URL(guest.url()).searchParams.has('devmod')).toBe(false);
    await expectPublicSecurityUi(guest, false);
  } finally {
    await guestContext.close();
    await context.close();
  }
});

test('devmod=true cannot activate public UI or grant guest management on navigation or reload', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ viewport: { width: 797, height: 818 } });
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const owner = await context.newPage();
    const guest = await guestContext.newPage();
    const roomName = uniqueRoomName('PUBLIC-QUERY');
    await createRoomFromHome(owner, baseURL, { roomName });
    await joinRoomFromHome(guest, baseURL, { roomName });
    for (const [page, canManage] of [[owner, true], [guest, false]]) {
      const url = new URL(page.url());
      url.searchParams.delete('created');
      url.searchParams.set('devmod', 'true');
      await page.goto(url.href);
      await waitForRoomAccess(page);
      expect(new URL(page.url()).searchParams.get('devmod')).toBe('true');
      await expectPublicSecurityUi(page, canManage);
      await page.reload();
      await waitForRoomAccess(page);
      await expectPublicSecurityUi(page, canManage);
    }
  } finally {
    await guestContext.close();
    await context.close();
  }
});
