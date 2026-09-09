import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  capturePageErrors,
  closeRoomContexts,
  createRoomContexts,
  createRoomFromHome,
  installMediaTelemetry,
  installPlaybackStatusTelemetry,
  joinRoomFromHome,
  openRoomTab,
  playlistItem,
  readMediaState,
  readMediaTelemetry,
  readPlaybackStatusTelemetry,
  uniqueRoomName,
  waitForRemoteMediaReady,
} from './helpers/room.mjs';
import { buildRepeatedFixtureWebM, installRemoteWebMFixture } from './helpers/media.mjs';

const soakMinutes = Number(process.env.TOGETHER_SEE_SOAK_MINUTES || 30);
const soakDurationMs = Math.ceil(soakMinutes * 60_000);
const weakGateEnabled = process.env.TOGETHER_SEE_SOAK_WEAK_GATE !== '0';
const sampleIntervalMs = 5000;

function driftSeconds(left, right) {
  return Math.abs(Number(left.currentTime || 0) - Number(right.currentTime || 0));
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function summarizeRequests(requests) {
  const statuses = {};
  let bytes = 0;
  for (const request of requests) {
    const status = String(request.status);
    statuses[status] = (statuses[status] || 0) + 1;
    bytes += Number(request.bytes || 0);
  }
  return { count: requests.length, bytes, statuses };
}

function serializeFailure(error) {
  if (!error) return null;
  return {
    name: String(error.name || 'Error'),
    message: String(error.message || error),
    stack: typeof error.stack === 'string' ? error.stack : '',
  };
}

async function safeRead(read) {
  try {
    return await Promise.race([
      read(),
      new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
  } catch {
    return null;
  }
}

test('desktop and mobile contexts survive weak media delivery and a continuous playback soak', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(soakDurationMs + (8 * 60_000));
  const roomName = uniqueRoomName('SOAK');
  const { hostContext, guestContext } = await createRoomContexts(browser);
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();
  const hostErrors = capturePageErrors(hostPage, 'soak host');
  const guestErrors = capturePageErrors(guestPage, 'soak guest');
  const hostRequests = [];
  const guestRequests = [];
  let guestNetwork = { blocked: false, delayMs: 250, maxChunkBytes: 16 * 1024 };
  const report = {
    roomName,
    soakMinutes,
    weakGateEnabled,
    startedAt: new Date().toISOString(),
    status: 'running',
    samples: [],
    weakGate: null,
  };
  let media = null;
  let initialHost = null;
  let initialGuest = null;
  let soakInitialHost = null;
  let soakInitialGuest = null;
  let maxDriftSeconds = 0;
  let primaryError = null;

  try {
    await createRoomFromHome(hostPage, baseURL, { roomName, nickname: 'Soak Host' });
    await joinRoomFromHome(guestPage, baseURL, { roomName, nickname: 'Soak Mobile' });
    await expect(hostPage.locator('[data-toolbar-member-count]')).toHaveText('2');
    await expect(guestPage.locator('[data-toolbar-member-count]')).toHaveText('2');

    media = buildRepeatedFixtureWebM({
      name: 'together-see-long-play.webm',
      durationSeconds: Math.max(300, (soakDurationMs / 1000) + 300),
      paddingBytesPerCluster: 32 * 1024,
    });
    const inputUrl = 'https://93.184.216.34/e2e-soak-input.webm';
    const mediaUrl = 'https://93.184.216.34/e2e-soak-media.webm';
    await installRemoteWebMFixture(hostContext, {
      inputUrl,
      mediaUrl,
      title: 'Together See Soak',
      buffer: media.buffer,
      mimeType: media.mimeType,
      mockParser: true,
      networkProfile: { maxChunkBytes: 256 * 1024 },
      onMediaRequest: (entry) => hostRequests.push(entry),
    });
    await installRemoteWebMFixture(guestContext, {
      inputUrl,
      mediaUrl,
      title: 'Together See Soak',
      buffer: media.buffer,
      mimeType: media.mimeType,
      networkProfile: () => guestNetwork,
      onMediaRequest: (entry) => guestRequests.push(entry),
    });

    await installMediaTelemetry(hostPage);
    await installMediaTelemetry(guestPage);
    await installPlaybackStatusTelemetry(guestPage);
    await openRoomTab(hostPage, 'playlist');
    const playlistForm = hostPage.locator('[data-playlist-form]');
    await playlistForm.locator('input[name="videoLink"]').fill(inputUrl);
    await playlistForm.evaluate((form) => form.requestSubmit());
    await expect(playlistItem(hostPage, 'Together See Soak')).toHaveCount(1);
    await expect(playlistItem(guestPage, 'Together See Soak')).toHaveCount(1);
    await waitForRemoteMediaReady(hostPage, 'Together See Soak');
    await waitForRemoteMediaReady(guestPage, 'Together See Soak');

    initialHost = await readMediaState(hostPage);
    initialGuest = await readMediaState(guestPage);
    expect(Number.isFinite(initialHost.duration)).toBe(true);
    expect(Number.isFinite(initialGuest.duration)).toBe(true);
    expect(initialHost.duration).toBeGreaterThanOrEqual(media.expectedDurationSeconds - 0.25);
    expect(initialGuest.duration).toBeGreaterThanOrEqual(media.expectedDurationSeconds - 0.25);
    const sourceId = initialHost.sourceId;
    const hostSrc = initialHost.currentSrc;
    const guestSrc = initialGuest.currentSrc;

    await hostPage.locator('[data-player-play]').click({ force: true });
    await expect.poll(() => readMediaState(hostPage).then((state) => state.paused)).toBe(false);
    await expect.poll(() => readMediaState(guestPage).then((state) => state.paused)).toBe(false);

    if (weakGateEnabled) {
      const weakStartedAt = Date.now();
      guestNetwork = { blocked: true, delayMs: 0, maxChunkBytes: 4 * 1024 };
      await expect.poll(() => guestPage.evaluate(() => window.TogetherSeePlayer.isMediaReadyForSync()), {
        timeout: 90_000,
      }).toBe(false);
      const unreadyAt = Date.now();
      await expect.poll(async () => (await readPlaybackStatusTelemetry(guestPage))
        .some((entry) => entry.text.includes('网络不稳定')), { timeout: 45_000 }).toBe(true);
      const suspendedAt = Date.now();
      const telemetryAtSuspend = await readMediaTelemetry(guestPage);
      await guestPage.waitForTimeout(5500);
      const telemetryWhileSuspended = await readMediaTelemetry(guestPage);
      expect(telemetryWhileSuspended.counts.seeking).toBe(telemetryAtSuspend.counts.seeking);

      guestNetwork = { blocked: false, delayMs: 0, maxChunkBytes: 256 * 1024 };
      await expect.poll(() => guestPage.evaluate(() => window.TogetherSeePlayer.isMediaReadyForSync()), {
        timeout: 90_000,
      }).toBe(true);
      const readyAgainAt = Date.now();
      await expect.poll(async () => (await readPlaybackStatusTelemetry(guestPage))
        .some((entry) => entry.text.includes('播放已稳定')), { timeout: 45_000 }).toBe(true);
      const stableStatus = (await readPlaybackStatusTelemetry(guestPage))
        .findLast((entry) => entry.text.includes('播放已稳定'));
      expect(stableStatus.at - readyAgainAt).toBeGreaterThanOrEqual(14_000);
      await expect.poll(async () => driftSeconds(await readMediaState(hostPage), await readMediaState(guestPage)), {
        timeout: 45_000,
      }).toBeLessThanOrEqual(3.5);
      report.weakGate = {
        weakStartedAt,
        unreadyAt,
        suspendedAt,
        readyAgainAt,
        stableAt: stableStatus.at,
        unreadyToSuspendMs: suspendedAt - unreadyAt,
        recoveryStableMs: Date.now() - readyAgainAt,
      };
    } else {
      guestNetwork = { blocked: false, delayMs: 0, maxChunkBytes: 256 * 1024 };
    }

    [soakInitialHost, soakInitialGuest] = await Promise.all([
      readMediaState(hostPage),
      readMediaState(guestPage),
    ]);
    const baselineHostTelemetry = await readMediaTelemetry(hostPage);
    const baselineGuestTelemetry = await readMediaTelemetry(guestPage);
    const soakStartedAt = Date.now();
    let nextProgressLogMs = 5 * 60_000;
    while (Date.now() - soakStartedAt < soakDurationMs) {
      const [hostState, guestState, hostTelemetry, guestTelemetry] = await Promise.all([
        readMediaState(hostPage),
        readMediaState(guestPage),
        readMediaTelemetry(hostPage),
        readMediaTelemetry(guestPage),
      ]);
      const drift = driftSeconds(hostState, guestState);
      maxDriftSeconds = Math.max(maxDriftSeconds, drift);
      report.samples.push({
        elapsedMs: Date.now() - soakStartedAt,
        driftSeconds: drift,
        host: hostState,
        guest: guestState,
      });

      expect(hostState.sourceId).toBe(sourceId);
      expect(guestState.sourceId).toBe(sourceId);
      expect(hostState.currentSrc).toBe(hostSrc);
      expect(guestState.currentSrc).toBe(guestSrc);
      expect(hostState.ended).toBe(false);
      expect(guestState.ended).toBe(false);
      expect(hostState.playbackRate).toBeGreaterThanOrEqual(0.5);
      expect(hostState.playbackRate).toBeLessThanOrEqual(3);
      expect(guestState.playbackRate).toBeGreaterThanOrEqual(0.5);
      expect(guestState.playbackRate).toBeLessThanOrEqual(3);
      expect(drift).toBeLessThanOrEqual(4);
      expect(hostTelemetry.counts.error).toBe(0);
      expect(guestTelemetry.counts.error).toBe(0);
      expect(hostTelemetry.counts.loadstart).toBe(baselineHostTelemetry.counts.loadstart);
      expect(hostTelemetry.counts.emptied).toBe(baselineHostTelemetry.counts.emptied);
      expect(guestTelemetry.counts.loadstart).toBe(baselineGuestTelemetry.counts.loadstart);
      expect(guestTelemetry.counts.emptied).toBe(baselineGuestTelemetry.counts.emptied);
      await expect(hostPage.locator('body')).toHaveAttribute('data-socket-connected', 'true');
      await expect(guestPage.locator('body')).toHaveAttribute('data-socket-connected', 'true');
      const elapsedMs = Date.now() - soakStartedAt;
      if (elapsedMs >= nextProgressLogMs) {
        console.log(`[soak-progress] ${JSON.stringify({
          elapsedMinutes: Number((elapsedMs / 60_000).toFixed(1)),
          targetMinutes: soakMinutes,
          driftSeconds: Number(drift.toFixed(3)),
          maxDriftSeconds: Number(maxDriftSeconds.toFixed(3)),
          hostTime: Number(hostState.currentTime.toFixed(1)),
          guestTime: Number(guestState.currentTime.toFixed(1)),
          hostReadyState: hostState.readyState,
          guestReadyState: guestState.readyState,
        })}`);
        nextProgressLogMs += 5 * 60_000;
      }
      const remainingMs = soakDurationMs - elapsedMs;
      if (remainingMs > 0) await hostPage.waitForTimeout(Math.min(sampleIntervalMs, remainingMs));
    }

    const [finalHost, finalGuest, finalHostTelemetry, finalGuestTelemetry] = await Promise.all([
      readMediaState(hostPage),
      readMediaState(guestPage),
      readMediaTelemetry(hostPage),
      readMediaTelemetry(guestPage),
    ]);
    expect(finalHost.currentTime - soakInitialHost.currentTime).toBeGreaterThan((soakDurationMs / 1000) * 0.85);
    expect(finalGuest.currentTime - soakInitialGuest.currentTime).toBeGreaterThan((soakDurationMs / 1000) * 0.80);
    expect(finalHostTelemetry.counts.error).toBe(0);
    expect(finalGuestTelemetry.counts.error).toBe(0);
    expect(hostRequests.length).toBeGreaterThan(0);
    expect(guestRequests.length).toBeGreaterThan(0);
    expect(hostRequests.every((request) => request.status === 206)).toBe(true);
    expect(guestRequests.every((request) => request.status === 206)).toBe(true);
    expect(hostErrors).toEqual([]);
    expect(guestErrors).toEqual([]);

    const driftSamples = report.samples.map((sample) => sample.driftSeconds);
    const hostProgressSeconds = finalHost.currentTime - soakInitialHost.currentTime;
    const guestProgressSeconds = finalGuest.currentTime - soakInitialGuest.currentTime;
    Object.assign(report, {
      status: 'passed',
      completedAt: new Date().toISOString(),
      fixtureBytes: media.buffer.byteLength,
      fixtureDurationSeconds: media.expectedDurationSeconds,
      maxDriftSeconds,
      driftP50Seconds: percentile(driftSamples, 0.5),
      driftP95Seconds: percentile(driftSamples, 0.95),
      hostProgressSeconds,
      guestProgressSeconds,
      hostPlayTimeRatio: hostProgressSeconds / (soakDurationMs / 1000),
      guestPlayTimeRatio: guestProgressSeconds / (soakDurationMs / 1000),
      healthySampleRatio: report.samples.length ? 1 : 0,
      hostRequests: summarizeRequests(hostRequests),
      guestRequests: summarizeRequests(guestRequests),
      finalHost,
      finalGuest,
      finalHostTelemetry,
      finalGuestTelemetry,
      pageErrors: { hostErrors, guestErrors },
    });
  } catch (error) {
    primaryError = error;
    report.status = 'failed';
    report.failure = serializeFailure(error);
  } finally {
    report.completedAt ||= new Date().toISOString();
    report.fixtureBytes ??= media?.buffer?.byteLength ?? null;
    report.fixtureDurationSeconds ??= media?.expectedDurationSeconds ?? null;
    report.maxDriftSeconds ??= maxDriftSeconds;
    report.hostRequests ??= summarizeRequests(hostRequests);
    report.guestRequests ??= summarizeRequests(guestRequests);
    report.finalHost ??= await safeRead(() => readMediaState(hostPage));
    report.finalGuest ??= await safeRead(() => readMediaState(guestPage));
    report.finalHostTelemetry ??= await safeRead(() => readMediaTelemetry(hostPage));
    report.finalGuestTelemetry ??= await safeRead(() => readMediaTelemetry(guestPage));
    report.pageErrors ??= { hostErrors, guestErrors };
    report.initialHost ??= initialHost;
    report.initialGuest ??= initialGuest;
    report.soakInitialHost ??= soakInitialHost;
    report.soakInitialGuest ??= soakInitialGuest;
    const reportPath = testInfo.outputPath('long-play-report.json');
    try {
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      await testInfo.attach('long-play-report', { path: reportPath, contentType: 'application/json' });
      console.log(`[soak-report] ${JSON.stringify({
        status: report.status,
        soakMinutes,
        weakGateEnabled,
        samples: report.samples.length,
        maxDriftSeconds: report.maxDriftSeconds,
        hostPlayTimeRatio: report.hostPlayTimeRatio ?? null,
        guestPlayTimeRatio: report.guestPlayTimeRatio ?? null,
        hostRequests: report.hostRequests.count,
        guestRequests: report.guestRequests.count,
        failure: report.failure?.message || null,
      })}`);
    } catch (reportError) {
      console.error(`[soak-report-error] ${reportError instanceof Error ? reportError.message : reportError}`);
      primaryError ||= reportError;
    }
    try {
      await closeRoomContexts({ hostContext, guestContext, hostPage, guestPage });
    } catch (cleanupError) {
      primaryError ||= cleanupError;
    }
  }
  if (primaryError) throw primaryError;
});
