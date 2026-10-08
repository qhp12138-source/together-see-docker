import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../../assets/js/room.js', import.meta.url), 'utf8');
const tree = ts.createSourceFile('room.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['cancelPreparedPlaybackStart', 'expirePreparedPlaybackStart', 'maybeStartPreparedPlayback', 'handlePreparedPlaybackUserIntent']);
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) functions.push(node.getText(tree));
  ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(functions.length, names.size);
const tick = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

function createHarness() {
  let clock = 1000;
  let resolvePlay;
  let playCalls = 0;
  const emitted = [];
  const restored = [];
  const desired = [];
  const token = { generation: 1, identity: 'a' };
  const state = {
    Date: { now: () => clock }, Promise,
    window: { clearTimeout() {}, setTimeout() { return 2; } },
    socket: { connected: true }, roomAccessGranted: true,
    sourceIntentGate: { isCurrent: () => true },
    roomState: { playback: { activeSourceId: 'a', revision: 3, playing: false } },
    canControlRoom: () => true, isCurrentPlaybackAuthority: () => true,
    getActivePlayerSourceId: () => 'a', isMediaReadyForSync: () => true,
    setPlaybackStatusText() {},
    player: {
      getLoadToken: () => token, isLoadTokenCurrent: () => true,
      setDesiredPlaybackState: playback => desired.push(playback),
      ensurePlaybackStarted: () => { playCalls += 1; return new Promise(resolve => { resolvePlay = resolve; }); },
    },
    emitPlaybackState: options => { emitted.push(options); return true; },
    applyRemotePlayback: value => restored.push(value),
    preparedPlaybackStart: { context: {}, sourceId: 'a', phase: 'preparing', acceptedRevision: 3, expiresAt: 61000, timer: 1 },
  };
  vm.createContext(state);
  vm.runInContext(functions.join('\n'), state);
  return { state, emitted, restored, desired, playCalls: () => playCalls, clock: n => { clock = n; }, resolve: value => resolvePlay(value) };
}

const readyFirst = createHarness();
readyFirst.state.preparedPlaybackStart.acceptedRevision = null;
readyFirst.state.maybeStartPreparedPlayback();
assert.equal(readyFirst.playCalls(), 0, 'ready alone must not begin playback without source ACK');
readyFirst.state.preparedPlaybackStart.acceptedRevision = 3;
readyFirst.state.maybeStartPreparedPlayback();
readyFirst.state.maybeStartPreparedPlayback();
assert.equal(readyFirst.playCalls(), 1, 'duplicate readiness cannot start another play');
readyFirst.resolve(true); await tick();
assert.equal(readyFirst.emitted.length, 1);
assert.equal(readyFirst.emitted[0].action, 'play');
readyFirst.emitted[0].onAck();
assert.equal(readyFirst.state.preparedPlaybackStart, null);

const ackFirst = createHarness();
ackFirst.state.isMediaReadyForSync = () => false;
ackFirst.state.maybeStartPreparedPlayback();
assert.equal(ackFirst.playCalls(), 0, 'ACK alone must not advance an unloaded source');
ackFirst.state.isMediaReadyForSync = () => true;
ackFirst.state.maybeStartPreparedPlayback({ detail: { generation: 9 } });
assert.equal(ackFirst.playCalls(), 0, 'old generation readiness must be ignored');

const timeout = createHarness();
timeout.state.maybeStartPreparedPlayback();
const pending = timeout.state.preparedPlaybackStart;
timeout.clock(121000);
timeout.state.expirePreparedPlaybackStart(pending);
assert.equal(timeout.state.preparedPlaybackStart, null, 'independent deadline must end a pending play promise');
assert.equal(timeout.restored.length, 1);
timeout.resolve(true); await tick();
assert.equal(timeout.emitted.length, 0, 'late play success after timeout cannot publish');

for (const invalidate of [
  h => { h.clock(121000); },
  h => { h.state.isCurrentPlaybackAuthority = () => false; },
  h => { h.state.socket.connected = false; },
  h => { h.state.roomAccessGranted = false; },
  h => { h.state.roomState.playback.revision = 4; },
  h => { h.state.player.isLoadTokenCurrent = () => false; },
]) {
  const h = createHarness();
  h.state.maybeStartPreparedPlayback(); invalidate(h); h.resolve(true); await tick();
  assert.equal(h.emitted.length, 0, 'completion must recheck deadline, connection, authority, revision and generation');
  assert.equal(h.state.preparedPlaybackStart, null);
  assert.equal(h.restored.length, 1);
}

const manual = createHarness();
manual.state.handlePreparedPlaybackUserIntent({ detail: { action: 'play', stage: 'pending', sourceId: 'a', generation: 1 } });
manual.state.maybeStartPreparedPlayback();
assert.equal(manual.playCalls(), 0, 'source ACK must wait for the user play promise, not issue a competing play');
manual.state.handlePreparedPlaybackUserIntent({ detail: { action: 'play', stage: 'failed', sourceId: 'a', generation: 9 } });
assert.equal(manual.state.preparedPlaybackStart.manualPlayPending, true, 'old generation failure cannot cancel the current gesture');

const failedAfterAck = createHarness();
failedAfterAck.state.preparedPlaybackStart.manualPlayPending = true;
failedAfterAck.state.handlePreparedPlaybackUserIntent({ detail: { action: 'play', stage: 'failed', sourceId: 'a', generation: 1 } });
assert.equal(failedAfterAck.desired.at(-1).playing, false, 'failure must revoke the temporary player recovery intent');
assert.equal(failedAfterAck.state.preparedPlaybackStart, null);
assert.equal(failedAfterAck.playCalls(), 0);

const failedBeforeAck = createHarness();
failedBeforeAck.state.preparedPlaybackStart.acceptedRevision = null;
failedBeforeAck.state.preparedPlaybackStart.manualPlayPending = true;
failedBeforeAck.state.handlePreparedPlaybackUserIntent({ detail: { action: 'play', stage: 'failed', sourceId: 'a', generation: 1 } });
assert.equal(failedBeforeAck.desired.at(-1).playing, false);
assert.equal(failedBeforeAck.state.preparedPlaybackStart.playing, false);
failedBeforeAck.state.preparedPlaybackStart.acceptedRevision = 3;
failedBeforeAck.state.maybeStartPreparedPlayback();
assert.equal(failedBeforeAck.state.preparedPlaybackStart, null);
assert.equal(failedBeforeAck.playCalls(), 0);

console.log('Source preparation: 12 behavioral scenarios passed');
