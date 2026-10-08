import { test, expect } from '@playwright/test';
import { createRoomFromHome, joinRoomFromHome, openRoomTab, uniqueRoomName, waitForRemoteMediaReady } from './helpers/room.mjs';

// No live URL is hardcoded, logged or explicitly attached by this test.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('optional live direct media advances on both browsers for ten seconds without proxy or reparse', async ({ browser, baseURL }) => {
  test.setTimeout(90000);
  const configuredUrl = String(process.env.TOGETHER_SEE_LIVE_DIRECT_URL || '').trim();
  test.skip(!configuredUrl, 'Set TOGETHER_SEE_LIVE_DIRECT_URL to opt into real source traffic');
  const source = new URL(configuredUrl);
  source.hash = '';
  expect(['http:', 'https:'].includes(source.protocol) && !source.username && !source.password && !source.port,
    'Live acceptance requires a standard-port HTTP(S) direct URL without credentials').toBe(true);
  const configuredType = process.env.TOGETHER_SEE_LIVE_DIRECT_TYPE;
  const type = configuredType || (/\.m3u8$/i.test(source.pathname) ? 'hls' : /\.(?:mp4|webm|m4v|mov)$/i.test(source.pathname) ? 'video' : '');
  expect(['hls', 'video'].includes(type), 'Set TOGETHER_SEE_LIVE_DIRECT_TYPE=hls or video when the path has no recognized extension').toBe(true);
  const url = source.href;
  const appOrigin = new URL(baseURL).origin;
  const title = 'Live browser direct';
  const contexts = [];
  const counters = [{ parse: 0, proxyHttp: 0, proxySocket: 0 }, { parse: 0, proxyHttp: 0, proxySocket: 0 }];
  const networkResults = [];

  try {
    for (let index = 0; index < 2; index++) {
      const context = await browser.newContext();
      contexts.push(context);
      context.on('requestfailed', request => {
        if (new URL(request.url()).origin === source.origin) networkResults.push({ browser: index, error: request.failure()?.errorText.match(/net::ERR_[A-Z_]+/)?.[0] || 'network_error' });
      });
      context.on('response', response => {
        if (response.url() === url) networkResults.push({ browser: index, status: response.status(), contentType: response.headers()['content-type'] });
      });
      await context.addInitScript(() => {
        window.__liveDirect = { loadstart: 0, emptied: 0, terminalErrors: 0 };
        for (const name of ['loadstart', 'emptied']) document.addEventListener(name, event => {
          if (event.target?.matches?.('[data-room-video]') && event.target.dataset.sourceId) window.__liveDirect[name]++;
        }, true);
        window.addEventListener('together-see:player-error', () => { window.__liveDirect.terminalErrors++; });
      });
      context.on('request', request => {
        const target = new URL(request.url());
        if (target.origin !== appOrigin) return;
        if (target.pathname === '/api/parse') counters[index].parse++;
        if (target.pathname.startsWith('/api/proxy/')) counters[index].proxyHttp++;
        if (target.pathname.startsWith('/socket.io/') && request.postData()?.includes('"proxy_token_request"')) counters[index].proxySocket++;
      });
      // Only the backend parse result is simulated. No media/manifest/segment/key
      // request is intercepted, downloaded into a fixture, or persisted by this test.
      await context.route(`${appOrigin}/api/parse*`, route => {
        if (route.request().method() !== 'POST' || route.request().postDataJSON()?.url !== url) return route.continue();
        return route.fulfill({ json: {
          success: false, title, code: 'parse_upstream_http_403', message: 'Live acceptance upstream 403 fixture',
          browserDirectCandidate: { url, type },
        } });
      });
    }
    const host = await contexts[0].newPage();
    const guest = await contexts[1].newPage();
    const pages = [host, guest];
    for (const [index, page] of pages.entries()) {
      const diagnostics = await page.context().newCDPSession(page);
      await diagnostics.send('Network.enable');
      diagnostics.on('Network.loadingFailed', value => {
        if (value.corsErrorStatus || value.blockedReason) networkResults.push({ browser: index, cors: value.corsErrorStatus, blocked: value.blockedReason });
      });
    }
    for (const [index, page] of pages.entries()) page.on('websocket', socket => {
      socket.on('framesent', frame => {
        if (String(frame.payload).includes('"proxy_token_request"')) counters[index].proxySocket++;
      });
    });
    const roomName = uniqueRoomName('LIVEDIRECT');
    await createRoomFromHome(host, baseURL, { roomName, nickname: 'Live Host' });
    await joinRoomFromHome(guest, baseURL, { roomName, nickname: 'Live Guest' });
    for (const page of pages) {
      await openRoomTab(page, 'playlist');
      await page.locator('[data-room-video]').evaluate(video => { video.muted = true; });
    }
    const form = host.locator('[data-playlist-form]');
    await form.locator('input').fill(url);
    await form.evaluate(node => node.requestSubmit());
    await expect(form.locator('button')).toBeEnabled({ timeout: 15000 });
    if (await host.locator('[data-playlist-item]').count() === 0) {
      console.log('[direct-media-live-probe]', JSON.stringify({ networkResults, counters,
        message: await host.locator('body').innerText().then(text => text.match(/本机直连[^\n]{0,140}/)?.[0] || 'no_direct_probe_message'),
      }));
    }
    for (const page of pages) await waitForRemoteMediaReady(page, title);

    const snapshot = page => page.evaluate(expectedUrl => {
      const item = document.querySelector('[data-playlist-item].is-current');
      const video = document.querySelector('[data-room-video]');
      return {
        time: video.currentTime, paused: video.paused, ended: video.ended,
        readyState: video.readyState,
        bufferedAhead: Array.from({ length: video.buffered.length }, (_, index) => index)
          .reduce((ahead, index) => video.buffered.start(index) <= video.currentTime + 0.1 && video.buffered.end(index) > video.currentTime
            ? Math.max(ahead, video.buffered.end(index) - video.currentTime) : ahead, 0),
        generation: video.dataset.loadGeneration,
        clientDirectOnly: item?.dataset.clientDirectOnly === 'true' && item?.dataset.sharedClientDirectOnly === 'true',
        sameUrl: item?.dataset.pageUrl === expectedUrl && item?.dataset.sourceUrl === expectedUrl && video.dataset.sourceUrl === expectedUrl,
        requiresClientParse: item?.dataset.requiresClientParse === 'true',
        usingProxy: window.TogetherSeePlayer.getPlaybackHealth().usingProxy,
        ...window.__liveDirect,
      };
    }, url);
    for (const page of pages) {
      expect(await snapshot(page)).toMatchObject({ clientDirectOnly: true, sameUrl: true, requiresClientParse: false, usingProxy: false, terminalErrors: 0 });
    }
    if ((await snapshot(host)).paused) await host.locator('[data-player-play]').click({ force: true });
    for (const page of pages) await expect.poll(async () => (await snapshot(page)).paused).toBe(false);
    // loadeddata only confirms the first frame. Start the steady-play window
    // after the real CDN has buffered media, not during initial segment loading.
    for (const page of pages) await expect.poll(async () => {
      const value = await snapshot(page);
      return value.time > 2 && value.readyState >= 3 && value.bufferedAhead >= 10;
    }, { timeout: 30000 }).toBe(true);
    const initial = [await snapshot(host), await snapshot(guest)];
    let previous = initial;
    const startedAt = Date.now();
    let current;
    for (let second = 0; second < 10; second++) {
      await host.waitForTimeout(1000);
      current = [await snapshot(host), await snapshot(guest)];
      for (let index = 0; index < 2; index++) {
        expect(current[index]).toMatchObject({
          paused: false, ended: false, clientDirectOnly: true, sameUrl: true,
          requiresClientParse: false, usingProxy: false, terminalErrors: 0,
          loadstart: initial[index].loadstart, emptied: initial[index].emptied, generation: initial[index].generation,
        });
        expect(current[index].time - previous[index].time, `browser ${index} must advance in observation ${second + 1}`).toBeGreaterThan(0.2);
      }
      previous = current;
    }
    for (let index = 0; index < 2; index++) expect(current[index].time - initial[index].time).toBeGreaterThan(8);
    expect(counters).toEqual([{ parse: 1, proxyHttp: 0, proxySocket: 0 }, { parse: 0, proxyHttp: 0, proxySocket: 0 }]);
    console.log('[direct-media-live]', JSON.stringify({
      observationMs: Date.now() - startedAt,
      advancedSeconds: current.map((value, index) => Number((value.time - initial[index].time).toFixed(3))),
      noReload: true, counters,
    }));
  } finally {
    // Closing the contexts cancels both native-media and Hls.js streaming traffic.
    await Promise.allSettled(contexts.map(context => context.close()));
  }
});
