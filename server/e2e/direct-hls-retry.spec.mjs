import { test, expect } from '@playwright/test';

const origin = 'https://93.184.216.34';
const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="avc1.42E01E"\nchild.m3u8\n';
const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n';
const settleMs = 2200; // Beyond both configured retry delays, including the cap.

async function openPlayer(page, baseURL, respond) {
  const requests = [];
  const apiRequests = [];
  const pendingFragments = [];
  page.on('request', request => {
    if (/^\/api\/(?:parse|proxy)(?:\/|$)/.test(new URL(request.url()).pathname)) apiRequests.push(request.url());
  });
  await page.route('**/assets/js/room.js*', route => route.fulfill({ contentType: 'application/javascript', body: '' }));
  // Use the shipped player and Hls implementation; only the remote HTTP fixture is controlled.
  await page.route(`${origin}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    const attempt = requests.filter(request => request.path === path).length + 1;
    const response = respond(path, attempt);
    requests.push({ path, attempt, at: Date.now(), status: response?.status || 200 });
    if (response?.abort) return route.abort('connectionreset');
    if (path.endsWith('.ts') && !response) {
      // Reaching a fragment request proves the recovered child was parsed by Hls.
      // Hold it instead of feeding fake media bytes that introduce unrelated decode errors.
      pendingFragments.push(route);
      return;
    }
    await route.fulfill({
      status: response?.status || 200,
      contentType: 'application/vnd.apple.mpegurl',
      headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
      body: response?.body ?? (path.endsWith('/master.m3u8') ? master : playlist),
    });
  });
  await page.goto(`${baseURL}/room.html`);
  const engine = await page.evaluate(() => {
    const video = document.querySelector('video');
    const canPlayType = video.canPlayType.bind(video);
    video.canPlayType = type => /mpegurl/i.test(type) ? '' : canPlayType(type);
    const Hls = window.Hls;
    const state = window.__directHlsRetry = { instances: [], events: [], errors: [], proxy: 0 };
    window.TogetherSeeRoomProxy = { request() {
      state.proxy++;
      return Promise.reject(new Error('Unexpected proxy request'));
    } };
    window.addEventListener('together-see:player-error', event => state.errors.push({
      generation: event.detail.generation,
      sourceId: event.detail.source?.id,
      reason: event.detail.reason,
      status: event.detail.hls?.response?.code,
    }));
    // Observe actual instances, without replacing their loaders, timers or policies.
    window.Hls = new Proxy(Hls, { construct(Target, args) {
      const instance = new Target(...args);
      const index = state.instances.push(instance) - 1;
      for (const name of ['MANIFEST_LOADING', 'MANIFEST_PARSED', 'LEVEL_LOADED', 'FRAG_LOADING', 'ERROR', 'DESTROYING']) {
        instance.on(Hls.Events[name], (_event, data) => {
          state.events.push({ index, name, details: data?.details, fatal: data?.fatal });
          if (name === 'ERROR' && index === 0 && state.switchTo) {
            const source = state.switchTo;
            state.switchTo = null;
            queueMicrotask(() => {
              window.TogetherSeePlayer.loadSource(source);
              state.switchedGeneration = window.TogetherSeePlayer.getLoadToken().generation;
            });
          }
        });
      }
      return instance;
    } });
    return { supported: Hls.isSupported(), version: Hls.version };
  });
  expect(engine).toMatchObject({ supported: true, version: expect.stringMatching(/^\d+\./) });
  return {
    requests,
    apiRequests,
    count: path => requests.filter(request => request.path === path).length,
    close: async () => {
      await page.evaluate(() => window.TogetherSeePlayer.clearSource());
      for (const route of pendingFragments) await route.abort().catch(() => {});
    },
  };
}

function load(page, prefix = 'test', switchTo = '') {
  return page.evaluate(({ origin, prefix, switchTo }) => {
    const source = name => ({ id: name, sourceType: 'hls', sourceUrl: `${origin}/${name}/master.m3u8`, clientDirectOnly: true });
    if (switchTo) window.__directHlsRetry.switchTo = source(switchTo);
    window.TogetherSeePlayer.loadSource(source(prefix), { useProxy: true });
    return window.TogetherSeePlayer.getLoadToken().generation;
  }, { origin, prefix, switchTo });
}

async function snapshot(page) {
  return page.evaluate(() => {
    const state = window.__directHlsRetry;
    return { generation: window.TogetherSeePlayer.getLoadToken().generation,
      instances: state.instances.length, events: state.events, errors: state.errors, proxy: state.proxy };
  });
}

async function expectNoRestart(page, fixture, generation, terminalCount) {
  const state = await snapshot(page);
  expect(state).toMatchObject({ generation, instances: 1, proxy: 0 });
  expect(state.errors).toHaveLength(terminalCount);
  expect(state.events.filter(event => event.name === 'MANIFEST_LOADING')).toHaveLength(1);
  expect(fixture.apiRequests).toEqual([]);
  expect(fixture.count('/test/master.m3u8')).toBe(1);
  return state;
}

for (const failure of [503, 408, 429, 'transport']) {
  test(`direct Hls retries transient child ${failure} in the same generation and reaches a fragment`, async ({ page, baseURL }) => {
    const fixture = await openPlayer(page, baseURL, (path, attempt) => {
      if (path.endsWith('/child.m3u8') && attempt === 1) {
        return failure === 'transport' ? { abort: true } : { status: failure, body: 'Transient failure' };
      }
    });
    try {
      const generation = await load(page);
      await expect.poll(() => fixture.count('/test/segment.ts')).toBe(1);
      await page.waitForTimeout(settleMs);
      expect(fixture.count('/test/child.m3u8')).toBe(2);
      const attempts = fixture.requests.filter(request => request.path === '/test/child.m3u8');
      expect(attempts[1].at - attempts[0].at).toBeGreaterThanOrEqual(400);
      const state = await expectNoRestart(page, fixture, generation, 0);
      expect(state.events.filter(event => event.name === 'MANIFEST_PARSED')).toHaveLength(1);
      expect(state.events.filter(event => event.name === 'LEVEL_LOADED')).toHaveLength(1);
      expect(state.events.filter(event => event.name === 'FRAG_LOADING')).toHaveLength(1);
    } finally { await fixture.close(); }
  });
}

const deniedResources = [401, 403, 404].flatMap(status =>
  ['master.m3u8', 'child.m3u8', 'segment.ts'].map(resource => ({ status, resource })));
for (const { status, resource } of deniedResources) {
  test(`direct Hls ${resource} ${status} makes one request and terminates once`, async ({ page, baseURL }) => {
    const fixture = await openPlayer(page, baseURL, path => path.endsWith(`/${resource}`) ? { status, body: 'Denied' } : undefined);
    try {
      const generation = await load(page);
      await expect.poll(async () => (await snapshot(page)).errors.length).toBe(1);
      await page.locator('video').evaluate(video => {
        video.dispatchEvent(new Event('error'));
        video.dispatchEvent(new Event('error'));
      });
      await page.waitForTimeout(settleMs);
      expect(fixture.count(`/test/${resource}`)).toBe(1);
      if (resource !== 'segment.ts') expect(fixture.count('/test/segment.ts')).toBe(0);
      const state = await expectNoRestart(page, fixture, generation, 1);
      expect(state.errors[0]).toMatchObject({ generation, status,
        reason: resource === 'master.m3u8' ? 'manifestLoadError' : resource === 'child.m3u8' ? 'levelLoadError' : 'fragLoadError' });
    } finally { await fixture.close(); }
  });
}

for (const resource of ['master.m3u8', 'child.m3u8', 'segment.ts']) {
  test(`direct Hls persistent 503 on ${resource} stops after two retries`, async ({ page, baseURL }) => {
    const fixture = await openPlayer(page, baseURL, path => path.endsWith(`/${resource}`) ? { status: 503, body: 'Unavailable' } : undefined);
    try {
      const generation = await load(page);
      await expect.poll(async () => (await snapshot(page)).errors.length).toBe(1);
      await page.waitForTimeout(settleMs);
      const attempts = fixture.requests.filter(request => request.path === `/test/${resource}`);
      expect(attempts).toHaveLength(3);
      expect(attempts[1].at - attempts[0].at).toBeGreaterThanOrEqual(400);
      expect(attempts[2].at - attempts[1].at).toBeGreaterThanOrEqual(900);
      const state = await snapshot(page);
      expect(state).toMatchObject({ generation, instances: 1, proxy: 0 });
      expect(state.errors).toHaveLength(1);
      expect(state.errors[0].status).toBe(503);
      expect(state.events.filter(event => event.name === 'MANIFEST_LOADING')).toHaveLength(1);
      expect(fixture.apiRequests).toEqual([]);
    } finally { await fixture.close(); }
  });
}

for (const resource of ['master.m3u8', 'child.m3u8']) {
  test(`direct Hls invalid ${resource} is terminal without retry`, async ({ page, baseURL }) => {
    const fixture = await openPlayer(page, baseURL, path => path.endsWith(`/${resource}`) ? { body: '<html>Not a manifest</html>' } : undefined);
    try {
      const generation = await load(page);
      await expect.poll(async () => (await snapshot(page)).errors.length).toBe(1);
      await page.waitForTimeout(settleMs);
      expect(fixture.count(`/test/${resource}`)).toBe(1);
      expect(fixture.count('/test/segment.ts')).toBe(0);
      await expectNoRestart(page, fixture, generation, 1);
    } finally { await fixture.close(); }
  });
}

test('switching direct Hls source destroys the old engine and cancels its scheduled retry', async ({ page, baseURL }) => {
  const fixture = await openPlayer(page, baseURL, path => path === '/old/child.m3u8' ? { status: 503, body: 'Old unavailable source' } : undefined);
  try {
    const generation = await load(page, 'old', 'new');
    await expect.poll(() => fixture.count('/new/segment.ts')).toBe(1);
    await page.waitForTimeout(settleMs);
    expect(fixture.count('/old/child.m3u8')).toBe(1);
    expect(fixture.count('/old/segment.ts')).toBe(0);
    expect(fixture.count('/new/child.m3u8')).toBe(1);
    const state = await snapshot(page);
    expect(state).toMatchObject({ generation: generation + 1, instances: 2, errors: [], proxy: 0 });
    expect(state.events.filter(event => event.index === 0 && event.name === 'DESTROYING')).toHaveLength(1);
    expect(fixture.apiRequests).toEqual([]);
  } finally { await fixture.close(); }
});

test('direct Hls retry policies cap errors and timeouts without retrying parse failures', async ({ page, baseURL }) => {
  const fixture = await openPlayer(page, baseURL, () => undefined);
  try {
    await load(page);
    const policies = await page.evaluate(() => {
      const config = window.__directHlsRetry.instances[0].config;
      return ['manifestLoadPolicy', 'playlistLoadPolicy', 'fragLoadPolicy', 'keyLoadPolicy'].map(name => {
        const policy = config[name].default;
        return ['errorRetry', 'timeoutRetry'].map(kind => {
          const retry = policy[kind];
          const decisions = [0, 408, 429, 500, 503, 599, 401, 403, 404, 400, 200, undefined].map(code =>
            retry.shouldRetry(retry, 0, false, code === undefined ? undefined : { code }, false));
          return { name, kind, maxNumRetry: retry.maxNumRetry, delay: retry.retryDelayMs, cap: retry.maxRetryDelayMs,
            decisions, timeout: retry.shouldRetry(retry, 0, true, undefined, true),
            exhausted: retry.shouldRetry(retry, 2, true, undefined, true),
            deniedTimeouts: [401, 403, 404].map(code => retry.shouldRetry(retry, 0, true, { code }, true)) };
        });
      }).flat();
    });
    for (const policy of policies) expect(policy).toMatchObject({
      maxNumRetry: 2, delay: 500, cap: 1000, timeout: true, exhausted: false, deniedTimeouts: [false, false, false],
      decisions: [true, true, true, true, true, true, false, false, false, false, false, false],
    });
  } finally { await fixture.close(); }
});
