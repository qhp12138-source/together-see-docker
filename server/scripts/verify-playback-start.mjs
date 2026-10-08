import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../../assets/js/recovery.js', import.meta.url), 'utf8');
const context = vm.createContext({ setTimeout, clearTimeout });
vm.runInContext(source, context);
const { createPlaybackStartController } = context.TogetherSeeRecovery;
const tick = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

function harness(play) {
  let sequence = 0;
  const timers = new Map();
  const blocked = [];
  const controller = createPlaybackStartController({
    setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const input = { identity: 'source-a/load-1/play-1', isCurrent: () => true, play, onBlocked: reason => blocked.push(reason) };
  return {
    controller, input, timers, blocked,
    async retry() {
      assert.equal(timers.size, 1, 'only one retry may be scheduled');
      const [id, timer] = timers.entries().next().value;
      timers.delete(id); timer.fn(); await tick(); return timer.ms;
    },
  };
}

let calls = 0;
const abort = () => Promise.reject(Object.assign(new Error('load interrupted'), { name: 'AbortError' }));
const transient = harness(() => ++calls === 1 ? abort() : Promise.resolve());
const first = transient.controller.request(transient.input);
const duplicate = transient.controller.request(transient.input);
assert.equal(first, duplicate, 'equivalent canplay/periodic requests share one in-flight play');
await tick();
assert.equal(calls, 1);
assert.equal(await transient.retry(), 400);
assert.equal(await first, true);
assert.equal(calls, 2);
assert.deepEqual(transient.blocked, [], 'AbortError is not an autoplay-policy rejection');

calls = 0;
const repeated = harness(() => { calls += 1; return abort(); });
const exhausted = repeated.controller.request(repeated.input);
await tick();
for (const delay of [400, 1000, 2000]) assert.equal(await repeated.retry(), delay);
assert.equal(await exhausted, false);
for (let i = 0; i < 20; i += 1) await repeated.controller.request(repeated.input);
assert.equal(calls, 4, 'periodic broadcasts must not renew the exhausted retry budget');
assert.deepEqual(repeated.blocked, ['interrupted']);

calls = 0;
const denied = harness(() => { calls += 1; return Promise.reject({ name: 'NotAllowedError' }); });
assert.equal(await denied.controller.request(denied.input), false);
assert.equal(denied.timers.size, 0);
assert.deepEqual(denied.blocked, ['gesture']);
await denied.controller.request(denied.input);
assert.equal(calls, 1, 'a policy rejection must wait for a real gesture');
denied.controller.suspend();
await denied.controller.request(denied.input);
assert.equal(calls, 1, 'a buffering round-trip must preserve the gesture block');
denied.controller.reset();
assert.equal(await denied.controller.request({ ...denied.input, play: () => Promise.resolve() }), true);

const unsupported = harness(() => Promise.reject({ name: 'NotSupportedError' }));
assert.equal(await unsupported.controller.request(unsupported.input), false);
assert.deepEqual(unsupported.blocked, ['failed']);
assert.equal(unsupported.timers.size, 0);

let resolveOld;
let successCount = 0;
const stale = harness(() => new Promise(resolve => { resolveOld = resolve; }));
const old = stale.controller.request({ ...stale.input, onSuccess: () => { successCount += 1; } });
stale.controller.reset();
assert.equal(await old, false, 'pause/source change cancels the logical request immediately');
const next = stale.controller.request({ ...stale.input, identity: 'source-b/load-2', play: () => Promise.resolve() });
assert.equal(await next, true);
resolveOld(); await tick();
assert.equal(successCount, 0, 'a late old-source promise must not update the new player');

const cancelled = harness(abort);
const pending = cancelled.controller.request(cancelled.input);
await tick();
cancelled.input.isCurrent = () => false;
await cancelled.retry();
assert.equal(await pending, false);
assert.equal(cancelled.timers.size, 0, 'pause/buffering/off cancels scheduled recovery');

let interruptedCalls = 0;
const budget = harness(() => { interruptedCalls += 1; return abort(); });
for (let i = 0; i < 5; i += 1) {
  budget.controller.request(budget.input);
  await tick();
  budget.controller.suspend();
}
assert.equal(interruptedCalls, 4, 'buffering must not renew the transient retry budget');

console.log('Playback start recovery: 9 behavioral scenarios passed');

const { createForegroundFrameRecovery } = context.TogetherSeeRecovery;
function frameHarness() {
  const controller = createForegroundFrameRecovery();
  controller.reset('media-a');
  controller.arm(0);
  return { controller, sample: (now, patch = {}) => controller.sample({
    now, time: now / 1000, frames: 10, eligible: true, ...patch,
  }) };
}
const frame = frameHarness();
for (let now = 0; now < 4500; now += 500) assert.equal(frame.sample(now), null);
assert.equal(frame.sample(4500), 'nudge');
for (let now = 5000; now < 9500; now += 500) assert.equal(frame.sample(now), null);
assert.equal(frame.sample(9500), 'reload');
frame.controller.arm(10000);
for (let now = 10000; now < 40000; now += 500) assert.equal(frame.sample(now), null, 'visibility changes do not renew recovery budget');
frame.controller.reset('media-b');
frame.controller.arm(40000);
for (let now = 40000; now < 44500; now += 500) assert.equal(frame.sample(now), null);
assert.equal(frame.sample(44500), 'nudge', 'a new source has its own bounded budget');

for (const scenario of ['healthy', 'paused-or-buffering', 'audio-clock-stopped', 'hidden', 'timer-throttled', 'seek']) {
  const h = frameHarness();
  if (scenario === 'hidden') h.controller.suspend();
  for (let now = 0; now <= 30000; now += scenario === 'timer-throttled' ? 3000 : 500) {
    const patch = scenario === 'healthy' ? { frames: now / 40 }
      : scenario === 'paused-or-buffering' ? { eligible: false }
      : scenario === 'audio-clock-stopped' ? { time: 2 }
      : scenario === 'seek' ? { time: now / 100 } : {};
    assert.equal(h.sample(now, patch), null, scenario);
  }
}
const terminalTracker = context.TogetherSeeRecovery.createLoadTracker();
const terminalToken = terminalTracker.begin('frame');
assert.equal(terminalTracker.isTerminal(terminalToken), false);
terminalTracker.markTerminal(terminalToken);
assert.equal(terminalTracker.isTerminal(terminalToken), true);
terminalTracker.begin('next');
assert.equal(terminalTracker.isTerminal(terminalToken), false);
console.log('Foreground frame recovery: bounded escalation and 6 non-failure guards passed');

const { getContiguousBufferAhead, resumeHlsBuffering, createCatchUpRateGuard } = context.TogetherSeeRecovery;
const ranges = pairs => ({ length: pairs.length, start: i => pairs[i][0], end: i => pairs[i][1] });
assert.equal(getContiguousBufferAhead(ranges([[0, 5], [20, 40]]), 10), 0, 'a future range is not playable buffer');
assert.equal(getContiguousBufferAhead(ranges([[0, 5], [20, 40]]), 4), 1, 'do not bridge a real buffer hole');
assert.equal(getContiguousBufferAhead(ranges([[0, 5], [5.02, 10]]), 4), 6, 'merge only rounding-sized gaps');
assert.equal(getContiguousBufferAhead(ranges([[20, 40]]), 19.8), 0, 'do not count an unbuffered lead-in');
assert.equal(getContiguousBufferAhead(ranges([[20, 40]]), 19.98), 20.02);
assert.equal(getContiguousBufferAhead(ranges([[0, 5]]), 5), 0);
assert.equal(getContiguousBufferAhead(ranges([]), 1), 0);
assert.equal(getContiguousBufferAhead(ranges([[0, 5]]), NaN), 0);
assert.equal(getContiguousBufferAhead({ length: 1, start() { throw new Error('detached'); } }, 1), 0);

let resumes = 0;
const activeLoader = {
  loadingEnabled: true, bufferingEnabled: true,
  startLoad() { throw new Error('must not abort an in-flight fragment'); },
  resumeBuffering() { resumes += 1; this.bufferingEnabled = true; },
};
for (let i = 0; i < 20; i++) assert.equal(resumeHlsBuffering(activeLoader), false);
assert.equal(resumes, 0, 'playing, paused snapshots and pause timers leave active downloads alone');
activeLoader.bufferingEnabled = false;
assert.equal(resumeHlsBuffering(activeLoader), true);
assert.equal(resumes, 1);
assert.equal(resumeHlsBuffering(activeLoader), false);
activeLoader.loadingEnabled = false;
activeLoader.bufferingEnabled = false;
assert.equal(resumeHlsBuffering(activeLoader), false, 'routine refill must not revive a stopped/fatal loader');
assert.equal(resumeHlsBuffering(null), false);
assert.equal(resumeHlsBuffering({ startLoad: activeLoader.startLoad }), false, 'unknown APIs must not fall back to restarting');

const rateGuard = createCatchUpRateGuard();
const chooseRate = patch => rateGuard.select({ requestedRate: 1.5, baseRate: 1.25,
  bufferedAhead: 10, eligible: true, ...patch });
assert.equal(chooseRate({}), 1.5);
assert.equal(chooseRate({ bufferedAhead: 2.9 }), 1.25, 'less than two wall-clock seconds vetoes catch-up');
assert.equal(chooseRate({ bufferedAhead: 4.5 }), 1.25, 'hysteresis prevents rate flapping');
assert.equal(chooseRate({ bufferedAhead: 6 }), 1.5, 'four wall-clock seconds allow a fresh correction');
assert.equal(chooseRate({ eligible: false }), 1.25, 'waiting, pause and seek cancel temporary acceleration');
assert.equal(chooseRate({ bufferedAhead: 5 }), 1.25);
assert.equal(chooseRate({ requestedRate: 1, bufferedAhead: 1 }), 1, 'slowing down does not drain buffer faster');
assert.equal(chooseRate({ requestedRate: 2.5, baseRate: 2, bufferedAhead: 3 }), 2, 'preserve the user base rate, not always 1x');
assert.equal(chooseRate({ requestedRate: 2, baseRate: 2, bufferedAhead: 0 }), 2);
rateGuard.reset();
assert.equal(chooseRate({ bufferedAhead: 4.5 }), 1.5, 'new-source state must not inherit the old low-buffer latch');
console.log('Buffering stability: contiguous ranges, non-destructive refill and catch-up hysteresis passed');

// Exercise the production entry points as well as the policy helpers.
const playerSource = fs.readFileSync(new URL('../../assets/js/player.js', import.meta.url), 'utf8');
const playerTree = ts.createSourceFile('player.js', playerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
assert.equal(playerTree.parseDiagnostics.length, 0);
function extractPlayerFunction(name) {
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(playerTree);
    ts.forEachChild(node, visit);
  }
  visit(playerTree);
  assert.ok(found, `${name} must exist`);
  return found;
}
const rateContext = vm.createContext({
  window: { TogetherSeeRecovery: context.TogetherSeeRecovery },
  currentSource: null, desiredPlaybackState: null, basePlaybackRate: 1.25,
  temporaryPlaybackRate: null, catchUpRateGuard: createCatchUpRateGuard(),
  lastBufferingState: false, mediaRecoveryTransition: false, rateButton: null,
  video: { currentTime: 10, playbackRate: 1.25, buffered: ranges([[0, 30]]),
    paused: false, ended: false, seeking: false, readyState: 4 },
});
for (const name of ['getForwardBufferSeconds', 'getBasePlaybackRate', 'refreshTemporaryPlaybackRate', 'setExternalPlaybackRate']) {
  vm.runInContext(extractPlayerFunction(name), rateContext);
}
rateContext.setExternalPlaybackRate(1.25, { temporary: true });
assert.equal(rateContext.video.playbackRate, 1.25, 'sync initialization without a loaded source must not throw');
rateContext.currentSource = { id: 'rate-source' };
rateContext.setExternalPlaybackRate(1.1);
rateContext.setExternalPlaybackRate(1.5, { temporary: true });
assert.equal(rateContext.video.playbackRate, 1.5);
rateContext.video.buffered = ranges([[0, 12]]);
rateContext.refreshTemporaryPlaybackRate();
assert.equal(rateContext.video.playbackRate, 1.1, 'buffer drain immediately restores the exact non-step base rate');
rateContext.video.buffered = ranges([[0, 30]]);
rateContext.refreshTemporaryPlaybackRate();
assert.equal(rateContext.video.playbackRate, 1.1, 'progress alone must not resurrect a stale rate request');
rateContext.desiredPlaybackState = { activeSourceId: 'rate-source', playbackRate: 2 };
rateContext.video.buffered = ranges([[0, 12]]);
rateContext.setExternalPlaybackRate(2.5, { temporary: true });
assert.equal(rateContext.video.playbackRate, 2, 'an authoritative base rate takes priority over the local preference');
rateContext.video.paused = true;
rateContext.setExternalPlaybackRate(2.5, { temporary: true });
assert.equal(rateContext.video.paused, true);
assert.equal(rateContext.video.playbackRate, 2);
rateContext.desiredPlaybackState.activeSourceId = 'old-source';
assert.equal(rateContext.getBasePlaybackRate(), 1.1, 'old-source snapshots must not supply the new base rate');
console.log('Player rate entry points: initialization, buffer drain, stale requests and pause intent passed');
