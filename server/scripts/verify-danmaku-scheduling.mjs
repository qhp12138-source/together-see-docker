import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Use the existing compiler to extract production functions, not a scheduler copy.
// Fake DOM/clock only: no server, browser, downloads or playback/recovery execution.
const source = fs.readFileSync(new URL('../../assets/js/player.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('player.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
assert.equal(ast.parseDiagnostics.length, 0);
const body = ast.statements[0].expression.expression.expression.body;
const scheduler = body.statements.filter((node) => {
  if (ts.isFunctionDeclaration(node)) return /Danmaku|^findTimelineIndex$/.test(node.name.text);
  if (!ts.isVariableStatement(node)) return false;
  return node.declarationList.declarations.every((declaration) =>
    /^(?:danmaku|roomDanmaku|sourceDanmaku|timelineDanmaku|DANMAKU_|ROOM_DANMAKU_|SOURCE_DANMAKU_)/.test(declaration.name.getText(ast)));
}).map((node) => node.getText(ast)).join('\n');
const events = body.statements.filter((node) => {
  if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false;
  const call = node.expression;
  const target = call.expression.getText(ast);
  const event = call.arguments[0]?.text;
  return (target === 'video.addEventListener' && ['seeking', 'seeked'].includes(event))
    || (target === 'document.addEventListener' && event === 'fullscreenchange');
}).map((node) => node.getText(ast)).join('\n');
assert.ok(scheduler.includes('function flushDanmakuQueue('));
assert.equal(events.match(/addEventListener/g)?.length, 3);

function createHarness({ width = 1000, height = 420, random = () => 0, animationLagMs = 0 } = {}) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const frames = new Map();
  const eventHandlers = new Map();
  const history = [];
  function classList(node) {
    return {
      contains: (name) => node.className.split(/\s+/).includes(name),
      add: (...names) => { node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { node.className = node.className.split(/\s+/).filter((name) => !names.includes(name)).join(' '); },
      toggle(name, force) {
        const enabled = force ?? !this.contains(name);
        this[enabled ? 'add' : 'remove'](name);
        return enabled;
      },
    };
  }
  const layer = {
    clientWidth: width, clientHeight: height * 0.34, offsetTop: height * 0.07, children: [],
    appendChild(node) { this.children.push(node); node.parentNode = this; history.push({ node, at: now }); },
    getBoundingClientRect() { return { left: 0, right: this.clientWidth, width: this.clientWidth }; },
    set innerHTML(value) { assert.equal(value, ''); this.children.slice().forEach((node) => node.remove()); },
  };
  const shell = { clientHeight: height, className: 'has-source', classList: null };
  shell.classList = classList(shell);
  const video = { currentTime: 10, paused: false, seeking: false, ended: false,
    addEventListener: (name, callback) => eventHandlers.set(name, callback) };
  const document = {
    fullscreenElement: null,
    querySelector: (selector) => selector === '[data-player-danmaku-layer]' ? layer : null,
    addEventListener: (name, callback) => eventHandlers.set(name, callback),
    createElement() {
      const handlers = new Map();
      const node = {
        className: '', dataset: {}, style: { setProperty(name, value) { this[name] = value; } },
        parentNode: null, textContent: '', createdAt: now,
        getBoundingClientRect() {
          const width = this.textContent.length * 8 + 18;
          const start = parseFloat(this.style['--danmaku-start']);
          const end = parseFloat(this.style['--danmaku-end']);
          const duration = parseFloat(this.style['--danmaku-duration']);
          const progress = Math.min(1, Math.max(0, now - this.createdAt - animationLagMs) / duration);
          const left = Number.isFinite(start) ? start + (end - start) * progress : (layer.clientWidth - width) / 2;
          return { width, left, right: left + width };
        },
        addEventListener: (name, callback) => handlers.set(name, callback),
        emit: (name) => handlers.get(name)?.(),
        remove() {
          if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
          this.parentNode = null;
        },
      };
      node.classList = classList(node);
      return node;
    },
  };
  const window = {
    innerWidth: width,
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + Math.max(0, delay) });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame(callback) { const id = ++nextTimer; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  const context = vm.createContext({
    Math: Object.assign(Object.create(Math), { random }),
    document, window, shell, video, performance: { now: () => now }, fullscreenButton: null,
    setBufferingState() {}, dispatchReadyForSync() {}, showControls() {}, dispatchPlayerEvent() {},
  });
  vm.runInContext(`${scheduler}\n${events}\n globalThis.api = {
    show: showDanmaku, flush: flushDanmakuQueue, clear: clearDanmaku,
    clearSource: clearSourceDanmakuDisplay, setTimeline: setTimelineDanmaku,
    clearTimeline: clearTimelineDanmaku, processTimeline: processTimelineDanmaku,
    count: getDanmakuLaneCount,
    snapshot: () => JSON.stringify({room: roomDanmakuQueue, source: sourceDanmakuQueue,
      lanes: Array.from(danmakuLanes, lane => lane ? {kind: lane.kind, mode: lane.mode, at: lane.availableAt,
        nodes: lane.nodes.map(entry => ({id: entry.node.dataset.danmakuId, endsAt: entry.endsAt, readyAt: entry.readyAt}))} : null)})
  };`, context, { filename: 'production-danmaku-harness.js' });
  const api = context.api;
  return {
    ...api, shell, video, layer, window, timers, history,
    snapshot: () => JSON.parse(api.snapshot()),
    emit: (event) => eventHandlers.get(event)(),
    node: (id) => layer.children.find((node) => node.dataset.danmakuId === id),
    room: (id, extra = {}) => api.show({ id, text: id, kind: 'room', ...extra }),
    source: (id, extra = {}) => api.show({ id, text: id, kind: 'source', time: video.currentTime, ...extra }),
    advance(ms, { media = true } = {}) {
      const end = now + ms;
      let iterations = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        const at = next ? next[1].at : end;
        if (media && !video.paused) video.currentTime += (at - now) / 1000;
        now = at;
        if (!next) break;
        assert.ok(++iterations < 10000, 'Timers must not spin');
        timers.delete(next[0]);
        next[1].callback();
      }
    },
    checkVisualLanes() {
      const occupied = new Map();
      for (const node of layer.children) {
        const lane = Number(node.dataset.danmakuLane);
        if (!occupied.has(lane)) occupied.set(lane, []);
        occupied.get(lane).push(node);
        assert.equal(parseFloat(node.style.top), lane * (window.innerWidth <= 760 ? 28 : 34));
        const bottom = layer.offsetTop + parseFloat(node.style.top) + parseFloat(node.style.lineHeight) + 2;
        assert.ok(bottom <= shell.clientHeight / 3, 'Actual footprint stays inside the upper third');
      }
      for (const nodes of occupied.values()) {
        if (nodes.length < 2) continue;
        const kind = nodes[0].classList.contains('is-room-danmaku');
        for (const node of nodes) {
          assert.equal(node.classList.contains('is-room-danmaku'), kind, 'Only same-kind scroll nodes can follow');
          assert.ok(!node.classList.contains('is-fixed-top') && !node.classList.contains('is-fixed-bottom'), 'Fixed modes are exclusive');
        }
        const positions = nodes.map(node => node.getBoundingClientRect()).sort((a, b) => a.left - b.left);
        for (let i = 1; i < positions.length; i += 1) {
          assert.ok(positions[i].left - positions[i - 1].right >= 28 - 1e-7, 'Scroll followers maintain at least 28px separation');
        }
      }
      assert.ok(layer.children.length <= 80, 'Live DOM nodes remain bounded');
    },
  };
}

let passed = 0;
function test(name, run) { run(); passed += 1; console.log(`PASS ${name}`); }

test('room scroll selects different safe lanes with different random samples', () => {
  const selected = [0, 0.999].map((value) => {
    const h = createHarness({ random: () => value });
    h.room('random-room');
    h.checkVisualLanes();
    return Number(h.node('random-room').dataset.danmakuLane);
  });
  assert.deepEqual(selected, [0, 2]);
});

test('source scroll randomizes eligible lanes without using reserved lane zero', () => {
  const selected = [0, 0.999].map((value) => {
    const h = createHarness({ random: () => value });
    h.source('random-source');
    assert.equal(h.snapshot().lanes[0], null);
    h.checkVisualLanes();
    return Number(h.node('random-source').dataset.danmakuLane);
  });
  assert.deepEqual(selected, [1, 2]);
});

test('random selection excludes occupied lanes and fixed modes keep their order', () => {
  const h = createHarness({ random: () => 0.999 });
  h.room('bottom-busy', { mode: 'bottom' });
  assert.equal(h.node('bottom-busy').dataset.danmakuLane, '2');
  h.source('source-free');
  assert.equal(h.node('source-free').dataset.danmakuLane, '1');
  h.room('top-free', { mode: 'top' });
  assert.equal(h.node('top-free').dataset.danmakuLane, '0');
  h.room('room-preempts-source');
  assert.equal(h.node('room-preempts-source').dataset.danmakuLane, '1');
  assert.ok(h.node('bottom-busy'));
  assert.ok(h.node('top-free'));
  h.checkVisualLanes();
});

test('independent bounded queues: source flood cannot evict room', () => {
  const h = createHarness();
  assert.equal(h.count(), 3);
  for (let i = 0; i < 3; i += 1) h.room(`active-${i}`, { mode: 'top' });
  for (let i = 0; i < 5; i += 1) h.room(`pending-${i}`);
  const room = h.snapshot().room;
  for (let i = 0; i < 1000; i += 1) h.source(`source-${i}`);
  assert.deepEqual(h.snapshot().room, room);
  assert.equal(h.snapshot().source.length, 40);
  assert.equal(h.layer.children.length, 3);
  for (let i = 0; i < 100; i += 1) h.room(`overflow-${i}`);
  assert.equal(h.snapshot().room.length, 40);
  h.checkVisualLanes();
});

test('dense bottom stream reserves a real room track; room preempts only source', () => {
  const h = createHarness();
  for (let i = 0; i < 100; i += 1) h.source(`bottom-${i}`, { mode: 'bottom' });
  assert.equal(h.snapshot().lanes[0], null);
  const oldSource = h.node('bottom-1');
  h.room('live-room');
  assert.equal(h.node('live-room').dataset.danmakuLane, '0');
  h.room('next-room');
  const nextRoom = h.node('next-room');
  assert.ok(nextRoom, 'Room appears immediately even when all tracks were occupied');
  assert.ok(h.node('live-room'));
  oldSource.emit('animationend');
  assert.equal(h.node('next-room'), nextRoom, 'Old source completion cannot free a replacement room lane');
  h.checkVisualLanes();
});

test('all eligible lanes are searched, not just the preferred bottom lane', () => {
  const h = createHarness();
  h.source('bottom-busy', { mode: 'bottom' });
  h.source('top-busy', { mode: 'top' });
  h.node('top-busy').emit('animationend');
  h.source('bottom-next', { mode: 'bottom' });
  assert.equal(h.node('bottom-next').dataset.danmakuLane, '1');
  assert.equal(h.node('bottom-busy').dataset.danmakuLane, '2');
  h.checkVisualLanes();
});

test('single lane: immediate room preemption and queued room priority', () => {
  const h = createHarness({ width: 600, height: 180 });
  assert.equal(h.count(), 1);
  h.source('source', { mode: 'bottom' });
  const stale = h.node('source');
  h.room('room-first', { mode: 'top' });
  h.room('room-next', { mode: 'top' });
  for (let i = 0; i < 50; i += 1) h.source(`source-${i}`);
  stale.emit('animationend');
  assert.ok(h.node('room-first'));
  h.advance(4000);
  assert.ok(h.node('room-next'));
  assert.equal(h.snapshot().source.length, 0);
  assert.equal(h.layer.children.length, 1);
  h.checkVisualLanes();
});

test('wall-clock expired source is dropped, never replayed later', () => {
  const h = createHarness();
  h.source('active-a', { mode: 'top' });
  h.source('active-b', { mode: 'top' });
  h.source('too-late');
  h.advance(501, { media: false });
  assert.equal(h.snapshot().source.length, 0);
  h.advance(4000);
  assert.equal(h.node('too-late'), undefined);
  assert.equal(h.source('old-media-time', { time: h.video.currentTime - 1 }), false);
});

test('media-time drift and pause discard queued source', () => {
  const h = createHarness();
  h.source('active-a', { mode: 'top' });
  h.source('active-b', { mode: 'top' });
  h.source('stale-time');
  h.video.currentTime += 0.6;
  h.flush();
  assert.equal(h.snapshot().source.length, 0);
  h.source('paused-backlog');
  h.video.paused = true;
  h.flush();
  assert.equal(h.snapshot().source.length, 0);
  assert.equal(h.source('paused-new'), false);
});

test('real seeking/seeked callbacks preserve room queue, node and deadline', () => {
  const h = createHarness({ width: 600, height: 180 });
  h.room('room-active', { mode: 'top' });
  h.room('room-waiting');
  h.source('source-waiting');
  const node = h.node('room-active');
  const before = h.snapshot();
  h.video.seeking = true;
  h.video.currentTime = 80;
  h.emit('seeking');
  assert.equal(h.node('room-active'), node);
  assert.deepEqual(h.snapshot().room, before.room);
  assert.deepEqual(h.snapshot().lanes, before.lanes);
  assert.equal(h.snapshot().source.length, 0);
  h.video.seeking = false;
  h.emit('seeked');
  h.advance(4000);
  assert.ok(h.node('room-waiting'));
  h.checkVisualLanes();
});

test('seek removes live source only, preserving actual room occupancy', () => {
  const h = createHarness();
  h.room('room');
  h.source('source-top', { mode: 'top' });
  h.source('source-bottom', { mode: 'bottom' });
  const room = h.node('room');
  h.video.seeking = true;
  h.emit('seeking');
  assert.deepEqual(h.layer.children, [room]);
  assert.equal(h.snapshot().lanes[0].kind, 'room');
  h.room('room-during-seek');
  assert.equal(h.node('room-during-seek').dataset.danmakuLane, '1');
  h.checkVisualLanes();
});

test('source toggles clean up nodes/timers without releasing room ownership', () => {
  const h = createHarness();
  h.room('room', { mode: 'top' });
  const room = h.node('room');
  for (let i = 0; i < 5; i += 1) {
    h.setTimeline([{ id: `timeline-${i}`, text: 'source', time: h.video.currentTime, mode: 'bottom' }], `key-${i}`);
    const sourceNode = h.node(`timeline-${i}`);
    assert.ok(sourceNode);
    h.clearTimeline();
    sourceNode.emit('animationend');
    assert.deepEqual(h.layer.children, [room]);
    assert.equal(h.snapshot().lanes[0].kind, 'room');
    assert.equal(h.snapshot().source.length, 0);
  }
  h.room('room-neighbor');
  assert.equal(h.node('room-neighbor').dataset.danmakuLane, '1');
  h.checkVisualLanes();
});

test('timeline flood cannot starve live room messages', () => {
  const h = createHarness();
  h.setTimeline(Array.from({ length: 500 }, (_, i) => ({ id: `timeline-${i}`, text: 'dense', time: 10 + i / 1000, mode: 'bottom' })), 'dense');
  for (let i = 0; i < 10; i += 1) { h.advance(30); h.processTimeline(); }
  h.room('room-now');
  assert.ok(h.node('room-now'));
  assert.equal(h.node('room-now').dataset.danmakuLane, '0');
  assert.ok(h.snapshot().source.length <= 40);
  h.checkVisualLanes();
});

test('full clear/fullscreen cancel all occupants and stale callbacks stay harmless', () => {
  const h = createHarness();
  h.room('old-room', { mode: 'top' });
  h.source('old-source');
  const old = h.layer.children.slice();
  h.emit('fullscreenchange');
  assert.equal(h.layer.children.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.snapshot().room.length + h.snapshot().source.length, 0);
  h.room('new-room');
  old.forEach((node) => node.emit('animationend'));
  assert.ok(h.node('new-room'));
  h.clear();
  assert.equal(h.timers.size, 0);
});

test('upper-third geometry, bottom mapping and single-to-multi reservation', () => {
  for (const [width, height] of [[320, 180], [820, 461], [1180, 664], [1920, 1080]]) {
    const h = createHarness({ width, height });
    for (let i = 0; i < 10; i += 1) h.source(`bottom-${i}`, { mode: 'bottom' });
    h.room('room');
    h.checkVisualLanes();
  }
  const h = createHarness({ width: 600, height: 180 });
  h.source('single-source');
  h.shell.clientHeight = 420;
  h.layer.clientHeight = 420 * 0.34;
  h.layer.offsetTop = 420 * 0.07;
  h.flush();
  assert.equal(h.node('single-source'), undefined);
  assert.equal(h.snapshot().lanes[0], null);
  h.source('multi-source', { mode: 'bottom' });
  assert.notEqual(h.node('multi-source').dataset.danmakuLane, '0');
  h.checkVisualLanes();
});

test('two short room messages follow on one lane in under two seconds', () => {
  const h = createHarness({ width: 600, height: 180 });
  h.room('first', { text: 'hi' });
  h.room('second', { text: 'hi' });
  h.advance(1000);
  assert.equal(h.layer.children.length, 2);
  assert.ok(h.history[1].at - h.history[0].at < 2000);
  assert.equal(h.node('first').dataset.danmakuLane, h.node('second').dataset.danmakuLane);
  h.checkVisualLanes();
});

test('unequal scroll widths have identical actual speed without duration clamping', () => {
  for (const [width, text] of [[320, 'a'], [1000, 'short'], [3000, 'X'.repeat(100)]]) {
    const h = createHarness({ width, height: 180 });
    h.room('speed', { text });
    const node = h.node('speed');
    const distance = parseFloat(node.style['--danmaku-start']) - parseFloat(node.style['--danmaku-end']);
    const duration = parseFloat(node.style['--danmaku-duration']);
    assert.ok(Math.abs(distance / duration * 1000 - 105) < 1e-9);
    assert.equal(h.snapshot().lanes[0].nodes[0].endsAt, duration);
    assert.equal([...h.timers.values()][0].at, duration);
    if (width === 320) assert.ok(duration < 7000);
    if (width === 3000) assert.ok(duration > 14000);
  }
  const h = createHarness({ width: 600, height: 180 });
  for (const [index, text] of ['a', 'X'.repeat(100), 'b', 'medium length', 'c'].entries()) {
    h.room(`width-${index}`, { text });
  }
  for (let time = 0; time < 25000; time += 100) { h.advance(100); h.checkVisualLanes(); }
  assert.equal(h.history.length, 5);
});

test('short room burst40 drains without drops or seven-second admission waits', () => {
  const h = createHarness({ width: 600, height: 180 });
  for (let i = 0; i < 40; i += 1) h.room(`burst-${i}`, { text: 'hi' });
  for (let time = 0; time < 30000; time += 100) { h.advance(100); h.checkVisualLanes(); }
  assert.equal(h.history.length, 40);
  assert.equal(new Set(h.history.map(entry => entry.node.dataset.danmakuId)).size, 40);
  assert.equal(h.snapshot().room.length, 0);
  for (let i = 1; i < h.history.length; i += 1) assert.ok(h.history[i].at - h.history[i - 1].at < 2000);
  assert.ok(h.history.at(-1).at < 30000);
  console.log(`  burst40 last admission: ${Math.round(h.history.at(-1).at)}ms`);
});

test('fixed and scroll modes wait for the entire preceding lane to empty', () => {
  const h = createHarness({ width: 600, height: 180 });
  h.room('scroll-first', { text: 'hi' });
  h.room('scroll-second', { text: 'hi' });
  h.advance(1000);
  assert.equal(h.layer.children.length, 2);
  const lastEnd = Math.max(...h.snapshot().lanes[0].nodes.map(entry => entry.endsAt));
  h.room('fixed', { mode: 'bottom' });
  h.room('after-fixed', { text: 'hi' });
  h.advance(lastEnd - 1000 - 1);
  assert.equal(h.node('fixed'), undefined);
  h.advance(1);
  assert.equal(h.layer.children.length, 1);
  assert.ok(h.node('fixed'));
  h.advance(3999);
  assert.equal(h.node('after-fixed'), undefined);
  h.advance(1);
  assert.equal(h.layer.children.length, 1);
  assert.ok(h.node('after-fixed'));
  h.checkVisualLanes();
});

test('old node completion cannot release followers or a reused lane', () => {
  const h = createHarness({ width: 600, height: 180 });
  h.room('old', { text: 'hi' });
  h.room('follower', { text: 'hi' });
  const old = h.node('old');
  const oldEnd = h.snapshot().lanes[0].nodes[0].endsAt;
  h.advance(oldEnd);
  assert.equal(h.node('old'), undefined);
  const follower = h.node('follower');
  assert.ok(follower);
  old.emit('animationend');
  old.emit('animationend');
  assert.equal(h.node('follower'), follower);
  h.room('new-follower', { text: 'hi' });
  assert.equal(h.layer.children.length, 2);
  h.checkVisualLanes();
  h.clear();
  h.room('reused', { text: 'hi' });
  follower.emit('animationend');
  old.emit('animationend');
  assert.ok(h.node('reused'));
  assert.equal(h.layer.children.length, 1);
});

test('room preemption removes every source follower and its timer', () => {
  const h = createHarness({ width: 600, height: 180 });
  h.source('source-a', { text: 'hi' });
  h.advance(650);
  h.source('source-b', { text: 'hi' });
  const oldSources = h.layer.children.slice();
  assert.equal(oldSources.length, 2);
  h.room('room', { text: 'hi' });
  assert.equal(h.layer.children.length, 1);
  assert.equal(h.timers.size, 1);
  oldSources.forEach(node => node.emit('animationend'));
  assert.ok(h.node('room'));
  h.source('cannot-evict-room');
  assert.ok(h.node('room'));
  h.checkVisualLanes();
});

test('source-only clear and seek preserve a multi-node room lane', () => {
  for (const action of ['clearTimeline', 'seeking']) {
    const h = createHarness();
    h.room('room-a', { text: 'hi' });
    h.source('source-a', { text: 'hi' });
    h.advance(650);
    h.room('room-b', { text: 'hi' });
    h.source('source-b', { text: 'hi' });
    assert.equal(h.snapshot().lanes[0].nodes.length, 2);
    assert.equal(h.snapshot().lanes[1].nodes.length, 2);
    const roomState = h.snapshot().lanes[0];
    const oldSources = h.layer.children.filter(node => node.classList.contains('is-source-danmaku'));
    if (action === 'seeking') { h.video.seeking = true; h.emit('seeking'); }
    else h.clearTimeline();
    oldSources.forEach(node => node.emit('animationend'));
    assert.deepEqual(h.snapshot().lanes[0], roomState);
    assert.equal(h.layer.children.length, 2);
    assert.equal(h.timers.size, 2);
    h.checkVisualLanes();
  }
});

test('rendered tail, not only the clock, gates safe following', () => {
  const h = createHarness({ width: 600, height: 180, animationLagMs: 500 });
  h.room('delayed', { text: 'hi' });
  h.room('follower', { text: 'hi' });
  h.advance(1000);
  assert.equal(h.node('follower'), undefined);
  h.advance(300);
  assert.ok(h.node('follower'));
  h.checkVisualLanes();
});

test('node cap remains bounded and room can reclaim capacity from source', () => {
  const h = createHarness({ width: 10000, height: 1200 });
  for (let round = 0; round < 20; round += 1) {
    for (let lane = 0; lane < 6; lane += 1) h.source(`source-${round}-${lane}`, { text: 'hi' });
    h.advance(650);
    h.checkVisualLanes();
    assert.ok(h.snapshot().source.length <= 40);
  }
  assert.equal(h.layer.children.length, 80);
  h.room('room-at-cap', { text: 'hi' });
  assert.ok(h.node('room-at-cap'));
  h.checkVisualLanes();
  h.clear();
  assert.equal(h.layer.children.length, 0);
  assert.equal(h.timers.size, 0);
  for (let i = 0; i < 140; i += 1) { h.room(`room-cap-${i}`, { text: 'hi' }); h.advance(650); }
  assert.equal(h.layer.children.length, 80);
  assert.equal(h.snapshot().room.length, 40);
  assert.ok(h.timers.size <= 81);
  h.checkVisualLanes();
});

test('layer width changes do not mix scroll entry origins in one occupied lane', () => {
  const h = createHarness({ width: 600, height: 180 });
  h.room('before-resize', { text: 'hi' });
  h.advance(1000);
  h.layer.clientWidth = 800;
  h.room('after-resize', { text: 'hi' });
  assert.equal(h.node('after-resize'), undefined);
  h.advance(6000);
  assert.ok(h.node('after-resize'));
  assert.equal(h.node('after-resize').style['--danmaku-start'], '800px');
  h.checkVisualLanes();
});

console.log(`Danmaku scheduling: ${passed} deterministic behavior cases passed.`);
