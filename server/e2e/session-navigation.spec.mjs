import fs from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { createRoomFromHome, joinRoomFromHome, openRoomTab, uniqueRoomName, waitForRoomAccess } from './helpers/room.mjs';

// Observe real Socket traffic only; never synthesize admission/recovery responses.
const socketObserver = `{
  const originalIo = window.io;
  window.io = function (...args) {
    const socket = Reflect.apply(originalIo, this, args);
    const probe = window.__sessionNavigation = { socket, joins: [], errors: [], recoveries: 0, members: [], permissions: null };
    socket.on('room_state', state => { probe.members = state.members.map(member => member.id); });
    socket.on('room_permissions', value => { probe.permissions = { canManage: value.canManage, isCreator: value.isCreator }; });
    socket.on('room_error', value => { probe.errors.push(value.code); });
    const emit = socket.emit;
    socket.emit = function (event, ...values) {
      if (event === 'join_room') probe.joins.push({ memberId: values[0].memberId, hasAdmin: !!values[0].adminToken, hasReconnect: !!values[0].reconnectToken });
      if (event === 'recover_admin_token') probe.recoveries += 1;
      return Reflect.apply(emit, this, [event, ...values]);
    };
    return socket;
  };
}
`;

async function createOwner(browser, baseURL) {
  const context = await browser.newContext();
  try {
    const roomSource = await fs.readFile(new URL('../../assets/js/room.js', import.meta.url), 'utf8');
    await context.route('**/assets/js/room.js*', route => route.fulfill({ contentType: 'application/javascript', body: socketObserver + roomSource }));
    const owner = await context.newPage();
    const roomName = uniqueRoomName('NAV');
    await createRoomFromHome(owner, baseURL, { roomName, nickname: 'Navigation Creator' });
    await expect.poll(() => owner.evaluate(() => window.__sessionNavigation.permissions)).toMatchObject({ canManage: true, isCreator: true });
    await expect.poll(() => identity(owner, roomName).then(value => !!value.reconnect)).toBe(true);
    return { context, owner, roomName, original: await identity(owner, roomName) };
  } catch (error) {
    await context.close();
    throw error;
  }
}

function identity(page, roomName) {
  return page.evaluate(room => ({
    memberId: sessionStorage.getItem('together-see:member-id'),
    clientId: localStorage.getItem('together-see:client-id'),
    admin: sessionStorage.getItem('together-see:room-admin:' + room),
    reconnect: sessionStorage.getItem('together-see:room-member-token:' + room),
    recovery: localStorage.getItem('together-see:room-admin-recovery:' + room),
  }), roomName);
}

async function expectSingleCreator(page, original, roomName) {
  await waitForRoomAccess(page);
  await expect.poll(() => page.evaluate(() => window.__sessionNavigation.members)).toEqual([original.memberId]);
  await expect.poll(() => page.evaluate(() => window.__sessionNavigation.permissions)).toMatchObject({ canManage: true, isCreator: true });
  const current = await identity(page, roomName);
  expect(current.memberId).toBe(original.memberId);
  expect(current.clientId).toBe(original.clientId);
  expect(current.admin).toBe(original.admin);
  expect(current.recovery).toBe(original.recovery);
}

async function overlappingPage(context, owner, roomName, original, withSecrets) {
  const page = await context.newPage();
  // An independent real document retains the old live Socket while presenting the
  // same tab identity; this deterministically models delayed navigation release.
  await page.addInitScript(({ room, value, secrets }) => {
    sessionStorage.setItem('together-see:member-id', value.memberId);
    if (secrets) {
      sessionStorage.setItem('together-see:room-admin:' + room, value.admin);
      sessionStorage.setItem('together-see:room-member-token:' + room, value.reconnect);
    }
  }, { room: roomName, value: withSecrets ? original : { memberId: original.memberId }, secrets: withSecrets });
  const url = new URL(owner.url());
  url.searchParams.delete('created');
  url.searchParams.set('navigation', 'overlap');
  await page.goto(url.href);
  return page;
}

test('same-tab query navigation and reload preserve one creator and credentials', async ({ browser, baseURL }) => {
  const { context, owner, roomName, original } = await createOwner(browser, baseURL);
  try {
    const url = new URL(owner.url());
    url.searchParams.delete('created');
    url.searchParams.set('navigation', 'same-tab');
    await owner.goto(url.href);
    await expectSingleCreator(owner, original, roomName);
    await owner.reload();
    await expectSingleCreator(owner, original, roomName);
    url.searchParams.delete('navigation');
    await owner.goto(url.href);
    await expectSingleCreator(owner, original, roomName);
    expect(await owner.evaluate(() => window.__sessionNavigation.recoveries)).toBe(0);
  } finally { await context.close(); }
});

test('delayed old Socket release retries the same identity without losing admin or reconnect tokens', async ({ browser, baseURL }) => {
  const { context, owner, roomName, original } = await createOwner(browser, baseURL);
  try {
    const next = await overlappingPage(context, owner, roomName, original, true);
    await expect(next.locator('body')).toHaveAttribute('data-room-access', 'session_wait');
    await expect.poll(() => next.evaluate(() => window.__sessionNavigation.joins.length)).toBeGreaterThanOrEqual(2);
    expect(await identity(next, roomName)).toEqual(original);
    expect(await owner.evaluate(() => window.__sessionNavigation.members)).toEqual([original.memberId]);
    await owner.close();
    await expectSingleCreator(next, original, roomName);
    await expect.poll(() => identity(next, roomName).then(value => value.reconnect !== original.reconnect)).toBe(true);
    const probe = await next.evaluate(() => ({ joins: window.__sessionNavigation.joins, errors: window.__sessionNavigation.errors, recoveries: window.__sessionNavigation.recoveries }));
    expect(probe.errors).toContain('member_online_elsewhere');
    expect(probe.joins.length).toBeLessThanOrEqual(7);
    expect(probe.joins.every(join => join.memberId === original.memberId && join.hasAdmin && join.hasReconnect)).toBe(true);
    expect(probe.recoveries).toBe(0);
  } finally { await context.close(); }
});

async function dropFirstDepartureDisconnect(page) {
  return page.evaluate(() => {
    const socket = window.__sessionNavigation.socket;
    const originalDisconnect = socket.disconnect;
    const initialId = socket.id;
    let changedSocketId = false;
    const events = window.__departureEvents = { connect: 0, disconnect: 0, managerClose: 0, engineClose: 0, reconnectAttempt: 0, dropped: 0, guardedDisconnect: 0 };
    socket.on('connect', () => { events.connect += 1; });
    socket.on('disconnect', () => { events.disconnect += 1; });
    socket.io.on('close', () => { events.managerClose += 1; });
    socket.io.on('reconnect_attempt', () => { events.reconnectAttempt += 1; });
    socket.io.engine.on('close', () => { events.engineClose += 1; });
    window.__departureSnapshot = () => ({ ...events, connected: socket.connected, active: socket.active, changedSocketId });
    socket.disconnect = function () {
      events.dropped += 1;
      // Restore normal behavior immediately: a later suspended-page reconnect
      // guard must not be disabled by this one-time transport-loss fixture.
      this.disconnect = function (...args) {
        events.guardedDisconnect += 1;
        changedSocketId ||= Boolean(this.id && this.id !== initialId);
        return Reflect.apply(originalDisconnect, this, args);
      };
      return this;
    };
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    return window.__sessionNavigation.joins.length;
  });
}

async function dropFirstDepartureCloseDelivery(page) {
  return page.evaluate(() => {
    const socket = window.__sessionNavigation.socket;
    const manager = socket.io;
    const engine = manager.engine;
    if (!socket.connected || !socket.active || engine.readyState !== 'open') {
      throw new Error('Departure delivery fixture requires a live Socket and Engine');
    }
    const originalDisconnect = socket.disconnect;
    const originalPacket = socket.packet;
    const originalClose = engine.close;
    const events = { namespaceDisconnectDropped: 0, engineCloseDropped: 0, disconnect: 0, managerClose: 0, engineClose: 0, reconnectAttempt: 0 };
    let clientDisconnect = false;
    socket.on('disconnect', reason => { events.disconnect += 1; clientDisconnect = reason === 'io client disconnect'; });
    manager.on('close', () => { events.managerClose += 1; });
    manager.on('reconnect_attempt', () => { events.reconnectAttempt += 1; });
    engine.on('close', () => { events.engineClose += 1; });
    window.__departureDeliverySnapshot = () => ({
      ...events, clientDisconnect, connected: socket.connected, active: socket.active,
      socketIdCleared: socket.id === undefined, engineReadyState: engine.readyState,
      sameEngine: manager.engine === engine, managerClosed: manager._readyState === 'closed',
      skipReconnect: manager.skipReconnect, disconnectUnchanged: socket.disconnect === originalDisconnect,
      packetRestored: socket.packet === originalPacket, engineCloseRestored: engine.close === originalClose,
    });
    // Socket.IO client-dist: disconnect -> packet(DISCONNECT=1) -> destroy ->
    // Manager.onclose -> engine.close, then the Socket's local onclose still runs.
    socket.packet = function (packet, ...args) {
      if (packet.type !== 1) return Reflect.apply(originalPacket, this, [packet, ...args]);
      this.packet = originalPacket;
      events.namespaceDisconnectDropped += 1;
    };
    engine.close = function () {
      this.close = originalClose;
      events.engineCloseDropped += 1;
      return this;
    };
    try {
      dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    } finally {
      socket.packet = originalPacket;
      engine.close = originalClose;
    }
    return window.__departureDeliverySnapshot();
  });
}

async function exerciseDepartedSessionRelease(context, owner, roomName, { ageMs, failFirstNewRelease = false, expired = false }) {
  const original = await identity(owner, roomName);
  let releases = 0;
  let ticket;
  let replaying = false;
  const attempts = [];
  const releaseRoute = async route => {
    releases += 1;
    if (releases === 1) return route.abort('failed');
    if (!replaying) {
      const body = route.request().postDataJSON();
      const ticketPresent = await route.request().frame().page().evaluate(room => Boolean(
        sessionStorage.getItem('together-see:departed-session:' + room)
      ), roomName);
      attempts.push({
        ticketPresent,
        payloadMatchesTicket: body.roomCode === roomName && body.memberId === ticket.memberId
          && body.socketId === ticket.socketId && body.reconnectToken === ticket.reconnectToken,
      });
    }
    return failFirstNewRelease && releases === 2 ? route.abort('failed') : route.continue();
  };
  await context.route('**/api/session-release', releaseRoute);
  try {
    // Lose only close delivery: normal disconnect must synchronously detach the
    // local Socket while the server still owns its live Engine/namespace session.
    const immediate = await dropFirstDepartureCloseDelivery(owner);
    console.log('departed-session-local-disconnect', immediate);
    expect(immediate).toEqual({
      namespaceDisconnectDropped: 1, engineCloseDropped: 1,
      disconnect: 1, managerClose: 1, engineClose: 0, reconnectAttempt: 0,
      clientDisconnect: true, connected: false, active: false, socketIdCleared: true,
      engineReadyState: 'open', sameEngine: true, managerClosed: true, skipReconnect: true,
      disconnectUnchanged: true, packetRestored: true, engineCloseRestored: true,
    });
    await expect.poll(() => releases).toBe(1);
    // No departed ticket is copied to this independent page. A real rejected
    // join proves local disconnect did not already free the server-side slot.
    const occupancyProbe = await overlappingPage(context, owner, roomName, original, true);
    try {
      await expect(occupancyProbe.locator('body')).toHaveAttribute('data-room-access', 'session_wait');
      await expect.poll(() => occupancyProbe.evaluate(() => window.__sessionNavigation.errors.includes('member_online_elsewhere'))).toBe(true);
      expect(await occupancyProbe.evaluate(id => window.__sessionNavigation.joins.length > 0
        && window.__sessionNavigation.joins.every(join => join.memberId === id && join.hasAdmin && join.hasReconnect), original.memberId)).toBe(true);
      expect(await occupancyProbe.evaluate(() => window.__sessionNavigation.recoveries)).toBe(0);
      expect(await identity(occupancyProbe, roomName)).toEqual(original);
      expect(releases).toBe(1);
      expect(await owner.evaluate(() => window.__departureDeliverySnapshot())).toEqual(immediate);
      console.log('departed-session-pre-release-occupancy', { rejectedAsOnline: true, releaseCalls: releases });
    } finally { await occupancyProbe.close(); }
    const session = await owner.evaluate(() => ({ ...sessionStorage }));
    ticket = JSON.parse(session['together-see:departed-session:' + roomName]);
    expect(ticket.memberId).toBe(original.memberId);
    const next = await context.newPage();
    const responseStatuses = [];
    next.on('response', response => {
      if (new URL(response.url()).pathname === '/api/session-release') responseStatuses.push(response.status());
    });
    await next.addInitScript(({ values, room, age }) => {
      for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, value);
      const key = 'together-see:departed-session:' + room;
      const record = JSON.parse(sessionStorage.getItem(key));
      // Age only the client ticket; retain the real server-issued identity/secrets.
      record.createdAt = Date.now() - age;
      sessionStorage.setItem(key, JSON.stringify(record));
    }, { values: session, room: roomName, age: ageMs });
    await next.goto(owner.url());

    if (expired) {
      await expect(next.locator('body')).toHaveAttribute('data-room-access', 'session_wait');
      await expect(next.locator('body')).toHaveAttribute('data-room-access', 'session_conflict', { timeout: 15000 });
      await expect(next.locator('[data-room-access-submit]')).toBeVisible();
      const probe = await next.evaluate(id => ({
        joins: window.__sessionNavigation.joins.length,
        sameIdentityAndCredentials: window.__sessionNavigation.joins.every(join => join.memberId === id && join.hasAdmin && join.hasReconnect),
        onlineConflict: window.__sessionNavigation.errors.includes('member_online_elsewhere'),
        recoveries: window.__sessionNavigation.recoveries,
        noAdmission: window.__sessionNavigation.permissions === null && window.__sessionNavigation.members.length === 0,
      }), original.memberId);
      expect(probe).toMatchObject({ sameIdentityAndCredentials: true, onlineConflict: true, recoveries: 0, noAdmission: true });
      expect(probe.joins).toBeGreaterThan(1);
      expect(probe.joins).toBeLessThanOrEqual(7);
      expect(await identity(next, roomName)).toEqual(original);
      expect(await next.evaluate(room => sessionStorage.getItem('together-see:departed-session:' + room), roomName)).toBeNull();
      await next.waitForTimeout(1600);
      await expect(next.locator('body')).toHaveAttribute('data-room-access', 'session_conflict');
      expect(await next.evaluate(() => window.__sessionNavigation.joins.length)).toBe(probe.joins);
      expect(await next.evaluate(() => window.__sessionNavigation.recoveries)).toBe(0);
      expect(releases).toBe(1);
      expect(attempts).toEqual([]);
      expect(responseStatuses).toEqual([]);
      expect(await owner.evaluate(() => window.__departureDeliverySnapshot())).toEqual(immediate);
      console.log('departed-session-expired-ticket', { ageMs, releaseCalls: releases, conflict: true, noAdmission: true });
      return next;
    }

    await expectSingleCreator(next, original, roomName);
    await expect.poll(() => identity(next, roomName).then(value => value.reconnect !== original.reconnect)).toBe(true);
    const expectedReleases = failFirstNewRelease ? 3 : 2;
    expect(releases).toBe(expectedReleases);
    expect(attempts).toEqual(Array.from({ length: expectedReleases - 1 }, () => ({ ticketPresent: true, payloadMatchesTicket: true })));
    expect(responseStatuses).toEqual([204]);
    expect(await next.evaluate(() => window.__sessionNavigation.recoveries)).toBe(0);
    expect(await next.evaluate(room => sessionStorage.getItem('together-see:departed-session:' + room), roomName)).toBeNull();
    try {
      // This checks local lifecycle state, not receipt of a server close packet.
      await expect.poll(() => owner.evaluate(() => window.__sessionNavigation.socket.connected), { timeout: 5000 }).toBe(false);
    } finally {
      console.log('departed-session-delivery', await owner.evaluate(() => window.__departureDeliverySnapshot()));
    }
    const replacementSocket = await next.evaluate(() => window.__sessionNavigation.socket.id);
    const replacementIdentity = await identity(next, roomName);
    // A delayed duplicate cannot disconnect the now-rotated replacement session.
    replaying = true;
    const status = await next.evaluate(async ({ roomCode, ticket }) => (await fetch('/api/session-release', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomCode, memberId: ticket.memberId, socketId: ticket.socketId, reconnectToken: ticket.reconnectToken }),
    })).status, { roomCode: roomName, ticket });
    expect(status).toBe(204);
    await next.waitForTimeout(1000);
    expect(await next.evaluate(() => window.__sessionNavigation.socket.id)).toBe(replacementSocket);
    await expectSingleCreator(next, original, roomName);
    expect(await identity(next, roomName)).toEqual(replacementIdentity);
    expect(releases).toBe(expectedReleases + 1);
    expect(responseStatuses).toEqual([204, 204]);
    console.log('departed-session-release-regression', {
      ageMs, failedFirstNewRelease: failFirstNewRelease,
      releaseCallsBeforeReplay: expectedReleases, releaseCallsAfterReplay: releases,
      ticketRetainedUntilDelivery: attempts.every(attempt => attempt.ticketPresent),
      payloadsMatchOldTicket: attempts.every(attempt => attempt.payloadMatchesTicket),
      lateReplayPreservedReplacement: true,
    });
    await owner.close();
    return next;
  } finally { await context.unroute('**/api/session-release', releaseRoute); }
}

test('departed-tab ticket releases a live old Socket when first close and keepalive delivery are lost', async ({ browser, baseURL }) => {
  const initial = await createOwner(browser, baseURL);
  let owner = initial.owner;
  // Reuse one room across explicit cases to avoid consuming production room slots.
  const scenarios = [
    { title: '45-second ticket restores the same creator after lost close delivery', ageMs: 45000 },
    { title: 'transient successor release failure retries once, then stops after HTTP 204', ageMs: 45000, failFirstNewRelease: true },
    { title: 'ticket older than 120 seconds is discarded without release, admission or recovery', ageMs: 120001, expired: true },
  ];
  try {
    for (const scenario of scenarios) {
      owner = await test.step(scenario.title, () => exerciseDepartedSessionRelease(initial.context, owner, initial.roomName, scenario));
    }
  } finally { await initial.context.close(); }
});

test('release retry contract retains failed tickets until explicit same-identity retry succeeds', async ({ browser, baseURL }) => {
  const localTarget = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname);
  test.skip(!localTarget && process.env.TOGETHER_SEE_LIVE_SESSION_TESTS !== '1', 'Remote failure injection requires explicit acceptance opt-in');
  const initial = await createOwner(browser, baseURL);
  let owner = initial.owner;
  try {
    for (const permanent of [false, true]) {
      await test.step(permanent ? 'permanent 403 does not retry automatically' : 'timeout, network failure and 503 exhaust exactly three attempts', async () => {
        const original = await identity(owner, initial.roomName);
        const roomName = initial.roomName;
        let releases = 0;
        let ticket;
        let heldRoute;
        let manualReleaseAllowed = false;
        const payloadMatches = [];
        const actions = [];
        const routeRelease = async route => {
          releases += 1;
          if (releases === 1) {
            actions.push('pagehide-abort');
            return route.abort('failed');
          }
          const body = route.request().postDataJSON();
          payloadMatches.push(body.roomCode === roomName && body.memberId === ticket.memberId
            && body.socketId === ticket.socketId && body.reconnectToken === ticket.reconnectToken);
          if (manualReleaseAllowed) {
            actions.push('server');
            return route.continue();
          }
          if (permanent) {
            actions.push('403');
            return route.fulfill({ status: 403, body: '' });
          }
          if (releases === 2) {
            // Never forward this request. Only the client's own timeout can
            // settle fetch and start the next attempt while this route is held.
            actions.push('held-timeout');
            heldRoute = route;
            return;
          }
          if (releases === 3) {
            actions.push('network-abort');
            await heldRoute.abort('failed');
            heldRoute = null;
            return route.abort('failed');
          }
          actions.push('503');
          return route.fulfill({ status: 503, body: '' });
        };
        await initial.context.route('**/api/session-release', routeRelease);
        try {
          const immediate = await dropFirstDepartureCloseDelivery(owner);
          expect(immediate).toMatchObject({
            namespaceDisconnectDropped: 1, engineCloseDropped: 1, connected: false, active: false,
            engineReadyState: 'open', engineClose: 0, disconnectUnchanged: true,
            packetRestored: true, engineCloseRestored: true,
          });
          await expect.poll(() => releases).toBe(1);
          const session = await owner.evaluate(() => ({ ...sessionStorage }));
          const storedTicket = session['together-see:departed-session:' + roomName];
          ticket = JSON.parse(storedTicket);
          const next = await initial.context.newPage();
          await next.addInitScript(values => {
            for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, value);
            const nativeFetch = window.fetch;
            const probe = window.__releaseFetchProbe = { settled: [], inFlight: 0, maxInFlight: 0 };
            // Observe real fetch results/signals; do not synthesize success or auth.
            window.fetch = async function (input, init) {
              if (input !== '/api/session-release') return Reflect.apply(nativeFetch, this, [input, init]);
              const started = performance.now();
              probe.inFlight += 1;
              probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight);
              try {
                const response = await Reflect.apply(nativeFetch, this, [input, init]);
                probe.settled.push({ status: response.status, failed: false, aborted: Boolean(init?.signal?.aborted), elapsedMs: performance.now() - started });
                return response;
              } catch (error) {
                probe.settled.push({ status: null, failed: true, aborted: Boolean(init?.signal?.aborted), elapsedMs: performance.now() - started });
                throw error;
              } finally { probe.inFlight -= 1; }
            };
          }, session);
          await next.goto(owner.url());
          const expectedBeforeManual = permanent ? 2 : 4;
          await expect.poll(() => releases).toBe(expectedBeforeManual);
          await expect(next.locator('body')).toHaveAttribute('data-room-access', 'session_conflict', { timeout: 20000 });
          const before = await next.evaluate(id => ({
            joins: window.__sessionNavigation.joins.length,
            sameIdentityAndCredentials: window.__sessionNavigation.joins.every(join => join.memberId === id && join.hasAdmin && join.hasReconnect),
            onlineConflict: window.__sessionNavigation.errors.includes('member_online_elsewhere'),
            noAdmission: window.__sessionNavigation.permissions === null && window.__sessionNavigation.members.length === 0,
            recoveries: window.__sessionNavigation.recoveries,
            fetch: window.__releaseFetchProbe,
          }), original.memberId);
          expect(before).toMatchObject({ sameIdentityAndCredentials: true, onlineConflict: true, noAdmission: true, recoveries: 0 });
          expect(before.joins).toBeGreaterThan(1);
          expect(before.joins).toBeLessThanOrEqual(7);
          expect(before.fetch).toMatchObject({ inFlight: 0, maxInFlight: 1 });
          expect(before.fetch.settled.map(({ status, failed, aborted }) => ({ status, failed, aborted }))).toEqual(permanent
            ? [{ status: 403, failed: false, aborted: false }]
            : [{ status: null, failed: true, aborted: true }, { status: null, failed: true, aborted: false }, { status: 503, failed: false, aborted: false }]);
          if (!permanent) expect(before.fetch.settled[0].elapsedMs).toBeGreaterThanOrEqual(2800);
          expect(await identity(next, roomName)).toEqual(original);
          const ticketUnchanged = () => next.evaluate(({ room, stored }) => sessionStorage.getItem('together-see:departed-session:' + room) === stored,
            { room: roomName, stored: storedTicket });
          expect(await ticketUnchanged()).toBe(true);
          // Beyond the 3s timeout and both backoffs: there must be no automatic
          // fourth successor attempt, even after the conflict UI has settled.
          await next.waitForTimeout(4500);
          expect(releases).toBe(expectedBeforeManual);
          expect(await next.evaluate(() => window.__releaseFetchProbe.settled.length)).toBe(expectedBeforeManual - 1);
          expect(await next.evaluate(() => window.__sessionNavigation.joins.length)).toBe(before.joins);
          expect(await next.evaluate(() => window.__sessionNavigation.recoveries)).toBe(0);
          await expect(next.locator('body')).toHaveAttribute('data-room-access', 'session_conflict');
          expect(await ticketUnchanged()).toBe(true);
          expect(await owner.evaluate(() => window.__departureDeliverySnapshot())).toEqual(immediate);

          manualReleaseAllowed = true;
          await next.locator('[data-room-access-submit]').click();
          await expectSingleCreator(next, original, roomName);
          await expect.poll(() => identity(next, roomName).then(value => value.reconnect !== original.reconnect)).toBe(true);
          expect(await next.evaluate(room => sessionStorage.getItem('together-see:departed-session:' + room), roomName)).toBeNull();
          await next.waitForTimeout(1000);
          expect(releases).toBe(expectedBeforeManual + 1);
          expect(actions).toEqual(permanent ? ['pagehide-abort', '403', 'server']
            : ['pagehide-abort', 'held-timeout', 'network-abort', '503', 'server']);
          expect(payloadMatches).toEqual(Array(expectedBeforeManual).fill(true));
          const after = await next.evaluate(() => window.__releaseFetchProbe);
          expect(after).toMatchObject({ inFlight: 0, maxInFlight: 1 });
          expect(after.settled).toHaveLength(expectedBeforeManual);
          expect(after.settled.at(-1)).toMatchObject({ status: 204, failed: false, aborted: false });
          expect(await next.evaluate(() => window.__sessionNavigation.recoveries)).toBe(0);
          console.log('departed-session-local-retry-contract', {
            permanent403: permanent, releaseCallsBeforeManual: expectedBeforeManual, releaseCallsAfterManual: releases,
            timeoutElapsedMs: permanent ? null : Math.round(before.fetch.settled[0].elapsedMs),
            quietWindowMs: 4500, ticketPreservedAfterFailures: true, manual204ClearedTicket: true, sameCreator: true,
          });
          await owner.close();
          owner = next;
        } finally {
          if (heldRoute) await heldRoute.abort('failed');
          await initial.context.unroute('**/api/session-release', routeRelease);
        }
      });
    }
  } finally { await initial.context.close(); }
});

test('suspended page blocks transport-level automatic reconnect after one dropped departure disconnect', async ({ browser, baseURL }) => {
  const { context, owner } = await createOwner(browser, baseURL);
  try {
    await context.route('**/api/session-release', route => route.abort('failed'));
    // Closing a polling transport while upgrade pauses it is a no-op. Require
    // the actual live WebSocket before injecting this transport failure.
    await expect.poll(() => owner.evaluate(() => {
      const engine = window.__sessionNavigation.socket.io.engine;
      return engine.readyState === 'open' && !engine.upgrading && engine.transport.name === 'websocket'
        && engine.transport.readyState === 'open' && engine.transport.ws.readyState === WebSocket.OPEN;
    })).toBe(true);
    const joins = await dropFirstDepartureDisconnect(owner);
    expect(await owner.evaluate(() => window.__sessionNavigation.socket.connected)).toBe(true);
    try {
      await owner.evaluate(() => {
        const engine = window.__sessionNavigation.socket.io.engine;
        const transport = engine.transport;
        if (engine.readyState !== 'open' || engine.upgrading || transport.name !== 'websocket'
          || transport.readyState !== 'open' || transport.ws.readyState !== WebSocket.OPEN) {
          throw new Error('Transport failure fixture requires an established WebSocket');
        }
        transport.ws.close();
      });
      await expect.poll(() => owner.evaluate(() => window.__departureSnapshot().engineClose)).toBeGreaterThanOrEqual(1);
      await expect.poll(() => owner.evaluate(() => window.__departureSnapshot()), { timeout: 10000 }).toMatchObject({
        dropped: 1, guardedDisconnect: 1, connected: false, active: false,
      });
      const result = await owner.evaluate(() => window.__departureSnapshot());
      expect(result.reconnectAttempt).toBeGreaterThanOrEqual(1);
      expect(result.managerClose).toBeGreaterThanOrEqual(1);
      expect(result.engineClose).toBeGreaterThanOrEqual(1);
      expect(await owner.evaluate(() => window.__sessionNavigation.joins.length)).toBe(joins);
      await owner.waitForTimeout(1500);
      expect(await owner.evaluate(() => window.__departureSnapshot().reconnectAttempt)).toBe(result.reconnectAttempt);
      expect(await owner.evaluate(() => window.__sessionNavigation.socket.io.skipReconnect)).toBe(true);
    } finally {
      console.log('suspended-transport-delivery', await owner.evaluate(() => window.__departureSnapshot()));
    }
  } finally { await context.close(); }
});

test('independent page without secrets cannot steal an identity or silently become a new member', async ({ browser, baseURL }) => {
  test.setTimeout(45000);
  const { context, owner, roomName, original } = await createOwner(browser, baseURL);
  try {
    const next = await overlappingPage(context, owner, roomName, original, false);
    await expect(next.locator('body')).toHaveAttribute('data-room-access', 'session_wait');
    await expect(next.locator('body')).toHaveAttribute('data-room-access', 'session_conflict', { timeout: 15000 });
    await expect(next.locator('[data-room-access-submit]')).toBeVisible();
    await expect(next.locator('[data-room-password-message]')).toContainText('12');
    const count = await next.evaluate(() => window.__sessionNavigation.joins.length);
    expect(count).toBeLessThanOrEqual(7);
    expect(count).toBeGreaterThan(1);
    await next.waitForTimeout(1600);
    expect(await next.evaluate(() => window.__sessionNavigation.joins.length)).toBe(count);
    expect(await next.evaluate(() => window.__sessionNavigation.recoveries)).toBe(0);
    expect(await next.evaluate(id => window.__sessionNavigation.joins.every(join => join.memberId === id && !join.hasAdmin && !join.hasReconnect), original.memberId)).toBe(true);
    const unchanged = await identity(next, roomName);
    expect(unchanged.memberId).toBe(original.memberId);
    expect(unchanged.admin).toBeNull();
    expect(unchanged.reconnect).toBeNull();
    expect(unchanged.recovery).toBe(original.recovery);
    await expectSingleCreator(owner, original, roomName);
    // Explicit recovery uses the real server and original code, not injected events.
    const recover = () => next.evaluate(({ room, value }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Recovery acknowledgement timed out')), 5000);
      window.__sessionNavigation.socket.emit('recover_admin_token', {
        roomCode: room, memberId: value.memberId, recoveryCode: value.recovery,
      }, result => { clearTimeout(timer); resolve(result); });
    }), { room: roomName, value: { memberId: original.memberId, recovery: original.recovery } });
    expect((await recover()).ok).toBe(false);
    await owner.close();
    await expect.poll(async () => (await recover()).ok, { timeout: 5000 }).toBe(true);
    await waitForRoomAccess(next);
    await expect.poll(() => next.evaluate(() => window.__sessionNavigation.members)).toEqual([original.memberId]);
    await expect.poll(() => next.evaluate(() => window.__sessionNavigation.permissions)).toMatchObject({ canManage: true, isCreator: true });
    expect((await identity(next, roomName)).memberId).toBe(original.memberId);
  } finally { await context.close(); }
});

test('restored ordinary member reads the token rotated by an intervening same-tab document', async ({ browser, baseURL }) => {
  const { context, roomName } = await createOwner(browser, baseURL);
  const guestContext = await browser.newContext();
  try {
    const source = await fs.readFile(new URL('../../assets/js/room.js', import.meta.url), 'utf8');
    await guestContext.route('**/assets/js/room.js*', route => route.fulfill({ contentType: 'application/javascript', body: socketObserver + source }));
    const guest = await guestContext.newPage();
    await joinRoomFromHome(guest, baseURL, { roomName, nickname: 'Restored Guest' });
    await expect.poll(() => identity(guest, roomName).then(value => !!value.reconnect)).toBe(true);
    const first = await identity(guest, roomName);
    expect(first.admin).toBeNull();
    await guest.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    const session = await guest.evaluate(() => ({ ...sessionStorage }));
    const intermediate = await guestContext.newPage();
    await intermediate.addInitScript(values => {
      for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, value);
    }, session);
    await intermediate.goto(guest.url());
    await waitForRoomAccess(intermediate);
    await expect.poll(() => identity(intermediate, roomName).then(value => value.reconnect !== first.reconnect)).toBe(true);
    const second = await identity(intermediate, roomName);
    expect(second.memberId).toBe(first.memberId);
    await intermediate.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    // Model a shared tab storage area across cached documents without claiming
    // that Chromium actually selected BFCache for these two test pages.
    const rotated = await intermediate.evaluate(() => ({ ...sessionStorage }));
    await guest.evaluate(values => {
      sessionStorage.clear();
      for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, value);
      dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    }, rotated);
    await waitForRoomAccess(guest);
    await expect.poll(() => identity(guest, roomName).then(value => value.reconnect !== second.reconnect)).toBe(true);
    expect((await identity(guest, roomName)).memberId).toBe(first.memberId);
    const probe = await guest.evaluate(() => ({ members: window.__sessionNavigation.members, errors: window.__sessionNavigation.errors, permissions: window.__sessionNavigation.permissions }));
    expect(probe.members).toHaveLength(2);
    expect(probe.errors).not.toContain('reconnect_token_invalid');
    expect(probe.permissions.canManage).toBe(false);
  } finally { await guestContext.close(); await context.close(); }
});

test('pagehide/pageshow lifecycle suspends access and restores the same creator with a rotated reconnect token', async ({ browser, baseURL }) => {
  const { context, owner, roomName, original } = await createOwner(browser, baseURL);
  try {
    const url = new URL(owner.url());
    url.searchParams.delete('created');
    url.searchParams.set('navigation', 'lifecycle');
    await owner.goto(url.href);
    await expectSingleCreator(owner, original, roomName);
    await openRoomTab(owner, 'members');
    await owner.locator('[data-room-security-panel] summary').click();
    await expect(owner.locator('[data-room-password-input]')).toBeEnabled();
    const beforeSuspend = await identity(owner, roomName);
    // Synthetic persisted lifecycle events exercise a real browser/Socket without
    // claiming that this runner actually enabled or entered the browser BFCache.
    await owner.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    expect(await owner.evaluate(() => window.__sessionNavigation.socket.connected)).toBe(false);
    await expect(owner.locator('body')).toHaveAttribute('data-room-access', 'checking');
    await expect(owner.locator('.room-main')).toHaveAttribute('inert', '');
    expect(await identity(owner, roomName)).toEqual(beforeSuspend);
    const joins = await owner.evaluate(() => window.__sessionNavigation.joins.length);
    await owner.waitForTimeout(1000);
    expect(await owner.evaluate(() => window.__sessionNavigation.joins.length)).toBe(joins);
    await owner.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expectSingleCreator(owner, original, roomName);
    await expect.poll(() => identity(owner, roomName).then(value => value.reconnect !== beforeSuspend.reconnect)).toBe(true);
    await expect.poll(() => owner.evaluate(() => window.__sessionNavigation.joins.length)).toBeGreaterThan(joins);
    await expect(owner.locator('[data-room-password-input]')).toBeEnabled();
    expect(await owner.evaluate(() => window.__sessionNavigation.recoveries)).toBe(0);
  } finally { await context.close(); }
});
