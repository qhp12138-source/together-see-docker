import assert from 'node:assert/strict';

const {
  diagnosticFingerprint,
  logStructuredEvent,
} = await import(`../dist/utils/structured-log.js?verify=${Date.now()}`);

const sentinels = {
  roomCode: 'OBSERVABILITY-ROOM-SECRET',
  memberId: 'member-observability-secret',
  token: 'proxy-token-observability-secret',
  url: 'https://media.example.invalid/private/video.mp4?token=secret',
  ip: '203.0.113.77',
  userAgent: 'Secret Browser Full User Agent',
};
const output = [];
const original = { log: console.log, warn: console.warn, error: console.error };
console.log = (line) => output.push(String(line));
console.warn = (line) => output.push(String(line));
console.error = (line) => output.push(String(line));

try {
  const common = {
    roomFingerprint: diagnosticFingerprint('room', sentinels.roomCode),
    actorFingerprint: diagnosticFingerprint('actor', sentinels.memberId),
    sourceFingerprint: diagnosticFingerprint('source', sentinels.url),
    clientType: 'automation',
    decision: 'rejected',
    ...sentinels,
  };
  logStructuredEvent('playback_decision', {
    ...common,
    action: 'seek',
    reason: 'stale_revision',
    baseRevision: 3,
    currentRevision: 4,
    nextRevision: 4,
    sourceMatch: false,
    clientReady: true,
    clientSeeking: false,
    leaseOwnerChanged: false,
    deltaBucket: '>10s',
  }, { level: 'warn', suppressKey: 'playback-sentinel', suppressWindowMs: 10 });
  logStructuredEvent('playback_decision', {
    ...common,
    action: 'seek',
    reason: 'stale_revision',
  }, { level: 'warn', suppressKey: 'playback-sentinel', suppressWindowMs: 10 });
  logStructuredEvent('playlist_decision', {
    ...common,
    action: 'add',
    reason: 'invalid_payload',
    sourceType: sentinels.token,
    countBefore: 1,
    countAfter: 1,
    activeSourceChanged: false,
  });
  logStructuredEvent('proxy_grant_decision', {
    ...common,
    routeName: 'media',
    reason: 'parse_source_denied',
    playlistMatched: false,
    grantMode: 'none',
    revalidationAttempted: false,
  });
  logStructuredEvent('proxy_fetch_decision', {
    ...common,
    routeName: 'media',
    reason: 'invalid_or_expired_grant',
    statusClass: '4xx',
    elapsedBucket: '<25ms',
  });
  logStructuredEvent('playback_decision', {
    ...common,
    action: 'periodic',
    decision: 'accepted',
    reason: 'timeline_reanchored',
    baseRevision: 4,
    currentRevision: 4,
    nextRevision: 5,
    sourceMatch: true,
    clientReady: true,
    clientSeeking: false,
    leaseOwnerChanged: false,
    deltaBucket: '-10--2.5s',
  });
  logStructuredEvent('proxy_fetch_decision', {
    ...common,
    routeName: 'media',
    reason: 'client_cancelled',
    statusClass: '4xx',
    elapsedBucket: '500ms+',
  });
  logStructuredEvent('room_store_decision', {
    ...common,
    operation: 'write',
    reason: 'write_room',
    errorCode: 'room_store_write_failed',
    generation: 7,
    generationLag: 1,
    bytesBucket: '1-16MiB',
    elapsedBucket: '25-100ms',
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
} finally {
  console.log = original.log;
  console.warn = original.warn;
  console.error = original.error;
}

assert.equal(output.length, 8, 'the duplicate rejection should emit one bounded summary after its aggregation window');
const records = output.map((line) => JSON.parse(line));
assert.deepEqual(records.map((record) => record.event), [
  'playback_decision',
  'playlist_decision',
  'proxy_grant_decision',
  'proxy_fetch_decision',
  'playback_decision',
  'proxy_fetch_decision',
  'room_store_decision',
  'playback_decision',
]);
assert.equal(records.at(-1).suppressedCount, 1, 'the bounded summary should retain the number of suppressed events');
assert.equal(Object.hasOwn(records[1], 'sourceType'), false, 'approved fields must still reject unapproved runtime values');
assert.equal(records[4].reason, 'timeline_reanchored', 'accepted host re-anchors must remain visible after structured-log sanitization');
assert.equal(records[5].reason, 'client_cancelled', 'browser-cancelled proxy streams must remain distinguishable from upstream timeouts');
const forbiddenKeys = ['roomCode', 'memberId', 'token', 'url', 'ip', 'userAgent', 'payload', 'message', 'error'];
for (const record of records) {
  for (const key of forbiddenKeys) assert.equal(Object.hasOwn(record, key), false, `${record.event} must reject ${key}`);
}
const combined = output.join('\n');
for (const value of Object.values(sentinels)) {
  assert.equal(combined.includes(value), false, 'structured diagnostics must never include raw sentinels');
}
for (const record of records.slice(0, 6)) {
  if (record.roomFingerprint) assert.match(record.roomFingerprint, /^[a-f0-9]{12}$/);
  if (record.actorFingerprint) assert.match(record.actorFingerprint, /^[a-f0-9]{12}$/);
  if (record.sourceFingerprint) assert.match(record.sourceFingerprint, /^[a-f0-9]{12}$/);
}

console.log('privacy-safe observability verification passed');
