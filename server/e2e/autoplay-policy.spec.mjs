import fs from 'node:fs/promises';
import { test, expect, chromium } from '@playwright/test';
import { createRoomFromHome, openRoomTab, uniqueRoomName, waitForRemoteMediaReady } from './helpers/room.mjs';
import { installRemoteWebMFixture } from './helpers/media.mjs';

// Keep runner observation out of the untouched guest; collect explicit evidence below.
test.use({ trace: 'off' });

async function recordAudioVideoFixture(browser, baseURL) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(baseURL);
    const recording = await page.evaluate(async () => {
      const mimeType = 'video/webm;codecs=vp8,opus';
      if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error(`Unsupported recording codec: ${mimeType}`);
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const drawing = canvas.getContext('2d');
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const destination = audio.createMediaStreamDestination();
      const videoStream = canvas.captureStream(12);
      const stream = new MediaStream([...videoStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);
      let recorder;
      let drawTimer;
      let stopTimer;
      let watchdog;
      try {
        await audio.resume();
        if (audio.state !== 'running') throw new Error('Recording AudioContext did not start');
        oscillator.frequency.value = 440;
        gain.gain.value = 0.05;
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        let frame = 0;
        const draw = () => {
          drawing.fillStyle = frame % 2 ? '#176b4d' : '#183f70';
          drawing.fillRect(0, 0, canvas.width, canvas.height);
          drawing.fillStyle = '#ffffff';
          drawing.font = '24px sans-serif';
          drawing.fillText(`AV autoplay gate ${frame++}`, 12, 90);
        };
        draw();
        drawTimer = setInterval(draw, 80);
        recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 160000, audioBitsPerSecond: 32000 });
        const chunks = await new Promise((resolve, reject) => {
          const parts = [];
          let bytes = 0;
          recorder.ondataavailable = event => {
            bytes += event.data.size;
            if (bytes > 2 * 1024 * 1024) reject(new Error('AV fixture exceeded 2 MiB'));
            else parts.push(event.data);
          };
          recorder.onerror = event => reject(new Error(event.error?.message || 'MediaRecorder failed'));
          recorder.onstop = () => resolve(parts);
          watchdog = setTimeout(() => reject(new Error('AV recording exceeded 23 seconds')), 23000);
          stopTimer = setTimeout(() => recorder.stop(), 18000);
          recorder.start(250);
        });
        const blob = new Blob(chunks, { type: 'video/webm' });
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        return {
          base64: dataUrl.split(';base64,')[1], mimeType,
          audioTracks: stream.getAudioTracks().length, videoTracks: stream.getVideoTracks().length,
          audioState: audio.state, oscillatorHz: oscillator.frequency.value,
        };
      } finally {
        clearInterval(drawTimer);
        clearTimeout(stopTimer);
        clearTimeout(watchdog);
        if (recorder && recorder.state !== 'inactive') recorder.stop();
        oscillator.stop();
        oscillator.disconnect();
        gain.disconnect();
        stream.getTracks().forEach(track => track.stop());
        await audio.close();
      }
    });
    const buffer = Buffer.from(recording.base64, 'base64');
    expect(recording.audioTracks).toBe(1);
    expect(recording.videoTracks).toBe(1);
    expect(recording.audioState).toBe('running');
    expect(buffer.length).toBeGreaterThan(1024);
    expect(buffer.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(buffer.subarray(0, 4).toString('hex'), 'Recorded fixture must have an EBML header').toBe('1a45dfa3');
    expect(buffer.includes(Buffer.from('A_OPUS')), 'Recorded WebM must contain an Opus codec entry').toBe(true);
    const { base64, ...metadata } = recording;
    return { buffer, metadata: { ...metadata, bytes: buffer.length } };
  } finally {
    await context.close();
  }
}

function installNativePlayProbe() {
  const nativePlay = HTMLMediaElement.prototype.play;
  const probe = window.__autoplayPolicyProbe = {
    calls: [], emitted: [], roomStates: [], playbackStates: [], trustedCenterClicks: 0,
  };
  HTMLMediaElement.prototype.play = function (...args) {
    if (!this.matches('[data-room-video]')) return Reflect.apply(nativePlay, this, args);
    const call = {
      muted: this.muted, volume: this.volume, source: this.currentSrc || this.src,
      hasBeenActive: navigator.userActivation.hasBeenActive,
      isActive: navigator.userActivation.isActive, outcome: 'pending',
    };
    probe.calls.push(call);
    const rejected = error => {
      call.outcome = 'rejected';
      call.errorName = error.name;
      call.errorMessage = error.message;
      throw error;
    };
    try {
      // Never synthesize or swallow a rejection: call native play and rethrow its error.
      return Reflect.apply(nativePlay, this, args).then(() => { call.outcome = 'resolved'; }, rejected);
    } catch (error) {
      return rejected(error);
    }
  };
  addEventListener('click', event => {
    if (event.isTrusted && event.target.closest?.('[data-player-center-play]')) probe.trustedCenterClicks += 1;
  }, true);
}

// Observe socket traffic without blocking/changing acknowledgements or authority.
const socketProbe = `{
  const originalIo = window.io;
  window.io = function (...args) {
    const socket = Reflect.apply(originalIo, this, args);
    const probe = window.__autoplayPolicyProbe;
    const recordRoom = state => {
      if (!state?.security) return;
      probe.roomStates.push({hostMemberId:state.hostMemberId, controlPolicy:state.security.controlPolicy});
      if (probe.roomStates.length > 100) probe.roomStates.shift();
    };
    socket.on('room_state', recordRoom);
    socket.on('playback_state', state => {
      probe.playbackStates.push({playing:state.playing, updatedBy:state.updatedBy, revision:state.revision});
      if (probe.playbackStates.length > 100) probe.playbackStates.shift();
    });
    const emit = socket.emit;
    socket.emit = function (event, ...values) {
      if (event === 'playback_update' || event === 'room_control_policy_update') {
        probe.emitted.push({event, action:values[0]?.action});
      }
      if (event === 'join_room' && typeof values[values.length - 1] === 'function') {
        const ack = values[values.length - 1];
        values[values.length - 1] = function (...states) { recordRoom(states[0]); return Reflect.apply(ack, this, states); };
      }
      return Reflect.apply(emit, this, [event, ...values]);
    };
    return socket;
  };
}
`;

async function readGuest(cdp) {
  // Playwright evaluation may mark a CDP invocation as a user gesture. Explicitly
  // disable it here, including all reads before the one intentional button click.
  const result = await cdp.send('Runtime.evaluate', {
    userGesture: false, returnByValue: true,
    expression: `JSON.stringify((() => {
      const video = document.querySelector('[data-room-video]');
      const center = document.querySelector('[data-player-center-play]');
      const style = center && getComputedStyle(center);
      return {
        probe: window.__autoplayPolicyProbe,
        access: document.body?.dataset.roomAccess,
        policy: document.body?.dataset.roomControlPolicy,
        memberId: sessionStorage.getItem('together-see:member-id'),
        activation: {hasBeenActive:navigator.userActivation.hasBeenActive, isActive:navigator.userActivation.isActive},
        video: video && {paused:video.paused, muted:video.muted, volume:video.volume, readyState:video.readyState,
          currentTime:video.currentTime, ended:video.ended, currentSrc:video.currentSrc, audioDecodedBytes:video.webkitAudioDecodedByteCount || 0},
        center: center && {disabled:center.disabled, opacity:Number(style.opacity), pointerEvents:style.pointerEvents},
        playDisabled: document.querySelector('[data-player-play]')?.disabled,
        readonly: document.querySelector('[data-player-shell]')?.classList.contains('is-playback-readonly')
      };
    })())`,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return JSON.parse(result.result.value);
}

test('default Chromium blocks audible guest autoplay once and one local tap resumes under host_only', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120000);
  const evidence = { fixture: null, browser: null, beforeTap: null, afterTap: null, mediaProperties: {} };
  const clip = await recordAudioVideoFixture(browser, baseURL);
  evidence.fixture = clip.metadata;
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  let policyBrowser;
  let guestContext;
  let guest;
  let cdp;
  let completed = false;
  try {
    // Intentionally do not inherit the main suite's autoplay override or launch args.
    policyBrowser = await chromium.launch({
      executablePath: testInfo.project.use.launchOptions.executablePath,
      headless: true,
      args: [],
    });
    const browserCdp = await policyBrowser.newBrowserCDPSession();
    evidence.browser = { version: policyBrowser.version(), requestedArgs: [] };
    const commandLine = await browserCdp.send('Browser.getBrowserCommandLine').catch(error => {
      evidence.browser.commandLineUnavailable = error.message;
      return null;
    });
    if (commandLine) {
      evidence.browser.autoplayPolicyArguments = commandLine.arguments.filter(arg => arg.startsWith('--autoplay-policy'));
      expect(evidence.browser.autoplayPolicyArguments).toEqual([]);
    }
    await browserCdp.detach();
    guestContext = await policyBrowser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
    await guestContext.addInitScript(installNativePlayProbe);
    const roomSource = await fs.readFile(new URL('../../assets/js/room.js', import.meta.url), 'utf8');
    await guestContext.route('**/assets/js/room.js*', route => route.fulfill({
      contentType: 'application/javascript', body: socketProbe + roomSource,
    }));
    const mediaUrl = 'https://93.184.216.34/autoplay-policy-av.webm';
    for (const context of [hostContext, guestContext]) {
      await installRemoteWebMFixture(context, {
        inputUrl: mediaUrl, mediaUrl, title: 'Audible Autoplay Gate', buffer: clip.buffer,
        mimeType: 'video/webm', mockParser: true,
      });
    }
    const host = await hostContext.newPage();
    const roomName = uniqueRoomName('AUTOPLAY');
    await createRoomFromHome(host, baseURL, { roomName, nickname: 'Autoplay Host' });
    await expect(host.locator('body')).toHaveAttribute('data-room-control-policy', 'host_only');
    const hostMemberId = await host.evaluate(() => sessionStorage.getItem('together-see:member-id'));
    await openRoomTab(host, 'playlist');
    const form = host.locator('[data-playlist-form]');
    await form.locator('input').fill(mediaUrl);
    await form.evaluate(node => node.requestSubmit());
    await waitForRemoteMediaReady(host, 'Audible Autoplay Gate');
    await host.locator('[data-player-center-play]').click();
    await expect.poll(() => host.locator('[data-room-video]').evaluate(video => video.paused)).toBe(false);
    await expect.poll(() => host.locator('[data-room-video]').evaluate(video => video.currentTime)).toBeGreaterThan(0.2);

    guest = await guestContext.newPage();
    cdp = await guestContext.newCDPSession(guest);
    cdp.on('Media.playerPropertiesChanged', ({ playerId, properties }) => {
      const values = evidence.mediaProperties[playerId] ||= {};
      for (const property of properties) values[property.name] = property.value;
    });
    await cdp.send('Media.enable');
    // No home page, fill, click, keyboard, storage identity or media permission seeding.
    const guestUrl = new URL('/room.html', baseURL);
    guestUrl.searchParams.set('room', roomName);
    guestUrl.searchParams.set('nick', 'No Gesture Guest');
    await guest.goto(guestUrl.href);
    await expect.poll(() => readGuest(cdp)).toMatchObject({ access: 'granted', policy: 'host_only', activation: { hasBeenActive: false } });
    await expect.poll(async () => (await readGuest(cdp)).video?.readyState).toBeGreaterThanOrEqual(2);
    await expect.poll(() => Object.values(evidence.mediaProperties).some(properties => {
      try { return JSON.parse(properties.kAudioTracks || '[]').length > 0; } catch { return false; }
    }), { message: 'Guest Chromium must report a real encoded audio track' }).toBe(true);
    await expect.poll(async () => (await readGuest(cdp)).probe.calls).toMatchObject([
      { outcome: 'rejected', errorName: 'NotAllowedError', muted: false, volume: 1, hasBeenActive: false, isActive: false },
    ]);

    // Observe over two host periodic-sync intervals, not just one rejected microtask.
    const initialUpdates = (await readGuest(cdp)).probe.playbackStates.length;
    await new Promise(resolve => setTimeout(resolve, 5500));
    evidence.beforeTap = await readGuest(cdp);
    expect(evidence.beforeTap.probe.calls).toHaveLength(1);
    expect(evidence.beforeTap.probe.playbackStates.length).toBeGreaterThan(initialUpdates);
    expect(evidence.beforeTap.activation.hasBeenActive).toBe(false);
    expect(evidence.beforeTap.video).toMatchObject({ paused: true, muted: false, volume: 1, ended: false, currentSrc: mediaUrl });
    expect(evidence.beforeTap.center).toMatchObject({ disabled: false, opacity: 1, pointerEvents: 'auto' });
    expect(evidence.beforeTap.playDisabled).toBe(true);
    expect(evidence.beforeTap.readonly).toBe(true);
    expect(evidence.beforeTap.probe.emitted).toEqual([]);
    expect(evidence.beforeTap.probe.roomStates.at(-1)).toEqual({ hostMemberId, controlPolicy: 'host_only' });
    expect(evidence.beforeTap.memberId).not.toBe(hostMemberId);

    await guest.locator('[data-player-center-play]').click();
    await expect.poll(async () => (await readGuest(cdp)).video.paused).toBe(false);
    const startedAt = (await readGuest(cdp)).video.currentTime;
    await expect.poll(async () => (await readGuest(cdp)).video.currentTime).toBeGreaterThan(startedAt + 1);
    await new Promise(resolve => setTimeout(resolve, 2600));
    evidence.afterTap = await readGuest(cdp);
    expect(evidence.afterTap.probe.calls).toHaveLength(2);
    expect(evidence.afterTap.probe.calls[1]).toMatchObject({ outcome: 'resolved', hasBeenActive: true, isActive: true, muted: false, volume: 1 });
    expect(evidence.afterTap.probe.trustedCenterClicks).toBe(1);
    expect(evidence.afterTap.video).toMatchObject({ paused: false, muted: false, ended: false });
    expect(evidence.afterTap.video.audioDecodedBytes).toBeGreaterThan(0);
    expect(evidence.afterTap.policy).toBe('host_only');
    expect(evidence.afterTap.playDisabled).toBe(true);
    expect(evidence.afterTap.readonly).toBe(true);
    expect(evidence.afterTap.probe.emitted).toEqual([]);
    expect(evidence.afterTap.probe.playbackStates.at(-1)?.updatedBy).toBe(hostMemberId);
    completed = true;
    console.log(`AUTOPLAY EVIDENCE ${JSON.stringify({ fixture: evidence.fixture, browser: evidence.browser,
      initialError: evidence.beforeTap.probe.calls[0], attemptsBeforeTap: 1, attemptsAfterTap: 2,
      trustedCenterClicks: 1, resumedFrom: startedAt, resumedTo: evidence.afterTap.video.currentTime,
      audioDecodedBytes: evidence.afterTap.video.audioDecodedBytes, guestPlaybackSubmissions: 0, policy: evidence.afterTap.policy })}`);
  } finally {
    if (cdp) evidence.finalSnapshot = await readGuest(cdp).catch(error => ({ readError: error.message }));
    await testInfo.attach('autoplay-policy-evidence.json', { body: Buffer.from(JSON.stringify(evidence, null, 2)), contentType: 'application/json' });
    if (!completed && guest) {
      const screenshot = await guest.screenshot({ timeout: 5000 }).catch(() => null);
      if (screenshot) await testInfo.attach('autoplay-policy-failure.png', { body: screenshot, contentType: 'image/png' });
    }
    try { if (policyBrowser) await policyBrowser.close(); }
    finally { await hostContext.close(); }
  }
});
