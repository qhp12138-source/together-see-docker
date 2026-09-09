import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const serverRoot = process.cwd();
const projectRoot = path.resolve(serverRoot, '..');
const recoverySource = fs.readFileSync(path.join(projectRoot, 'assets/js/recovery.js'), 'utf8');
const context = vm.createContext({ Map, Math, Number, Object, String });
vm.runInContext(recoverySource, context, { filename: 'recovery.js' });

const recovery = context.TogetherSeeRecovery;
assert.ok(recovery, 'recovery API should be exported');

const attempts = recovery.createAttemptRegistry({ maxAttempts: 1 });
const sourceKey = 'video-1|https://page.example/watch|https://cdn.example/video.mp4|video';
assert.equal(attempts.canBegin(sourceKey), true);
assert.equal(attempts.begin(sourceKey).attempts, 1);
assert.equal(attempts.canBegin(sourceKey), false, 'in-flight recovery must not start twice');
attempts.finish(sourceKey, { pendingReadyNotice: true });
assert.equal(attempts.canBegin(sourceKey), false, 'successful parsing must not reset the retry budget');
assert.equal(attempts.markReady(sourceKey), true, 'first playable event should release the success notice');
assert.equal(attempts.markReady(sourceKey), false, 'later playable events must not duplicate the success notice');
assert.equal(attempts.markFailureNotified(sourceKey), true);
assert.equal(attempts.markFailureNotified(sourceKey), false, 'terminal failure notice must be deduplicated');
assert.equal(attempts.snapshot(sourceKey).attempts, 1, 'state must survive a DOM item rebuild with the same source key');
assert.equal(attempts.canBegin(sourceKey + '|changed'), true, 'a changed authoritative source receives a new recovery budget');

const loads = recovery.createLoadTracker();
const first = loads.begin('video-1|old-url');
assert.equal(loads.markTerminal(first), true);
assert.equal(loads.markTerminal(first), false, 'one load generation may dispatch one terminal error');
const second = loads.begin('video-1|new-url');
assert.equal(loads.isCurrent(first), false, 'old generation must become stale');
assert.equal(loads.markTerminal(first), false, 'a stale error must not terminate the new source');
assert.equal(loads.isCurrent(second), true);
assert.equal(loads.markReady(first), false, 'a stale playable event must not mark the new source ready');
assert.equal(loads.markReady(second), true);
assert.equal(loads.markReady(second), false, 'one generation should publish readiness only once');
assert.equal(loads.isReady(second), true);
assert.equal(loads.markRecovering(second), true);
assert.equal(loads.isReady(second), false, 'recovery must require a fresh playable confirmation');
assert.equal(loads.markTerminal(second), true);
assert.equal(loads.markReady(second), false, 'a delayed playable event must not revive a terminal generation');

let snapshotClock = 1_000;
const playbackSnapshots = recovery.createPlaybackSnapshotQueue({ now: () => snapshotClock });
const playingSnapshot = playbackSnapshots.observe({
  activeSourceId: 'video-1', playing: true, currentTime: 12, playbackRate: 1, updatedBy: 'host-a', updatedAt: 100,
});
assert.equal(playingSnapshot.accepted, true);
assert.equal(playbackSnapshots.queue(playingSnapshot.snapshot, {
  sourceId: 'video-1', allowAuthority: true,
}), true);

snapshotClock = 1_010;
const pausedSnapshot = playbackSnapshots.observe({
  activeSourceId: 'video-1', playing: false, currentTime: 13, playbackRate: 1, updatedBy: 'host-a', updatedAt: 100,
});
assert.equal(pausedSnapshot.accepted, true, 'a later state with the same server timestamp must replace a different state');
assert.equal(playbackSnapshots.peekPending().snapshot.playback.playing, false, 'a host pause must replace an older pending play');
assert.equal(playbackSnapshots.peekPending().allowAuthority, true, 'controller reconnect permission should survive a newer pending state');

const staleSnapshot = playbackSnapshots.observe({
  activeSourceId: 'video-1', playing: true, currentTime: 9, updatedBy: 'host-a', updatedAt: 99,
});
assert.equal(staleSnapshot.accepted, false, 'an older playback snapshot must never revive pending playback');
assert.equal(playbackSnapshots.consume({ sourceId: 'video-1' }).snapshot.playback.playing, false);
assert.equal(playbackSnapshots.peekPending(), null);
assert.equal(playbackSnapshots.observe(pausedSnapshot.snapshot.playback).duplicate, true, 'identical room-state echoes should be deduplicated');
assert.equal(recovery.shouldApplyPlaybackSnapshot({ updatedBy: 'host-a' }, 'host-a'), false, 'routine self echoes should not perturb the controller');
assert.equal(recovery.shouldApplyPlaybackSnapshot({ updatedBy: 'host-a' }, 'host-a', {
  restoreAuthoritative: true,
}), true, 'a legitimate reconnect must restore the controller from its own authoritative snapshot');
assert.equal(recovery.shouldApplyPlaybackSnapshot({ updatedBy: 'host-a' }, 'guest-b'), true, 'followers should always apply the controller snapshot');

const versionedPlaybackSnapshots = recovery.createPlaybackSnapshotQueue();
assert.equal(versionedPlaybackSnapshots.observe({
  activeSourceId: 'video-1', playing: true, currentTime: 20, updatedBy: 'host-a', updatedAt: 200, revision: 4,
}).accepted, true);
assert.equal(versionedPlaybackSnapshots.observe({
  activeSourceId: 'video-1', playing: true, currentTime: 99, updatedBy: 'guest-b', updatedAt: 999, revision: 3,
}).accepted, false, 'an older server playback revision must lose even when its timestamp is newer');

const playOperations = recovery.createOperationTracker();
const sourceAPlay = playOperations.begin('source-a|generation-1|play');
const sourceBPlay = playOperations.begin('source-b|generation-2|play');
assert.equal(playOperations.isCurrent(sourceAPlay), false, 'a source switch must invalidate the old play promise');
assert.equal(playOperations.isCurrent(sourceBPlay), true);
playOperations.invalidate();
assert.equal(playOperations.isCurrent(sourceBPlay), false, 'a newer pause must invalidate the in-flight play promise');

let nextAckTimerId = 1;
const ackTimers = new Map();
let ackTimeouts = 0;
const bufferingAcks = recovery.createAckSingleFlight({
  timeoutMs: 5000,
  setTimeout: function (callback, timeoutMs) {
    assert.equal(timeoutMs, 5000);
    const id = nextAckTimerId;
    nextAckTimerId += 1;
    ackTimers.set(id, callback);
    return id;
  },
  clearTimeout: function (id) { ackTimers.delete(id); },
});
const lostBufferingAck = bufferingAcks.begin(function () { ackTimeouts += 1; });
assert.ok(lostBufferingAck);
assert.equal(bufferingAcks.begin(function () {}), null, 'one buffering publication must remain in flight until ACK or timeout');
const [lostAckTimerId, lostAckTimer] = ackTimers.entries().next().value;
ackTimers.delete(lostAckTimerId);
lostAckTimer();
assert.equal(ackTimeouts, 1);
assert.equal(bufferingAcks.isInFlight(), false, 'a lost buffering ACK must release the publication gate');
assert.equal(bufferingAcks.settle(lostBufferingAck), false, 'a late ACK from an expired generation must be ignored');
const recoveredBufferingAck = bufferingAcks.begin(function () { ackTimeouts += 1; });
assert.equal(bufferingAcks.settle(recoveredBufferingAck), true);
assert.equal(ackTimers.size, 0, 'a valid ACK must cancel its timeout');
const disconnectedBufferingAck = bufferingAcks.begin(function () { ackTimeouts += 1; });
bufferingAcks.reset();
assert.equal(bufferingAcks.isCurrent(disconnectedBufferingAck), false, 'socket reset must invalidate a pending buffering ACK');
assert.equal(ackTimers.size, 0, 'socket reset must cancel the pending timeout');

const generationLoads = recovery.createLoadTracker();
const generationA = generationLoads.begin('source-a|direct');
const initialSeek = recovery.createGenerationValue((token) => generationLoads.isCurrent(token));
assert.equal(initialSeek.bind(generationA, 123.5), true);
assert.equal(initialSeek.peek(generationA), 123.5);
const generationB = generationLoads.begin('source-b|direct');
assert.equal(initialSeek.peek(generationA), null, 'an initial seek must not survive a source generation change');
assert.equal(initialSeek.peek(generationB), null, 'a new source must not inherit the old initial seek');
assert.equal(initialSeek.bind(generationB, 4.5), true);
assert.equal(initialSeek.take(generationB), 4.5);

const proxyFallback = recovery.createFallbackController({ maxAttempts: 1 });
const directGeneration = proxyFallback.reset('video-1|video|https://cdn.example/video.mp4');
const fallbackIntent = { currentTime: 88, playing: true, playbackRate: 1.25 };
const firstFallback = proxyFallback.begin(directGeneration.identity, fallbackIntent);
assert.deepEqual(firstFallback.value, fallbackIntent);
assert.equal(proxyFallback.begin(directGeneration.identity, fallbackIntent), null, 'one source generation may enter proxy fallback only once');
const nextDirectGeneration = proxyFallback.reset('video-2|hls|https://cdn.example/live.m3u8');
assert.ok(proxyFallback.begin(nextDirectGeneration.identity, fallbackIntent), 'a real source switch receives a fresh proxy fallback budget');

const roomSource = fs.readFileSync(path.join(projectRoot, 'assets/js/room.js'), 'utf8');
const playerSource = fs.readFileSync(path.join(projectRoot, 'assets/js/player.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unable to extract ${name}`);
}

const sourceIntentContext = vm.createContext({ Date, Math, Number, Object, String });
vm.runInContext(`${extractFunction(roomSource, 'createSourceIntentGate')}\nthis.createSourceIntentGate = createSourceIntentGate;`, sourceIntentContext);
const sourceIntents = sourceIntentContext.createSourceIntentGate();
const switchToB = sourceIntents.begin('source-b', 7, true);
const oldSourceRequest = { generation: switchToB.generation - 1, sourceId: 'source-a', baseRevision: 6, action: 'periodic' };
assert.equal(sourceIntents.shouldIgnore({ activeSourceId: 'source-a', revision: 8 }, { requestContext: oldSourceRequest }), true, 'a late old-source ACK must not cross a newer local source generation');
assert.equal(sourceIntents.shouldIgnore({ activeSourceId: 'source-a', revision: 8 }), true, 'an old-source broadcast must wait while the local source switch is pending');
const switchContext = sourceIntents.capture('source-b', 7, 'source');
assert.equal(sourceIntents.shouldIgnore({ activeSourceId: 'source-b', revision: 8 }, { requestContext: switchContext }), false);
assert.equal(sourceIntents.accept({ activeSourceId: 'source-b', revision: 8 }), true);
assert.equal(sourceIntents.snapshot().pending, null, 'the matching authoritative source must settle the local switch');
assert.equal(sourceIntents.shouldIgnore({ activeSourceId: 'source-c', revision: 9 }), false, 'a newer server source remains authoritative after the local switch settles');
assert.equal(sourceIntents.accept({ activeSourceId: 'source-c', revision: 9 }), true);
assert.equal(sourceIntents.snapshot().targetSourceId, 'source-c');
const abandonedSwitch = sourceIntents.begin('source-d', 9, false);
const abandonedContext = sourceIntents.capture('source-d', 9, 'source');
assert.equal(sourceIntents.cancel(abandonedContext), true, 'a rejected source request must release its pending gate');
assert.equal(sourceIntents.shouldIgnore({ activeSourceId: 'source-c', revision: 9 }), false, 'server authority must be accepted again after a source request is rejected');
assert.equal(sourceIntents.isCurrent(abandonedSwitch), false, 'cancelled source generations must invalidate their late callbacks');

let sourceIntentClock = 100;
const expiringSourceIntents = sourceIntentContext.createSourceIntentGate({ now: () => sourceIntentClock, pendingTimeoutMs: 1000 });
const expiringContext = expiringSourceIntents.begin('source-next', 11, false);
assert.equal(expiringSourceIntents.shouldIgnore({ activeSourceId: 'source-current', revision: 11 }), true);
sourceIntentClock = 1101;
assert.equal(expiringSourceIntents.shouldIgnore({ activeSourceId: 'source-current', revision: 11 }), false, 'a lost source ACK must release the pending gate after its bounded timeout');
assert.equal(expiringSourceIntents.isCurrent(expiringContext), false, 'the timeout must invalidate callbacks from the abandoned generation');
expiringSourceIntents.begin('source-next', 11, false);
expiringSourceIntents.reset();
assert.equal(expiringSourceIntents.shouldIgnore({ activeSourceId: 'source-current', revision: 11 }), false, 'socket reconnect reset must immediately restore server authority');

const loadIntentContext = vm.createContext({ Math, Number });
vm.runInContext(`${extractFunction(playerSource, 'createLoadPlaybackIntent')}\nthis.createLoadPlaybackIntent = createLoadPlaybackIntent;`, loadIntentContext);
const pausedLoadIntent = loadIntentContext.createLoadPlaybackIntent(
  { id: 'source-a' },
  { startTime: 12.5, playWhenReady: false, playbackRate: 1.25 },
);
assert.equal(JSON.stringify(pausedLoadIntent), JSON.stringify({
  sourceId: 'source-a', currentTime: 12.5, playing: false, playbackRate: 1.25,
}), 'autoplay off must keep the next source paused with its requested timeline');
assert.equal(loadIntentContext.createLoadPlaybackIntent({ id: 'source-b' }, { playWhenReady: true }).playing, true, 'autoplay on must create a real play intent');

const playerSyncReadyContext = vm.createContext({
  Boolean,
  lastBufferingState: false,
  video: { src: 'https://media.example/video.mp4', readyState: 2, seeking: false },
});
vm.runInContext(`${extractFunction(playerSource, 'isMediaReadyForSync')}\nthis.isMediaReadyForSync = isMediaReadyForSync;`, playerSyncReadyContext);
assert.equal(playerSyncReadyContext.isMediaReadyForSync(), true, 'HAVE_CURRENT_DATA is usable when the player is not buffering');
playerSyncReadyContext.lastBufferingState = true;
assert.equal(playerSyncReadyContext.isMediaReadyForSync(), false, 'waiting or stalled media must remain unready even when readyState stays at HAVE_CURRENT_DATA');
playerSyncReadyContext.lastBufferingState = false;
playerSyncReadyContext.video.seeking = true;
assert.equal(playerSyncReadyContext.isMediaReadyForSync(), false, 'seeking media must remain unready for synchronization');

let syncRecoveryClock = 1_000;
const syncRecoveryEffects = { cleared: 0, invalidated: 0, resetRate: 0, status: [] };
const syncRecoveryContext = vm.createContext({
  Date: { now: () => syncRecoveryClock },
  SYNC_UNREADY_TIMEOUT_MS: 30_000,
  SYNC_RECOVERY_STABLE_MS: 15_000,
  syncUnavailableSince: 0,
  syncRecoveryActive: false,
  syncStableSince: 0,
  lastSyncRecoveryPlayAttemptAt: 0,
  remotePlaybackSnapshots: { clearPending: () => { syncRecoveryEffects.cleared += 1; } },
  remotePlayOperations: { invalidate: () => { syncRecoveryEffects.invalidated += 1; } },
  resetSyncCorrectionRate: () => { syncRecoveryEffects.resetRate += 1; },
  player: { getPreferredPlaybackRate: () => 1.25 },
  setPlaybackStatusText: (value) => { syncRecoveryEffects.status.push(value); },
});
vm.runInContext(`
  ${extractFunction(roomSource, 'resetSyncRecoveryState')}
  ${extractFunction(roomSource, 'shouldSuspendAutomaticSync')}
  this.shouldSuspendAutomaticSync = shouldSuspendAutomaticSync;
`, syncRecoveryContext);
assert.equal(syncRecoveryContext.shouldSuspendAutomaticSync(false), false, 'a short buffering event must not disable synchronization immediately');
syncRecoveryClock = 30_999;
assert.equal(syncRecoveryContext.shouldSuspendAutomaticSync(false), false, 'automatic correction must remain available before the 30 second boundary');
syncRecoveryClock = 31_000;
assert.equal(syncRecoveryContext.shouldSuspendAutomaticSync(false), true, '30 seconds of continuous buffering must suspend automatic correction');
assert.deepEqual(syncRecoveryEffects, {
  cleared: 1,
  invalidated: 1,
  resetRate: 1,
  status: ['网络不稳定，已暂停进度校准并优先恢复播放'],
});
syncRecoveryClock = 40_000;
assert.equal(syncRecoveryContext.shouldSuspendAutomaticSync(true), true, 'the first healthy observation must begin, not finish, the recovery window');
syncRecoveryClock = 54_999;
assert.equal(syncRecoveryContext.shouldSuspendAutomaticSync(true), true, 'recovery must remain suspended until 15 stable seconds have elapsed');
syncRecoveryClock = 55_000;
assert.equal(syncRecoveryContext.shouldSuspendAutomaticSync(true), false, '15 stable seconds must restore automatic synchronization');
assert.equal(syncRecoveryEffects.status.at(-1), '播放已稳定，自动同步已恢复');

const roomHtml = fs.readFileSync(path.join(projectRoot, 'room.html'), 'utf8');
const indexHtml = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
const siteSource = fs.readFileSync(path.join(projectRoot, 'assets/js/site.js'), 'utf8');
const credentialSource = fs.readFileSync(path.join(projectRoot, 'assets/js/credentials.js'), 'utf8');
const mainCss = fs.readFileSync(path.join(projectRoot, 'assets/css/main.css'), 'utf8');
const brandIconSvg = fs.readFileSync(path.join(projectRoot, 'assets/icons/together-see.svg'), 'utf8');
const socketSource = fs.readFileSync(path.join(projectRoot, 'server/src/sockets/index.ts'), 'utf8');
const roomRouteSource = fs.readFileSync(path.join(projectRoot, 'server/src/routes/room.routes.ts'), 'utf8');
const roomServiceSource = fs.readFileSync(path.join(projectRoot, 'server/src/services/room.service.ts'), 'utf8');
const roomStoreSource = fs.readFileSync(path.join(projectRoot, 'server/src/services/room-store.service.ts'), 'utf8');
const disclaimerPattern = /<footer class="site-disclaimer" aria-label="免责声明">[\s\S]*本站仅供学习交流与技术研究[\s\S]*不提供、不上传或存储任何视频文件[\s\S]*不支持绕过登录、会员、付费、验证码或 DRM 等访问限制。[\s\S]*<\/footer>/;

const sourceFollowTarget = {
  dataset: { sourceId: 'source-b', sourceType: 'video' },
  classList: { contains: () => false },
};
const sourceFollowHarness = vm.createContext({
  Boolean,
  CSS: { escape: (value) => String(value) },
  Math,
  Number,
  roomAccessGranted: true,
  player: {
    video: {
      src: 'https://media.example/source-a.mp4',
      paused: true,
      ended: false,
      playbackRate: 1,
      dataset: { sourceId: 'source-a' },
    },
    getAutoSyncEnabled: () => false,
    getPreferredPlaybackRate: () => 1,
    setDesiredPlaybackState: (value) => { sourceFollowHarness.desiredPlayback = value; },
  },
  sourceIntentGate: {
    shouldIgnore: () => false,
    accept: (value) => { sourceFollowHarness.acceptedPlayback = value; },
  },
  remotePlaybackSnapshots: {
    observe: (value) => ({ accepted: true, snapshot: { playback: Object.assign({}, value) } }),
    current: () => null,
    clearPending: () => { sourceFollowHarness.pendingCleared = true; },
  },
  roomState: {},
  updatePlaybackAuthorityUi: () => {},
  remotePlayOperations: { invalidate: () => {} },
  playlistList: { querySelector: () => sourceFollowTarget },
  activatePlaylistItem: (target, options) => { sourceFollowHarness.activation = { target, options }; },
  setPlaybackStatusText: (value) => { sourceFollowHarness.statusText = value; },
  resetSyncCorrectionRate: () => {},
  resetSyncRecoveryState: () => {},
});
vm.runInContext(`${extractFunction(roomSource, 'applyRemotePlayback')}\nthis.applyRemotePlayback = applyRemotePlayback;`, sourceFollowHarness);
sourceFollowHarness.applyRemotePlayback({
  activeSourceId: 'source-b',
  playing: true,
  currentTime: 30,
  playbackRate: 1.75,
  updatedAt: 300,
  updatedBy: 'host-a',
  revision: 7,
}, { fromBroadcast: true });
assert.equal(sourceFollowHarness.activation?.target, sourceFollowTarget, 'a playback_state source change must activate the authoritative item while auto-sync is off');
assert.equal(sourceFollowHarness.activation?.options?.playing, false, 'source following with auto-sync off must preserve the local paused intent');
assert.equal(sourceFollowHarness.activation?.options?.playbackRate, 1, 'source following with auto-sync off must preserve the local playback rate');
assert.equal(sourceFollowHarness.activation?.options?.startTime, undefined, 'source following with auto-sync off must not adopt the remote current time');
assert.equal(sourceFollowHarness.desiredPlayback, null, 'source following must not restore remote timeline correction while auto-sync is off');
assert.equal(sourceFollowHarness.pendingCleared, true, 'source following with auto-sync off must clear queued remote correction');
assert.equal(sourceFollowHarness.roomState.playback.activeSourceId, 'source-b', 'the client should still retain the latest authoritative room playback snapshot');

assert.doesNotMatch(roomSource, /clientParseTried/, 'legacy retry flag would reintroduce the parse loop');
assert.match(roomSource, /proxy_token_request/);
assert.match(playerSource, /TogetherSeeRoomProxy/);
assert.match(roomSource, /function getPublicParseAuthorizationMessage\(payload\)[\s\S]*parse_option_missing: "未配置解析项"[\s\S]*parse_authorization_failed: "授权解析失败"/, 'proxy grant failures should be mapped to stable public parsing language');
assert.match(socketSource, /toPublicMediaGrantFailure\(error\)/, 'Socket grant failures must pass through the public error mapper');
assert.doesNotMatch(socketSource, /respond\(\{ success: false, message: error instanceof Error \? error\.message/, 'Socket grant failures must not expose raw server errors');
assert.doesNotMatch(playerSource, /"[^"]*(?:媒体代理|HLS 代理|后端代理|hls\.js 未加载|assets\/js\/hls\.js)[^"]*"/, 'player status copy must not expose internal proxy or asset terminology');
assert.doesNotMatch(playerSource, /下一阶段|播放器骨架|真实播放器骨架/, 'player status copy must not expose development roadmap terminology');
assert.doesNotMatch(playerSource, /\/api\/proxy\/["' +()\w?.:-]*\?[^\n]*url=/, 'the player must not expose upstream URLs in proxy query strings');
assert.doesNotMatch(roomServiceSource, /scryptSync/, 'password hashing must remain asynchronous');
assert.doesNotMatch(roomSource, /本设备解析成功/, 'parse completion must not be presented as playback success');
assert.match(roomSource, /together-see:player-source-ready/);
assert.match(roomSource, /item\.isConnected[\s\S]*getCurrentPlaylistItem\(\) === item/, 'stale async parses must not load an inactive item');
assert.match(roomSource, /payload\.sourceUrl = item\.dataset\.sharedSourceUrl/, 'device-only source URLs must not enter the shared snapshot');
assert.match(roomSource, /function getPlayablePayload\(item\) \{\s*const payload = getItemPayload\(item\)/, 'local playback must keep the device-specific parsed source');
assert.match(roomSource, /function getSharedPayloadFromItem\(item\)[\s\S]*payload\.sourceUrl = localPlaceholderUrl\(meta\)[\s\S]*payload\.pageUrl = payload\.sourceUrl/, 'local blob URLs must be replaced by a shared local placeholder');
assert.match(roomSource, /async function bindLocalFileToItem\(item, file, options\)[\s\S]*shouldRestorePlayback = autoSyncEnabled && playback\?\.activeSourceId === item\.dataset\.sourceId[\s\S]*startTime: Number\.isFinite\(predictedTime\)[\s\S]*queueRemotePlaybackUntilReady\(snapshot, "本地文件加载中，稍后同步"/, 'binding a local file should restore the authoritative timeline only while auto sync is enabled');
assert.match(roomSource, /async function addLocalVideoFile\(file\)[\s\S]*await addRemotePlaylistItem\(payload\)[\s\S]*activatePlaylistItem\(item\)/, 'a local item must be accepted by the room before its source update is emitted');
assert.match(roomSource, /localPendingPlaying[\s\S]*localPendingPlaybackRate[\s\S]*playWhenReady: shouldRestorePlayback \? playback\?\.playing === true : localShouldPlay[\s\S]*playbackRate: shouldRestorePlayback \? playback\?\.playbackRate : localRate/, 'binding a local file with auto sync disabled must preserve local playback intent');
assert.match(socketSource, /sourceType === 'local' && !hasUsableLocalFileMeta\(localFile\)[\s\S]*createLocalPlaceholderUrl\(localFile!\)/, 'the server must reject malformed local items and canonicalize their shared URL');
assert.match(roomStoreSource, /sourceType === 'local' \? createLocalPlaceholderUrl\(localFile!\)[\s\S]*finalUrl: sourceType === 'local' \? ''[\s\S]*refererUrl: sourceType === 'local' \? ''/, 'restored snapshots must discard stale local blob and remote URL fields');
assert.match(playerSource, /tryMediaProxyFallback/);
assert.match(playerSource, /requestMediaProxyUrl\(lastMediaSource, "media"\)/);
assert.match(playerSource, /source\.sourceType === "video" && source\.bilibili[\s\S]*lastMediaUsingProxy = false[\s\S]*video\.referrerPolicy = "no-referrer"[\s\S]*video\.src = source\.sourceUrl/, 'Bilibili media should try the signed CDN URL directly before using the room-scoped proxy fallback');
assert.match(playerSource, /BILIBILI_DIRECT_LOAD_TIMEOUT_MS = 12000[\s\S]*source\.bilibili \? BILIBILI_DIRECT_LOAD_TIMEOUT_MS/, 'a stalled Bilibili direct attempt should move to the bounded compatibility fallback');
assert.match(playerSource, /BILIBILI_STALL_FALLBACK_MS = 8000[\s\S]*function scheduleMediaStallFallback\(\)[\s\S]*tryMediaProxyFallback\("B站直连持续缓冲"\)/, 'a Bilibili direct stream that stalls after loading should receive one bounded proxy fallback');
assert.match(playerSource, /dispatchPlayerEvent\("together-see:player-buffering-change", \{[\s\S]*buffering: shouldSpin[\s\S]*bufferedAhead: getForwardBufferSeconds\(\)/, 'the player should publish privacy-safe effective buffering changes');
assert.match(playerSource, /retryHlsProxyGrant[\s\S]*retryMediaProxyGrant/, 'expired or restarted media proxy grants should receive one automatic refresh');
assert.match(playerSource, /recoveryIntent\.currentTime[\s\S]*recoveryIntent: recoveryIntent/, 'proxy fallback should preserve the media timeline and playback intent');
assert.match(playerSource, /createGenerationValue[\s\S]*function bindInitialSeek/, 'initial seek should be bound to a load generation');
assert.match(playerSource, /userPlayOperations\.isCurrent\(operation\)[\s\S]*isCurrentLoadToken\(loadToken\)/, 'user play promises should be rejected after a load generation change');
assert.match(playerSource, /HLS_JS_LOAD_TIMEOUT_MS/);
assert.match(playerSource, /bindMediaLoadEvents\(source, loadToken, source\.sourceUrl\)/);
assert.match(playerSource, /function isControlsInteractionActive\(\)/, 'controller hiding must account for active interaction');
assert.match(playerSource, /controls\?\.addEventListener\("pointerenter"[\s\S]*controlsPointerInside = event\.pointerType !== "touch"/, 'mouse hover must hold the controller without creating sticky touch hover');
assert.match(playerSource, /function isEditableControl\(element\)[\s\S]*element\.matches\("input, textarea, select, \[contenteditable='true'\]"\)/, 'only editable controls may hold visibility after pointer exit');
assert.match(playerSource, /controls\?\.addEventListener\("focusin"[\s\S]*controlsFocusInside = isEditableControl\(event\.target\);[\s\S]*keepControlsVisible\(\)/, 'focused controller inputs must remain visible');
assert.match(playerSource, /danmakuInput\?\.addEventListener\("input", keepControlsVisible\)/, 'typing danmaku must keep mobile controls visible');
assert.match(roomHtml, /<div class="player-brand-line">一起See<\/div>/, 'player brand should only show the Chinese product name');
assert.match(indexHtml, /rel="icon" type="image\/svg\+xml" href="\.\/assets\/icons\/together-see\.svg\?v=20260904-bilibili-fallback"/, 'home page should publish the shared SVG favicon');
assert.match(roomHtml, /rel="icon" type="image\/svg\+xml" href="\.\/assets\/icons\/together-see\.svg\?v=20260904-bilibili-fallback"/, 'room page should publish the shared SVG favicon');
assert.doesNotMatch(indexHtml, /class="brand-mark">TS<\/span>/, 'home brand must not retain the TS placeholder');
assert.doesNotMatch(roomHtml, /class="brand-mark">TS<\/span>/, 'room brand must not retain the TS placeholder');
assert.match(indexHtml, /class="brand-mark" aria-hidden="true"><img src="\.\/assets\/icons\/together-see\.svg\?v=20260904-bilibili-fallback" alt="" \/><\/span>/, 'home brand should reuse the favicon asset');
assert.match(roomHtml, /class="brand-mark" aria-hidden="true"><img src="\.\/assets\/icons\/together-see\.svg\?v=20260904-bilibili-fallback" alt="" \/><\/span>/, 'room brand should reuse the favicon asset');
assert.match(brandIconSvg, /viewBox="0 0 36 36"[\s\S]*<title>一起See<\/title>[\s\S]*fill="#72E7FF"/, 'brand icon should retain the supplied viewBox and accessible identity');
assert.match(mainCss, /\.brand-mark img \{ display:block; width:100%; height:100%; \}/, 'brand icon should fill its stable header mark');
assert.match(mainCss, /\.circle-button \{[\s\S]*position: relative;[\s\S]*padding: 0;[\s\S]*\.circle-button > svg \{[\s\S]*position: absolute;[\s\S]*inset: 0;[\s\S]*margin: auto;/, 'circular player icons should remain centered independently of browser button padding');
assert.match(indexHtml, disclaimerPattern, 'the home page should end with the official learning-use disclaimer');
assert.match(roomHtml, disclaimerPattern, 'the room page should end with the official learning-use disclaimer');
assert.match(mainCss, /\.site-disclaimer\s*\{[\s\S]*border-top:[\s\S]*grid-template-columns:[\s\S]*color: var\(--faint\)/, 'the disclaimer should use a quiet responsive footer treatment');
assert.match(mainCss, /-webkit-backdrop-filter:blur\(16px\) saturate\(145%\)/, 'transparent player glass needs the lighter Safari backdrop filter');
assert.match(mainCss, /-webkit-backdrop-filter:blur\(14px\) saturate\(140%\)/, 'mobile player glass should use the lighter blur');
assert.match(mainCss, /\.fullscreen-danmaku-compose input \{[\s\S]*?height:27px;[\s\S]*?border-radius:999px;/, 'danmaku composer should be compact and visibly rounded');
assert.doesNotMatch(roomSource, /window\.(?:prompt|confirm|alert)\s*\(/, 'room workflows must not use browser-native dialogs');
assert.match(roomSource, /function startPlaylistRename\(item\)[\s\S]*setInterfaceIcon\(confirm, "check"\);[\s\S]*setInterfaceIcon\(cancel, "x"\);/, 'playlist titles should use icon-based inline actions');
assert.match(roomSource, /function startCurrentMemberRename\(memberItem\)[\s\S]*setInterfaceIcon\(confirm, "check"\);[\s\S]*setInterfaceIcon\(cancel, "x"\);/, 'member names should use icon-based inline actions');
assert.doesNotMatch(roomSource, /(?:confirm|cancel)\.textContent = "(?:✔|×)"/, 'inline actions must not use literal glyphs');
assert.match(roomHtml, /data-room-control-policy-option="host_only"[\s\S]*data-room-control-policy-option="everyone"/, 'room management should expose an explicit control policy selector');
assert.match(roomHtml, /<details class="room-security-panel"[\s\S]*room-security-summary-icon[\s\S]*room-security-chevron/, 'room settings should use a clear icon-led collapsible header');
assert.match(roomHtml, /data-room-password-form[\s\S]*data-room-admin-recovery-form[\s\S]*data-room-confirm-modal[\s\S]*data-room-password-modal/, 'password, recovery and confirmations should use page-native UI');
assert.match(roomHtml, /<body data-page="room" data-room-access="pending">[\s\S]*<main class="room-main" inert>/, 'room content must start behind an access gate');
assert.match(roomHtml, /data-room-password-fields hidden[\s\S]*data-room-access-home>返回首页/, 'the access gate should support password entry and a home escape route');
assert.match(roomSource, /function grantRoomAccess\(\)[\s\S]*roomMain\?\.removeAttribute\("inert"\)/, 'room content should unlock only after admission');
assert.match(roomSource, /joinTimeoutRetryCount < 2[\s\S]*showRoomAccessGate\("retry"/, 'lost join acknowledgements must stop after bounded automatic retries');
assert.match(roomSource, /roomAccessSubmit\.textContent = [^\n]*retryable \? "重新尝试"/, 'a timed-out join must expose an actionable retry button');
assert.ok(
  socketSource.indexOf('let state = roomService.joinRoom({') < socketSource.indexOf('socket.data.roomCode = roomCode;'),
  'Socket room identity must only bind after the authoritative service admission commits',
);
assert.doesNotMatch(roomSource, /updateSyncDrift\(NaN\);\s*restorePlaylist\(\)/, 'cached playlists must not load before room admission');
assert.match(playerSource, /availableLanes\[Math\.floor\(Math\.random\(\) \* availableLanes\.length\)\]/, 'danmaku should choose randomly among safe lanes');
assert.match(mainCss, /\.danmaku-item\s*\{[\s\S]*color:#fff;[\s\S]*opacity:\.72;/, 'danmaku should preserve white text and use actual element opacity');
assert.match(mainCss, /\.danmaku-item\.is-source-danmaku \{ opacity:\.64; \}/, 'Bilibili source danmaku should use a genuinely translucent layer');
assert.match(playerSource, /function setTimelineDanmaku\(entries, key\)[\s\S]*function processTimelineDanmaku\(\)/, 'the player should expose a source-timeline danmaku scheduler');
assert.match(playerSource, /function scheduleTimelineDanmakuFrame\(\)[\s\S]*window\.requestAnimationFrame[\s\S]*processTimelineDanmaku\(\)[\s\S]*scheduleTimelineDanmakuFrame\(\)/, 'Bilibili source danmaku should advance continuously between sparse media timeupdate events');
assert.match(playerSource, /has-source-danmaku[\s\S]*is-room-danmaku/, 'room danmaku should receive a distinct style hook only while source danmaku is active');
assert.match(mainCss, /\.player-shell\.has-source-danmaku \.danmaku-item\.is-room-danmaku[\s\S]*color:#79ecff;[\s\S]*border:1px solid/, 'room danmaku should be visually distinct from Bilibili source danmaku');
assert.match(playerSource, /video\.addEventListener\("seeked"[\s\S]*resetTimelineDanmakuCursor\(video\.currentTime/, 'seeking should reposition the Bilibili danmaku timeline');
assert.match(playerSource, /document\.addEventListener\("fullscreenchange"[\s\S]*?clearDanmaku\(\);/, 'fullscreen changes should clear active nodes without resetting the source timeline');
assert.match(roomSource, /socket\.emit\("playlist_bilibili_danmaku_update"/, 'Bilibili playlist toggles should be shared through the room socket');
assert.match(roomSource, /fetch\("\/api\/bilibili\/danmaku\?bvid=/, 'Bilibili source timelines should use the bounded public endpoint');
assert.doesNotMatch(roomSource, /bilibili\.danmakuAvailable, bilibili\.danmakuEnabled/, 'danmaku visibility metadata must not participate in the structural media-source signature');
assert.match(roomSource, /function reconcileBilibiliDanmakuFromState\(state\)[\s\S]*previousEnabled === meta\.danmakuEnabled[\s\S]*loadBilibiliTimelineForItem\(item\)/, 'remote Bilibili toggle updates should reconcile the timeline without rebuilding the playlist');
assert.match(roomSource, /function loadBilibiliTimelineForItem\(item\) \{\s*if \(!item \|\| getCurrentPlaylistItem\(\) !== item\) return;[\s\S]*player\.setDanmakuVisible\?\.\(true\)/, 'only the current Bilibili item may replace the source timeline, and a shared enabled state must be locally visible');
assert.match(roomSource, /function requestBilibiliSourceRefresh\(item, reason\)[\s\S]*playlist_bilibili_source_refresh[\s\S]*handleRoomActionAck\(state\)/, 'expired Bilibili media should request a bounded authoritative source refresh');
assert.match(roomSource, /together-see:player-error[\s\S]*getBilibiliMetaFromItem\(current\)[\s\S]*requestBilibiliSourceRefresh\(current[\s\S]*if \(isPlaybackController\(\)\) return/, 'both controllers and followers must refresh Bilibili sources before generic device-only recovery');
assert.match(socketSource, /playlist_bilibili_source_refresh[\s\S]*requireRoomMember\(socket[\s\S]*refreshBilibiliPlaylistSource/, 'Bilibili refresh must be available only to admitted room members and resolved by the server');
assert.match(roomServiceSource, /refreshBilibiliPlaylistSource[\s\S]*currentBilibili\.bvid !== nextBilibili\.bvid[\s\S]*danmakuEnabled: currentBilibili\.danmakuEnabled/, 'authoritative Bilibili refresh must preserve item identity and danmaku preference');
assert.match(roomSource, /options\?\.allowFallback && item\.dataset\.sourceUrl[\s\S]*player\.loadSource\(getPlayablePayload\(item\), \{\s*playWhenReady: options\?\.playWhenReady === true,\s*playbackRate: options\?\.playbackRate,\s*\}\)/, 'a parse failure must preserve an already loaded fallback source and playback intent');
assert.match(roomSource, /function renderPlaylistFromState\(state\)[\s\S]*existingById = new Map[\s\S]*updatePlaylistItemFromState[\s\S]*activeChanged \|\| activeSourceChanged \|\| playerSourceMissing/, 'playlist metadata and queue additions must reconcile in place without reloading the active video');
assert.doesNotMatch(roomSource, /if \(current && \(playlistChanged \|\| activeChanged/, 'adding an inactive playlist entry must not reactivate the current source');
assert.match(roomSource, /function getHardSyncThreshold\(\) \{\s*return Math\.max\(5, softSyncThresholdSeconds \+ HARD_SYNC_EXTRA_SECONDS\);/, 'hard synchronization should wait until drift exceeds T plus the configured safety window');
assert.match(roomSource, /HARD_SYNC_EXTRA_SECONDS = 10[\s\S]*MAX_SYNC_PLAYBACK_RATE = 3/, 'linear correction must use the requested ten-second window and never exceed 3x');
assert.match(roomSource, /function applySoftSyncRate\(driftSigned, hostRate\)[\s\S]*correctionProgress[\s\S]*MAX_SYNC_PLAYBACK_RATE[\s\S]*线性追赶中/, 'drift between T and H should use bounded linear playback-rate correction');
assert.match(roomSource, /SYNC_UNREADY_TIMEOUT_MS = 30000[\s\S]*SYNC_RECOVERY_STABLE_MS = 15000[\s\S]*function shouldSuspendAutomaticSync\(mediaReady\)/, 'prolonged buffering must suspend correction until playback has remained stable');
assert.match(playerSource, /function isMediaReadyForSync\(\) \{[\s\S]*!lastBufferingState[\s\S]*isMediaReadyForSync: isMediaReadyForSync/, 'waiting and stalled media must feed the synchronization recovery state machine as unready');
assert.match(roomSource, /const autoSyncEnabled = player\.getAutoSyncEnabled\?\.\(\) !== false;[\s\S]*if \(!autoSyncEnabled\) \{[\s\S]*activatePlaylistItem\(target,[\s\S]*setDesiredPlaybackState\?\.\(null\)[\s\S]*remotePlaybackSnapshots\.clearPending\(\)/, 'disabling auto sync must follow source changes before releasing remote timeline intent and queued corrections');
assert.match(roomSource, /socket\.on\("playback_state"[\s\S]*applyRemotePlayback\(playback, \{ fromBroadcast: true \}\)/, 'ordinary Socket playback broadcasts must use the executable source-follow path');
assert.match(roomSource, /function renderPlaylistFromState\(state\)[\s\S]*autoSyncEnabled = player\?\.getAutoSyncEnabled\?\.\(\) !== false[\s\S]*playing: autoSyncEnabled \? state\.playback\?\.playing === true : localWasPlaying[\s\S]*playbackRate: autoSyncEnabled \? state\.playback\?\.playbackRate : localRate/, 'auto-sync off should still follow the room source while preserving local playback and rate intent');
assert.match(roomSource, /loaded && lastRemotePlayback && !isPlaybackController\(\) && player\?\.getAutoSyncEnabled\?\.\(\)/, 'client-side source recovery must not seek to the host while auto-sync is disabled');
assert.match(roomSource, /setPlaybackControlEnabled\?\.\(canControlRoom\(\) \|\| localPlaybackAllowed\)/, 'followers with auto-sync disabled should retain local media controls without gaining room authority');
assert.match(roomSource, /socket\.emit\("room_autoplay_next_update"[\s\S]*enabled: nextEnabled/, 'automatic playlist advance should be updated through authoritative room state');
assert.doesNotMatch(roomSource, /together-see:room:" \+ roomCode/, 'shared automatic playlist advance must not fall back to per-device room preferences');
assert.match(playerSource, /dispatchPlayerEvent\("together-see:auto-sync-change", \{ enabled: autoSyncEnabled \}\)/, 'the player must notify the room when automatic synchronization changes');
assert.match(roomSource, /together-see:auto-sync-change", handleAutoSyncChange/, 'the room must stop or resume synchronization from the player toggle');
assert.match(playerSource, /mediaRecoveryTransition[\s\S]*正在切换兼容播放[\s\S]*video\.addEventListener\("pause"[\s\S]*if \(mediaRecoveryTransition\)/, 'compatibility fallback pauses must remain a loading transition instead of appearing as a user pause');
assert.match(playerSource, /const onCanPlay = function \(\)[\s\S]*updatePlayButton\(\)[\s\S]*已暂停 · 点击播放/, 'a loaded but paused source must expose an unambiguous play button and status');
assert.match(playerSource, /function enterPageFullscreen\(\)[\s\S]*?clearDanmaku\(\);[\s\S]*?document\.body\.appendChild\(shell\)/, 'page fullscreen should discard active danmaku before moving the player DOM');
assert.match(playerSource, /document\.addEventListener\("fullscreenchange"[\s\S]*?clearDanmaku\(\);/, 'native fullscreen changes should discard active danmaku instead of replaying it');
assert.match(mainCss, /fullscreen-danmaku-compose[\s\S]*position:absolute;[\s\S]*left:50%;[\s\S]*transform:translate\(-50%, -50%\)/, 'fullscreen danmaku composer should stay fixed at the player center');
assert.doesNotMatch(roomHtml, /data-sync-drift/, 'the unused visible drift indicator should be removed');
assert.match(roomHtml, /value="2\.5"[\s\S]*data-sync-threshold-input/, 'the visible sync threshold should default to 2.5 seconds');
assert.match(roomSource, /SYNC_THRESHOLD_KEY = "together-see:sync-threshold-seconds:v2";[\s\S]*DEFAULT_SOFT_SYNC_THRESHOLD = 2\.5;/, 'existing browsers should migrate to the friendlier 2.5 second default');
assert.match(mainCss, /\.audit-log\s*\{[\s\S]*max-height:50px;[\s\S]*\.audit-entry[\s\S]*grid-template-columns:38px minmax\(0, 1fr\)/, 'management history should use a compact two-row viewport');
assert.match(indexHtml, /data-home-create-modal[\s\S]*留空则不设置密码[\s\S]*data-home-join-modal/, 'home create and join flows should collect optional details in page-native dialogs');
assert.match(siteSource, /fetch\("\/api\/rooms\/"[\s\S]*method: "POST"[\s\S]*response\.status === 409[\s\S]*同名房间已存在/, 'home creation should use the authoritative create endpoint and show duplicate errors inline');
assert.match(siteSource, /joinDialogForm\?\.addEventListener\("submit", async[\s\S]*fetch\("\/api\/rooms\/"[\s\S]*result\.exists !== true[\s\S]*房间不存在或已经销毁/, 'home joining should verify room existence before navigation');
assert.doesNotMatch(siteSource, /window\.(?:prompt|confirm|alert)\s*\(/, 'home workflows must not use browser-native dialogs');
assert.match(roomSource, /message\.kind === "system"[\s\S]*chat-line[\s\S]*system/, 'system messages should have a separate muted chat presentation');
assert.match(socketSource, /if \(rejection\) \{[\s\S]*ack\?\.\(null\);/, 'rejected joins must acknowledge without protected room state');
assert.match(socketSource, /socket\.on\('danmaku_message'[\s\S]*roomService\.addChat[\s\S]*chat_message_created/, 'danmaku and chat should share one persisted message stream');
assert.match(roomRouteSource, /toAccessSummary[\s\S]*roomCode:[\s\S]*roomName:[\s\S]*security:/, 'HTTP room lookups should expose only access metadata');
assert.match(roomServiceSource, /code: 'room_not_found'[\s\S]*if \(!room\) return \{ code: 'room_not_found'/, 'Socket admission should reject missing rooms instead of creating them');
assert.match(roomSource, /payload\?\.code === "room_not_found"[\s\S]*revokeRoomAccess\("missing"/, 'direct missing-room links should stay behind an explanatory access gate');
assert.match(playerSource, /together-see:playback-user-action/, 'player user actions should claim collaborative playback control');
assert.match(playerSource, /function togglePlay\(\)[\s\S]*if \(!ensurePlaybackControl\(\)\) return;[\s\S]*video\.play\(\)/, 'read-only members must be rejected before local play or pause changes');
assert.match(playerSource, /function cycleRate\(\) \{\s*if \(!ensurePlaybackControl\(\)\) return;/, 'read-only members must not change playback rate locally');
assert.match(playerSource, /function seekFromEvent\(event\) \{\s*if \(!ensurePlaybackControl\(\)\) return;/, 'read-only members must not seek locally');
assert.match(playerSource, /syncPlaybackPending && video\.paused[\s\S]*together-see:sync-playback-resumed/, 'a blocked mobile autoplay should expose a local-only resume gesture');
assert.match(roomSource, /createPlaybackSnapshotQueue\(\)[\s\S]*createOperationTracker\(\)/, 'room playback should use the tested snapshot and async-operation state machines');
assert.match(roomSource, /restorePlayback[\s\S]*allowSelf: restorePlayback[\s\S]*allowAuthority: restorePlayback/, 'a legitimate reconnect should restore the controller from the authoritative snapshot');
assert.doesNotMatch(roomSource, /pendingRemotePlaybackForReady/, 'legacy unversioned pending playback must not return');
assert.match(roomSource, /!authoritativePlayback\.playing && drift > Math\.min\(1, softSyncThresholdSeconds\)[\s\S]*seekToHostPlayback\(authoritativePlayback, "paused", snapshot\)/, 'paused playback drift should not remain below the hard sync threshold');
assert.match(roomSource, /function getCurrentPlaybackAuthorityId\(\)/, 'room should resolve collaborative playback authority centrally');
assert.match(roomSource, /roomState\.members\.some\(function \(member\) \{ return member\.id === updatedBy; \}\)/, 'offline collaborators should release playback authority back to the host');
assert.match(roomSource, /const buffering = roomState\.playback\?\.buffering === true \|\| lastRemotePlayback\?\.buffering === true;[\s\S]*authorityOnline && \(buffering \|\| leaseUntil >/, 'an online buffering authority must retain the ability to publish recovery after the ordinary lease deadline');
assert.match(roomSource, /function isCurrentPlaybackAuthority\(\)[\s\S]*getCurrentPlaybackAuthorityId\(\) === myMemberId/, 'everyone mode should track the resolved playback controller');
assert.match(roomSource, /applyingRemotePlayback && !options\?\.userAction/, 'explicit user playback actions should bypass the remote-event guard');
assert.match(roomSource, /together-see:playback-user-action[\s\S]*event\.detail\.action[\s\S]*emitPlaybackState\(\{ force: true, userAction: true, action: action \}\)/, 'player user actions should carry an explicit collaborative-control intent');
assert.match(roomSource, /options\?\.periodic && !isCurrentPlaybackAuthority\(\)/, 'only the current controller may emit periodic playback state');
assert.match(roomSource, /options\?\.periodic && !health\.ready/, 'buffering clients must not publish periodic authoritative progress');
assert.match(roomSource, /function predictHostTime\(playback\)[\s\S]*playback\.playing && playback\.buffering !== true/, 'the shared room clock must freeze while the current authority is buffering');
assert.match(roomSource, /function handlePlayerBufferingChange\(event\)[\s\S]*publishLocalBufferingState\(true\)[\s\S]*BUFFERING_PUBLISH_DELAY_MS[\s\S]*publishLocalBufferingState\(false\)/, 'the current authority should publish sustained buffering with a debounced start and immediate recovery');
assert.match(roomSource, /BUFFERING_ACK_TIMEOUT_MS = 5000[\s\S]*createAckSingleFlight[\s\S]*function publishLocalBufferingState\(buffering\)[\s\S]*localBufferingAckFlight\.begin[\s\S]*localBufferingAckFlight\.settle/, 'buffering start and recovery must serialize through bounded authoritative acknowledgements');
assert.match(roomSource, /function resetLocalBufferingPublishState\(\)[\s\S]*localBufferingAckFlight\.reset\(\)[\s\S]*socket\.on\("connect"[\s\S]*resetLocalBufferingPublishState\(\)[\s\S]*socket\.on\("disconnect"[\s\S]*resetLocalBufferingPublishState\(\)/, 'socket lifecycle changes must invalidate pending buffering acknowledgements');
assert.match(roomSource, /authoritativePlayback\.buffering === true[\s\S]*playing: false[\s\S]*setDesiredPlaybackState/, 'followers should pause locally while preserving the authority playback intent during buffering');
assert.match(roomSource, /baseRevision: baseRevision[\s\S]*ready: action === "source"/, 'playback updates should include a base revision, action and client readiness');
assert.match(roomSource, /function handlePlaybackUpdateAck\(state, baseRevision, requestContext\)[\s\S]*remotePlaybackSnapshots\.observe\(playback\)[\s\S]*!observed\.accepted[\s\S]*roomState\.playback = authoritativePlayback/, 'out-of-order playback acknowledgements must pass the revision queue before replacing local authority state');
assert.match(roomSource, /function handlePlaybackUpdateAck\(state, baseRevision, requestContext\)[\s\S]*sourceIntentGate\.shouldIgnore\(playback,[\s\S]*requestContext: requestContext/, 'playback acknowledgements must be tied to the source generation that emitted them');
assert.match(roomSource, /pendingTimeoutMs[\s\S]*expiresAt: now\(\) \+ pendingTimeoutMs[\s\S]*function reset\(\)/, 'a lost source ACK must have bounded timeout and reconnect reset paths');
assert.match(roomSource, /sourceIntentGate\.begin\(targetSourceId, baseRevision, desiredPlaying\)[\s\S]*playing: desiredPlaying/, 'source changes must publish the autoplay intent through the authoritative playback patch');
assert.match(roomSource, /player\.loadSource\(payload, \{[\s\S]*playWhenReady: desiredPlaying/, 'source activation must carry its real playback intent into the media load generation');
assert.match(roomSource, /player\?\.loadSource && sourceActuallyChanged/, 'repeated activation of the current loaded source must not call loadSource again');
assert.match(playerSource, /const requestedPlaybackIntent = createLoadPlaybackIntent\(source, options\);[\s\S]*bindMediaRecoveryIntent\(requestedPlaybackIntent, loadToken\)/, 'each media generation must retain whether it should really play or remain paused');
assert.match(playerSource, /function markSourcePlayable\(source, token\)[\s\S]*restoreMediaRecoveryIntent\(source, token\)[\s\S]*together-see:player-source-ready/, 'the player must apply play or pause intent before publishing source readiness');
assert.match(playerSource, /浏览器需要一次点按才能继续播放/, 'autoplay rejection must expose a local gesture state');
assert.match(roomSource, /action !== "source" && \(!authoritativeSourceId \|\| domSourceId !== authoritativeSourceId \|\| mediaSourceId !== authoritativeSourceId\)\) return(?: false)?;[\s\S]*activeSourceId: patchSourceId/, 'old media actions must not publish until DOM, media and server authority agree on the source');
assert.match(socketSource, /ALLOWED_PLAYBACK_ACTIONS[\s\S]*baseRevision[\s\S]*clientReady/, 'the server should validate versioned playback intents');
assert.match(roomServiceSource, /PLAYBACK_PERIODIC_BACKWARD_TOLERANCE_SECONDS[\s\S]*currentPlaybackAuthority[\s\S]*action === 'periodic'/, 'the room service should reject stale periodic progress and expire collaborative authority leases');
assert.match(roomSource, /function canManageRoom\(\) \{\s*return roomAdminAuthorizationKnown && roomAdminAuthorized;\s*\}/, 'management UI must use the private server-confirmed creator permission');
assert.match(roomSource, /socket\.on\("room_permissions"[\s\S]*roomAdminAuthorized = payload\.canManage === true/, 'the room page should consume server-authoritative management permission');
assert.match(roomSource, /roomAdminIsCreator = payload\.isCreator === true/, 'private permissions should distinguish the original creator from an automatic room manager');
assert.match(roomSource, /function maybeRecoverStoredAdmin\(options\)[\s\S]*recoverRoomAdmin\(roomAdminRecoveryCode/, 'a creator browser should recover management automatically when its active token is missing');
assert.match(roomHtml, /data-room-admin-status>正在验证[\s\S]*data-room-admin-status-description/, 'room settings should explain whether management is verified, recoverable, or read-only');
assert.match(roomSource, /if \(payload\.recovered\)[\s\S]*joinCurrentRoom\(roomPassword/, 'admin recovery should always perform an idempotent rejoin for the current socket');
assert.match(roomSource, /attemptId: attemptId[\s\S]*payload\?\.attemptId && payload\.attemptId !== currentJoinAttemptId/, 'late join errors must be ignored through a correlated attempt id');
assert.match(roomSource, /function scheduleFreshMemberIdentityJoin\(message\)[\s\S]*identityFallbackAttempted[\s\S]*saveRoomMemberReconnectToken\(""\)[\s\S]*saveRoomAdminToken\(""\)/, 'fresh identity fallback must run once and clear both stale member and management credentials');
assert.match(roomSource, /payload\?\.code === "admin_member_mismatch"[\s\S]*"creator_recovery"/, 'management identity mismatches should prefer the recovery gate instead of repeatedly replacing member ids');
assert.match(roomSource, /payload\?\.code === "reconnect_token_invalid"[\s\S]*scheduleFreshMemberIdentityJoin/, 'plain reconnect token failures should use the bounded fresh-member path');
assert.match(roomSource, /if \(payload\.delegated\)[\s\S]*已接管房间管理/, 'an automatic successor should receive a visible management takeover confirmation');
assert.match(roomSource, /MEMBER_RECONNECT_TOKEN_KEY[\s\S]*reconnectToken: roomMemberReconnectToken/, 'member reconnects should present a room-scoped secret instead of trusting the public member id');
assert.match(roomSource, /window\.sessionStorage\.getItem\(MEMBER_RECONNECT_TOKEN_KEY\)/, 'tab-scoped member identities should keep reconnect credentials separate');
assert.match(roomSource, /window\.sessionStorage\.getItem\(key\)[\s\S]*window\.sessionStorage\.setItem\(key, next\)/, 'separate tabs should not silently replace one shared member socket');
assert.match(roomSource, /const CLIENT_ID_KEY = "together-see:client-id";[\s\S]*const clientId = getOrCreateClientId\(\);/, 'anonymous clients should initialize one device session value per page load');
assert.match(roomSource, /function getOrCreateClientId\(\)[\s\S]*window\.localStorage\.getItem\(CLIENT_ID_KEY\)[\s\S]*window\.localStorage\.setItem\(CLIENT_ID_KEY, next\)[\s\S]*catch \(error\) \{\s*return createClientId\(\);/, 'device session ids should persist locally and fall back to the current page when storage is unavailable');
assert.match(roomSource, /function createClientId\(\)[\s\S]*randomUUID[\s\S]*getRandomValues[\s\S]*0x40[\s\S]*0x80/, 'device session ids should use UUID generation with a random UUID v4 fallback');
assert.match(roomSource, /socket\.emit\("join_room", \{[\s\S]*clientId: clientId,[\s\S]*memberId: myMemberId/, 'join admission should carry clientId separately from the tab-scoped memberId');
assert.doesNotMatch(roomSource, /params\.(?:set|append)\([^\n]*clientId|URLSearchParams\([^\n]*clientId/, 'device session ids must never be added to room URLs');
assert.match(credentialSource, /function saveActiveToken\(adminToken\)[\s\S]*writeVerified\(session, keys\.activeToken, cleanToken\)/, 'active management credentials should be scoped to one browser tab');
assert.match(roomSource, /function saveRoomPassword\(password\)[\s\S]*window\.sessionStorage\.setItem\(ROOM_PASSWORD_KEY, roomPassword\)/, 'room passwords should not be shared with unrelated browser tabs');
assert.match(roomSource, /socket\.emit\("chat_message"[\s\S]*createdMessage\.id !== previousMessageId[\s\S]*input\.value = ""/, 'chat input should clear only after server acceptance');
assert.match(roomSource, /socket\.emit\("danmaku_message"[\s\S]*createdMessage\.id !== previousMessageId[\s\S]*danmakuInput\.value = ""/, 'danmaku input should clear only after server acceptance');
assert.match(roomSource, /socket\.on\("room_member_token"[\s\S]*saveRoomMemberReconnectToken/, 'new member reconnect secrets should be stored for later network recovery');
assert.match(roomSource, /function addRemotePlaylistItem\(payload\)[\s\S]*state\.playlist\.some[\s\S]*resolve\(state\)/, 'remote playlist items should be shown as successful only after server acceptance');
assert.match(roomSource, /const payload = await parseVideoLink\(rawLink\);[\s\S]*await addRemotePlaylistItem\(payload\)[\s\S]*input\.value = ""/, 'link submission should not optimistically mutate the playlist before the room accepts it');
assert.doesNotMatch(roomSource, /const payload = await parseVideoLink\(rawLink\);\s*addPlaylistPayload\(payload\)/, 'rejected link additions must not leave a local ghost item');
assert.match(roomSource, /function trapModalFocus\(event, modal\)/, 'page-native dialogs should keep keyboard focus inside the active modal');
assert.match(roomSource, /function hasNewAuditEntry\(state, previousAuditId, action, targetId\)/, 'sensitive management actions should confirm a new server audit entry before showing success');
assert.match(mainCss, /\.room-security-content\s*\{[\s\S]*max-height:[\s\S]*overflow-y:auto/, 'expanded room settings should scroll instead of being clipped on short screens');
assert.match(mainCss, /height:\s*100dvh\s*!important/, 'page fullscreen should follow the mobile dynamic viewport');
assert.match(siteSource, /replace\(\/\[\?#&=\\\\\/:;%\]\/g, ""\)[\s\S]*\.slice\(0, 64\)[\s\S]*\.trim\(\)/, 'home room names should use the same normalization as the room page and server');
assert.match(siteSource, /result\.room\?\.roomCode \|\| roomName/, 'home navigation and credentials should use the canonical server room code');
assert.match(indexHtml, /assets\/js\/credentials\.js\?v=20260904-bilibili-fallback[\s\S]*assets\/js\/site\.js\?v=20260904-bilibili-fallback/, 'home should load the credential lifecycle before creation code');
assert.match(roomHtml, /assets\/js\/credentials\.js\?v=20260904-bilibili-fallback[\s\S]*assets\/js\/room\.js\?v=20260904-bilibili-fallback/, 'room should load the credential lifecycle before admission code');
assert.match(credentialSource, /function stageCreated\(adminToken, recoveryCode\)[\s\S]*savePending\(adminToken, recoveryCode\)[\s\S]*sessionVerified/, 'HTTP creation should retain a read-back-checked pending fallback');
assert.match(credentialSource, /function finalizeCreated\(adminToken, recoveryCode\)[\s\S]*matchesPending[\s\S]*clearPending\(\)/, 'pending creation credentials should clear only after successful room admission');
assert.match(siteSource, /goRoom\(canonicalRoomName, \{ created: true \}\)/, 'new room navigation should carry a non-secret creator-admission marker');
assert.match(roomSource, /payload\?\.code === "creator_pending"[\s\S]*reloadPendingCreationCredentials\(\)[\s\S]*"creator_recovery"/, 'creator_pending should reload durable credentials and stop on an actionable recovery gate');
assert.match(roomHtml, /data-room-creator-recovery-fields hidden[\s\S]*data-room-creator-recovery-input[\s\S]*data-room-access-home>返回首页/, 'the creator admission gate should expose recovery and a home escape route');
assert.match(siteSource, /new AbortController\(\)[\s\S]*signal: controller\.signal/, 'closing a home dialog should be able to abort its pending request');
assert.doesNotMatch(roomSource, /player\.video\.addEventListener\("(?:play|pause|seeked)", emitPlaybackState\)/, 'remote media events must not steal collaborative playback authority');
assert.doesNotMatch(roomSource, /useProxy:\s*payload\.sourceType === "hls" \? true/, 'HLS should try direct playback before the allowlisted proxy fallback');
assert.doesNotMatch(roomSource, /解析接口异常，已按直接视频源处理/, 'the frontend must not bypass parser security failures with a raw URL');
assert.match(playerSource, /source\?\.refererUrl[\s\S]*source\?\.pageUrl/, 'media proxy requests should prefer the discovered nested-page Referer');

console.log('player recovery verification passed');
