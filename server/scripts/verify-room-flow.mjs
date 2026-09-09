import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

process.env.ROOM_STORE_FILE = process.env.VERIFY_ROOM_FLOW_STORE_FILE || `data/verify-room-flow-${Date.now()}.json`;
process.env.ROOM_STORE_WRITE_DELAY_MS = '10';
process.env.ROOM_MAX_MEMBERS = '20';
process.env.ROOM_MAX_PLAYLIST_ITEMS = '2';
process.env.ROOM_EMPTY_TTL_MS = '60000';
process.env.ROOM_RECONNECT_GRACE_MS = '5000';
process.env.ROOM_HOST_RECONNECT_GRACE_MS = '1000';

const legacyRoomCode = `LEGACY${Date.now().toString(36).slice(-6).toUpperCase()}`;
const legacyPassword = 'legacy  password';
const legacyPasswordSalt = 'legacy-password-salt';
const legacyPasswordHash = crypto.createHash('sha256').update(`${legacyPasswordSalt}:${legacyPassword}`).digest('hex');
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(process.env.ROOM_STORE_FILE, JSON.stringify({
  version: 1,
  savedAt: Date.now(),
  rooms: [{
    roomCode: legacyRoomCode,
    roomName: 'Legacy Snapshot',
    hostMemberId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    playlist: [{
      id: 'legacy-private-video',
      title: 'Legacy Private Video',
      pageUrl: 'http://127.0.0.1/private.mp4',
      sourceUrl: 'http://127.0.0.1/private.mp4',
      sourceType: 'video',
      createdAt: Date.now(),
    }],
    playback: {},
    chat: [],
    audit: [],
    security: { locked: false, hasPassword: false },
    kickedMembers: {},
    adminTokenHash: '',
    passwordHash: legacyPasswordHash,
    passwordSalt: legacyPasswordSalt,
  }],
}, null, 2));

const { flushRoomPersistence, roomService } = await import('../dist/services/room.service.js');
const { sanitizePlaylistItem } = await import('../dist/sockets/index.js');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const roomCode = `FLOW${Date.now().toString(36).slice(-6).toUpperCase()}`;
const roomPassword = `pw-${Date.now().toString(36)}`;
const missingRoomCode = `MISSING${Date.now().toString(36).slice(-6).toUpperCase()}`;

assert.equal(
  (await roomService.getJoinRejection(missingRoomCode, 'missing-member'))?.code,
  'room_not_found',
  'joining a missing room must not create it implicitly',
);

assert.equal(
  roomService.getRoom(legacyRoomCode)?.security.controlPolicy,
  'host_only',
  'legacy snapshots without controlPolicy should default to host_only',
);
assert.equal(roomService.getRoom(legacyRoomCode)?.autoPlayNext, false, 'legacy snapshots without autoPlayNext should remain paused between items');
assert.equal(roomService.getRoom(legacyRoomCode)?.playlist.length, 0, 'unsafe media URLs in legacy snapshots must be discarded');
assert.equal(await roomService.verifyPassword(legacyRoomCode, legacyPassword), true, 'legacy SHA-256 password snapshots should remain usable');
assert.equal(await roomService.verifyPassword(legacyRoomCode, 'legacy password'), false, 'password whitespace must remain consistent across entry paths');
roomService.joinRoom({ roomCode: legacyRoomCode, memberId: 'legacy-creator', socketId: 'socket-legacy-creator', name: 'Legacy Creator' });
const legacyCredentials = roomService.claimPendingAdminCredentials(legacyRoomCode, 'legacy-creator');
assert.ok(legacyCredentials?.adminToken, 'legacy snapshots without creatorMemberId should still bind management credentials to their first host');
assert.equal(roomService.isCreatorAdmin(legacyRoomCode, 'legacy-creator', legacyCredentials.adminToken), true);

const guardedRoomCode = `GUARD${Date.now().toString(36).slice(-6).toUpperCase()}`;
const guardedCreation = roomService.createRoom(guardedRoomCode, 'Creator Admission Verification');
assert.ok(guardedCreation?.credentials.adminToken, 'explicit room creation should issue an admin token immediately');
assert.ok(guardedCreation?.credentials.recoveryCode, 'explicit room creation should issue a recovery code immediately');
assert.match(guardedCreation.credentials.recoveryCode, /^(?:[A-HJ-NP-Z2-9]{5}-){4}[A-HJ-NP-Z2-9]{5}$/, 'server-issued recovery codes should be unambiguous and route-compatible');
assert.deepEqual(
  roomService.getJoinDiagnostic(guardedRoomCode),
  { creatorPending: true, adminTokenValid: false },
  'join diagnostics should distinguish a missing creator token without exposing it',
);
assert.deepEqual(
  roomService.getJoinDiagnostic(guardedRoomCode, guardedCreation.credentials.adminToken),
  { creatorPending: true, adminTokenValid: true },
  'join diagnostics should identify a valid supplied creator token without returning secret data',
);
assert.equal(
  (await roomService.getJoinRejection(guardedRoomCode, 'race-attacker'))?.code,
  'creator_pending',
  'a non-creator must not claim an explicitly created room before its creator joins',
);
assert.equal(roomService.getRoom(guardedRoomCode)?.members.length, 0, 'a rejected first join must not create a host');
assert.equal(
  await roomService.getJoinRejection(guardedRoomCode, 'guarded-host', undefined, guardedCreation.credentials.adminToken),
  null,
);
const guardedState = roomService.joinRoom({
  roomCode: guardedRoomCode,
  memberId: 'guarded-host',
  socketId: 'socket-guarded-host',
  name: 'Guarded Host',
  adminToken: guardedCreation.credentials.adminToken,
});
assert.equal(guardedState.hostMemberId, 'guarded-host');
assert.ok(guardedState.members.every((member) => !Object.hasOwn(member, 'socketId')), 'public room members must not expose internal socket ids');
assert.equal(roomService.isCreatorAdmin(guardedRoomCode, 'guarded-host', guardedCreation.credentials.adminToken), true, 'the first management join should bind the creator identity');
assert.equal(await roomService.getJoinRejection(guardedRoomCode, 'guarded-guest'), null, 'normal joins should open after the creator is admitted');
assert.equal(
  guardedState.audit.some((entry) => entry.action === 'host_reclaimed'),
  false,
  'the initial creator binding must not be recorded as a host reclaim',
);

const adminFailoverRoomCode = `ADMFAIL${Date.now().toString(36).slice(-5).toUpperCase()}`;
const adminFailoverCreation = roomService.createRoom(adminFailoverRoomCode, 'Admin Failover Verification');
assert.ok(adminFailoverCreation);
roomService.joinRoom({
  roomCode: adminFailoverRoomCode,
  memberId: 'admin-failover-creator',
  socketId: 'socket-admin-failover-creator',
  name: 'Original Creator',
  adminToken: adminFailoverCreation.credentials.adminToken,
});
roomService.joinRoom({
  roomCode: adminFailoverRoomCode,
  memberId: 'admin-failover-guest',
  socketId: 'socket-admin-failover-guest',
  name: 'Successor',
});
const adminDeparture = roomService.leaveBySocket('socket-admin-failover-creator')[0];
assert.equal(adminDeparture?.departedHostId, 'admin-failover-creator');
assert.equal(adminDeparture?.departedAdminId, 'admin-failover-creator');
assert.equal(
  roomService.finalizeAdminDeparture(adminFailoverRoomCode, 'admin-failover-creator', adminDeparture.reconnectUntil - 1),
  null,
  'management must remain reserved for the creator throughout the member reconnect grace',
);
const playbackFailoverState = roomService.finalizeHostDeparture(
  adminFailoverRoomCode,
  'admin-failover-creator',
  adminDeparture.reconnectUntil - 5000 + 1000 + 1,
);
assert.equal(playbackFailoverState?.hostMemberId, 'admin-failover-guest', 'playback should fail over before room management');
assert.equal(roomService.isCreatorAdmin(adminFailoverRoomCode, 'admin-failover-guest', ''), false);
const adminFailover = roomService.finalizeAdminDeparture(
  adminFailoverRoomCode,
  'admin-failover-creator',
  adminDeparture.reconnectUntil + 1,
);
assert.ok(adminFailover?.adminToken, 'the online host should receive a fresh active management token after the full grace expires');
assert.equal(adminFailover.memberId, 'admin-failover-guest');
assert.equal(roomService.isCreatorAdmin(adminFailoverRoomCode, 'admin-failover-guest', adminFailover.adminToken), true);
assert.equal(roomService.isAdmin(adminFailoverRoomCode, adminFailoverCreation.credentials.adminToken), false, 'management takeover must invalidate the previous active token');
assert.equal(adminFailover.state.audit.at(-1)?.action, 'admin_failed_over');
const reclaimedAdmin = roomService.recoverAdminToken(
  adminFailoverRoomCode,
  adminFailoverCreation.credentials.recoveryCode,
  { memberId: 'admin-failover-creator', memberName: 'Original Creator', socketId: 'socket-admin-failover-return' },
);
assert.ok(reclaimedAdmin?.adminToken, 'the original recovery code must reclaim management from an automatic successor');
assert.equal(roomService.isCreatorAdmin(adminFailoverRoomCode, 'admin-failover-creator', reclaimedAdmin.adminToken), true);
assert.equal(roomService.isAdmin(adminFailoverRoomCode, adminFailover.adminToken), false, 'creator recovery must revoke the delegated manager token');
assert.ok(reclaimedAdmin.state.audit.some((entry) => entry.action === 'admin_reclaimed'));
assert.equal(reclaimedAdmin.state.hostMemberId, 'admin-failover-creator', 'creator recovery should also reclaim automatically failed-over playback control');

const recoveryBoundRoomCode = `RECOVER${Date.now().toString(36).slice(-6).toUpperCase()}`;
const recoveryBoundCreation = roomService.createRoom(recoveryBoundRoomCode, 'Recovery Bound Creator');
assert.ok(recoveryBoundCreation);
const recoveryBoundCredentials = roomService.recoverAdminToken(
  recoveryBoundRoomCode,
  recoveryBoundCreation.credentials.recoveryCode,
  { memberId: 'recovery-bound-creator', memberName: 'Recovery Creator', socketId: 'socket-recovery-bound-creator' },
);
assert.ok(recoveryBoundCredentials?.adminToken, 'recovering management before admission should bind the requested fresh creator identity');
assert.equal(
  (await roomService.getJoinRejection(recoveryBoundRoomCode, 'recovery-bound-other', undefined, recoveryBoundCredentials.adminToken))?.code,
  'admin_member_mismatch',
  'a recovered management token must not be reused under another member identity',
);
assert.equal(await roomService.getJoinRejection(recoveryBoundRoomCode, 'recovery-bound-creator', undefined, recoveryBoundCredentials.adminToken), null);
roomService.joinRoom({
  roomCode: recoveryBoundRoomCode,
  memberId: 'recovery-bound-creator',
  socketId: 'socket-recovery-bound-creator',
  name: 'Recovery Creator',
  adminToken: recoveryBoundCredentials.adminToken,
});
assert.equal(roomService.isCreatorAdmin(recoveryBoundRoomCode, 'recovery-bound-creator', recoveryBoundCredentials.adminToken), true);

const recoveryRebindRoomCode = `REBIND${Date.now().toString(36).slice(-6).toUpperCase()}`;
const recoveryRebindCreation = roomService.createRoom(recoveryRebindRoomCode, 'Recovery Rebind Creator');
assert.ok(recoveryRebindCreation);
roomService.joinRoom({
  roomCode: recoveryRebindRoomCode,
  memberId: 'recovery-old-creator',
  socketId: 'socket-recovery-old-creator',
  name: 'Old Recovery Creator',
  adminToken: recoveryRebindCreation.credentials.adminToken,
});
roomService.leaveBySocket('socket-recovery-old-creator');
const reboundCredentials = roomService.recoverAdminToken(
  recoveryRebindRoomCode,
  recoveryRebindCreation.credentials.recoveryCode,
  { memberId: 'recovery-new-creator', memberName: 'New Recovery Creator', socketId: 'socket-recovery-new-creator' },
);
assert.ok(reboundCredentials, 'a recovery code should rebind management after the old creator disconnects');
assert.equal(reboundCredentials.state.hostMemberId, 'recovery-new-creator', 'a reserved creator-host identity should move to the recovered identity');
assert.equal(
  await roomService.getJoinRejection(recoveryRebindRoomCode, 'recovery-new-creator', undefined, reboundCredentials.adminToken, undefined, 'socket-recovery-new-creator'),
  null,
);
const reboundState = roomService.joinRoom({
  roomCode: recoveryRebindRoomCode,
  memberId: 'recovery-new-creator',
  socketId: 'socket-recovery-new-creator',
  name: 'New Recovery Creator',
  adminToken: reboundCredentials.adminToken,
});
assert.equal(reboundState.hostMemberId, 'recovery-new-creator');
assert.equal(reboundState.members.find((member) => member.id === 'recovery-new-creator')?.role, 'host');
assert.equal(roomService.isCreatorAdmin(recoveryRebindRoomCode, 'recovery-old-creator', recoveryRebindCreation.credentials.adminToken), false);
assert.equal(
  await roomService.getJoinRejection(recoveryRebindRoomCode, 'recovery-old-creator'),
  null,
  'the old identity should no longer be trapped by a stale reconnect reservation',
);

roomService.getOrCreateRoom(roomCode, 'Room Flow Verification');

const hostState = roomService.joinRoom({
  roomCode,
  roomName: 'Room Flow Verification',
  memberId: 'host-a',
  socketId: 'socket-host-a',
  name: 'Alice',
});
assert.equal(hostState.hostMemberId, 'host-a');
assert.equal(hostState.members[0]?.role, 'host');

const credentials = roomService.claimPendingAdminCredentials(roomCode, 'host-a');
assert.ok(credentials?.adminToken, 'room creator should receive an admin token');
assert.ok(credentials?.recoveryCode, 'room creator should receive an admin recovery code');
let adminToken = credentials.adminToken;
let recoveryCode = credentials.recoveryCode;
assert.ok(adminToken, 'room creator should receive an admin token');
assert.equal(roomService.isAdmin(roomCode, adminToken), true);

const recovered = roomService.recoverAdminToken(roomCode, recoveryCode, { memberId: 'host-a', memberName: 'Alice', socketId: 'socket-host-a' });
assert.ok(recovered?.adminToken, 'recovery code should issue a new admin token');
assert.ok(recovered?.recoveryCode, 'recovery should rotate the recovery code');
assert.equal(recovered.state.audit.at(-1)?.action, 'admin_token_recovered');
assert.equal(roomService.isAdmin(roomCode, adminToken), false, 'old admin token should be invalid after recovery');
assert.equal(roomService.recoverAdminToken(roomCode, recoveryCode), null, 'old recovery code should be invalid after rotation');
adminToken = recovered.adminToken;
recoveryCode = recovered.recoveryCode;
assert.equal(roomService.isAdmin(roomCode, adminToken), true, 'new admin token should be valid after recovery');
assert.equal(roomService.isCreatorAdmin(roomCode, 'host-a', adminToken), true, 'recovered management credentials should stay bound to the creator member');

const guestState = roomService.joinRoom({
  roomCode,
  memberId: 'guest-b',
  socketId: 'socket-guest-b',
  name: 'Bob',
  clientId: 'device-guest-b',
});
assert.equal(guestState.members.length, 2);
assert.equal(guestState.members.find((member) => member.id === 'guest-b')?.role, 'follower');
assert.equal(guestState.security.controlPolicy, 'host_only');
assert.equal(roomService.canControlRoom(roomCode, 'host-a'), true);
assert.equal(roomService.canControlRoom(roomCode, 'guest-b'), false);
assert.equal(guestState.autoPlayNext, false, 'new rooms should keep automatic playlist advance disabled by default');
assert.equal(
  (await roomService.getJoinRejection(roomCode, 'guest-b', undefined, adminToken))?.code,
  'admin_member_mismatch',
  'an admin token must not replace another member reconnect credential',
);
assert.equal(
  (await roomService.getJoinRejection(roomCode, 'host-a', undefined, adminToken, undefined, 'socket-host-takeover'))?.code,
  'member_online_elsewhere',
  'an admin token must not replace the online creator socket',
);
assert.equal(
  await roomService.getJoinRejection(roomCode, 'host-a', undefined, adminToken, undefined, 'socket-host-a'),
  null,
  'the currently bound socket may perform an idempotent join',
);

let state;

state = roomService.addChat(roomCode, {
  kind: 'system',
  senderId: 'system',
  senderName: '系统',
  text: 'Bob 加入了房间',
  memberId: 'guest-b',
  systemEvent: 'member_joined',
});
state = roomService.addChat(roomCode, {
  kind: 'user',
  senderId: 'guest-b',
  senderName: 'Bob',
  text: 'message sent before rename',
});
state = roomService.setControlPolicy(roomCode, 'host_only', { memberId: 'guest-b', memberName: 'Bob' });

state = roomService.renameMember(roomCode, 'guest-b', 'Bob Renamed');
assert.equal(state.members.find((member) => member.id === 'guest-b')?.name, 'Bob Renamed');
assert.equal(state.chat.find((message) => message.text === 'message sent before rename')?.senderName, 'Bob Renamed', 'rename should update historical user message names');
assert.ok(state.chat.some((message) => message.memberId === 'guest-b' && message.systemEvent === 'member_joined' && message.text === 'Bob Renamed 加入了房间'), 'rename should update historical join system messages');
assert.equal(state.audit.find((entry) => entry.actorId === 'guest-b')?.actorName, 'Bob Renamed', 'rename should update historical audit names');

state = roomService.setControlPolicy(roomCode, 'everyone', { memberId: 'host-a', memberName: 'Alice' });
assert.equal(state.security.controlPolicy, 'everyone');
assert.equal(state.audit.at(-1)?.action, 'control_policy_updated');
assert.equal(roomService.canControlRoom(roomCode, 'guest-b'), true);
state = roomService.setAutoPlayNext(roomCode, true, { memberId: 'host-a', memberName: 'Alice' });
assert.equal(state.autoPlayNext, true, 'automatic playlist advance should be room-authoritative');
assert.equal(state.audit.at(-1)?.action, 'autoplay_next_updated');

let collaborativeRevision = state.playback.revision;
state = roomService.updatePlayback(roomCode, {
  playing: true,
  currentTime: 10,
  updatedBy: 'guest-b',
}, {
  memberId: 'guest-b',
  action: 'seek',
  baseRevision: collaborativeRevision,
  clientReady: true,
});
assert.equal(state.playback.revision, collaborativeRevision + 1, 'an explicit seek should acquire collaborative playback control');
assert.equal(state.playback.updatedBy, 'guest-b');
assert.ok(state.playback.controlLeaseUntil > Date.now(), 'collaborative playback control should use a short lease');

collaborativeRevision = state.playback.revision;
state = roomService.updatePlayback(roomCode, {
  playing: true,
  currentTime: 4,
  updatedBy: 'guest-b',
}, {
  memberId: 'guest-b',
  action: 'periodic',
  baseRevision: collaborativeRevision,
  clientReady: false,
});
assert.equal(state.playback.revision, collaborativeRevision, 'a buffering collaborator must not publish periodic authority state');
assert.ok(state.playback.currentTime >= 10, 'a rejected buffering update must not rewind the shared timeline');

state = roomService.updatePlayback(roomCode, {
  playing: true,
  currentTime: 1,
  updatedBy: 'guest-b',
}, {
  memberId: 'guest-b',
  action: 'periodic',
  baseRevision: collaborativeRevision,
  clientReady: true,
});
assert.equal(state.playback.revision, collaborativeRevision, 'a stale healthy periodic update must also be rejected');
assert.ok(state.playback.currentTime >= 10, 'stale periodic progress must not drag the room backward');

let collaborativeBuffering = roomService.updatePlaybackWithDecision(roomCode, {
  activeSourceId: state.playback.activeSourceId,
  buffering: true,
  currentTime: 10.5,
  updatedBy: 'guest-b',
}, {
  memberId: 'guest-b',
  action: 'buffering',
  baseRevision: collaborativeRevision,
});
assert.equal(collaborativeBuffering.accepted, true, 'a collaborative authority should publish buffering');
const realDateNow = Date.now;
Date.now = () => collaborativeBuffering.state.playback.controlLeaseUntil + 1_000;
try {
  collaborativeBuffering = roomService.updatePlaybackWithDecision(roomCode, {
    activeSourceId: state.playback.activeSourceId,
    buffering: false,
    currentTime: 10.75,
    updatedBy: 'guest-b',
  }, {
    memberId: 'guest-b',
    action: 'buffering',
    baseRevision: collaborativeBuffering.state.playback.revision,
  });
} finally {
  Date.now = realDateNow;
}
assert.equal(collaborativeBuffering.accepted, true, 'an online buffering authority must be allowed to recover after its ordinary lease deadline');
assert.equal(collaborativeBuffering.state.playback.buffering, false);
state = collaborativeBuffering.state;

state = roomService.setControlPolicy(roomCode, 'host_only', { memberId: 'host-a', memberName: 'Alice' });
assert.equal(state.security.controlPolicy, 'host_only');
assert.equal(roomService.canControlRoom(roomCode, 'guest-b'), false);

let hostRevision = state.playback.revision;
let hostDecision = roomService.updatePlaybackWithDecision(roomCode, {
  activeSourceId: state.playback.activeSourceId,
  playing: true,
  currentTime: 30,
  playbackRate: 1,
  updatedBy: 'host-a',
}, {
  memberId: 'host-a',
  action: 'seek',
  baseRevision: hostRevision,
  clientReady: true,
});
assert.equal(hostDecision.accepted, true, 'the host should establish a healthy playback anchor');
hostRevision = hostDecision.state.playback.revision;
hostDecision = roomService.updatePlaybackWithDecision(roomCode, {
  activeSourceId: hostDecision.state.playback.activeSourceId,
  playing: true,
  currentTime: 20,
  playbackRate: 1,
  buffering: true,
  updatedBy: 'host-a',
}, {
  memberId: 'host-a',
  action: 'buffering',
  baseRevision: hostRevision,
});
assert.equal(hostDecision.accepted, true, 'the current authority should publish a debounced buffering boundary');
assert.equal(hostDecision.state.playback.buffering, true);
assert.equal(hostDecision.state.playback.playing, true, 'buffering must preserve the intended play state');
assert.equal(hostDecision.state.playback.currentTime, 20, 'buffering should freeze the shared clock at the actual media position');
hostRevision = hostDecision.state.playback.revision;
const blockedBufferingPeriodic = roomService.updatePlaybackWithDecision(roomCode, {
  activeSourceId: hostDecision.state.playback.activeSourceId,
  playing: true,
  currentTime: 20,
  buffering: false,
  updatedBy: 'host-a',
}, {
  memberId: 'host-a',
  action: 'periodic',
  baseRevision: hostRevision,
  clientReady: true,
  clientSeeking: false,
});
assert.equal(blockedBufferingPeriodic.accepted, false, 'ordinary periodic packets must not restart a frozen buffering clock');
assert.equal(blockedBufferingPeriodic.reason, 'room_buffering');
assert.equal(blockedBufferingPeriodic.state.playback.revision, hostRevision);
hostDecision = roomService.updatePlaybackWithDecision(roomCode, {
  activeSourceId: hostDecision.state.playback.activeSourceId,
  playing: true,
  currentTime: 20.25,
  playbackRate: 1,
  buffering: false,
  updatedBy: 'host-a',
}, {
  memberId: 'host-a',
  action: 'buffering',
  baseRevision: hostRevision,
});
assert.equal(hostDecision.accepted, true, 'the same authority should explicitly resume a buffering timeline');
assert.equal(hostDecision.state.playback.buffering, false);
assert.equal(hostDecision.state.playback.currentTime, 20.25);
state = hostDecision.state;

state = roomService.transferHost(roomCode, 'guest-b', { memberId: 'host-a', memberName: 'Alice' });
assert.equal(state.hostMemberId, 'guest-b');
assert.equal(state.audit.at(-1)?.action, 'host_transferred');
assert.equal(
  (await roomService.getJoinRejection(roomCode, 'guest-b', undefined, adminToken, undefined, 'socket-transferred-host-takeover'))?.code,
  'admin_member_mismatch',
  'the creator admin token must not impersonate a transferred online host',
);
assert.throws(
  () => roomService.joinRoom({ roomCode, memberId: 'guest-b', socketId: 'socket-transferred-host-takeover', adminToken }),
  /cannot be replaced|does not match/i,
  'the service layer must reject transferred-host impersonation even without a preflight check',
);

state = roomService.transferHost(roomCode, 'host-a', { memberId: 'guest-b', memberName: 'Bob' });
assert.equal(state.hostMemberId, 'host-a');

const parsedBilibiliItem = {
  title: 'First Test Video',
  pageUrl: 'https://www.bilibili.com/video/BV1182FBRExJ',
  sourceUrl: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/video-1.mp4',
  refererUrl: 'https://www.bilibili.com/video/BV1182FBRExJ',
  sourceType: 'video',
  addedBy: 'host-a',
  bilibili: {
    bvid: 'BV1182FBRExJ',
    cid: 33755434897,
    page: 1,
    quality: 64,
    qualityLabel: '720P 高清',
    danmakuAvailable: true,
    danmakuEnabled: false,
  },
};
const sanitizedBilibiliItem = sanitizePlaylistItem(parsedBilibiliItem, 'host-a');
assert.ok(sanitizedBilibiliItem, 'parsed Bilibili items should pass the Socket ingress sanitizer');
assert.equal(
  sanitizedBilibiliItem.pageUrl,
  parsedBilibiliItem.pageUrl,
  'Socket ingress must preserve the canonical Bilibili page URL for metadata validation and client reparsing',
);
assert.equal(
  sanitizedBilibiliItem.sourceUrl,
  parsedBilibiliItem.sourceUrl,
  'Socket ingress must preserve the separately resolved Bilibili media URL',
);
state = roomService.addPlaylistItem(roomCode, sanitizedBilibiliItem);
const firstItemId = state.playlist[0]?.id;
assert.ok(firstItemId, 'first playlist item should have an id');
assert.equal(state.playback.activeSourceId, firstItemId);
assert.equal(state.playlist[0]?.pageUrl, parsedBilibiliItem.pageUrl, 'room snapshots should retain the Bilibili page URL');
assert.equal(state.playlist[0]?.sourceUrl, parsedBilibiliItem.sourceUrl, 'room snapshots should retain the Bilibili media URL');
assert.equal(state.playlist[0]?.bilibili?.bvid, 'BV1182FBRExJ', 'Bilibili metadata should survive Socket sanitizing and room insertion');
  state = roomService.updatePlaylistBilibiliDanmaku(roomCode, firstItemId, true);
  assert.equal(state.playlist[0]?.bilibili?.danmakuEnabled, true, 'Bilibili danmaku preference should be shared in room state');
  const playbackBeforeBilibiliRefresh = { ...state.playback };
  const refreshedBilibiliItem = sanitizePlaylistItem({
    ...parsedBilibiliItem,
    sourceUrl: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/video-1-refreshed.mp4',
    finalUrl: parsedBilibiliItem.pageUrl,
    bilibili: { ...parsedBilibiliItem.bilibili, quality: 80, qualityLabel: '1080P 高清', danmakuEnabled: false },
  }, 'guest-b');
  assert.ok(refreshedBilibiliItem);
  state = roomService.refreshBilibiliPlaylistSource(roomCode, firstItemId, refreshedBilibiliItem);
  assert.equal(state?.playlist[0]?.id, firstItemId, 'refreshing a signed Bilibili URL must preserve the playlist item identity');
  assert.equal(state?.playlist[0]?.sourceUrl, refreshedBilibiliItem.sourceUrl, 'the refreshed signed Bilibili URL should become authoritative');
  assert.equal(state?.playlist[0]?.addedBy, 'host-a', 'a member-triggered refresh must not change playlist ownership');
  assert.equal(state?.playlist[0]?.bilibili?.danmakuEnabled, true, 'a source refresh must preserve the shared Bilibili danmaku preference');
  assert.deepEqual(state?.playback, playbackBeforeBilibiliRefresh, 'a source refresh must preserve playback revision, timeline and intent');
  const rejectedIdentityRefresh = roomService.refreshBilibiliPlaylistSource(roomCode, firstItemId, {
    ...refreshedBilibiliItem,
    sourceUrl: 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/wrong-cid.mp4',
    bilibili: { ...refreshedBilibiliItem.bilibili, cid: refreshedBilibiliItem.bilibili.cid + 1 },
  });
  assert.equal(rejectedIdentityRefresh?.playlist[0]?.sourceUrl, refreshedBilibiliItem.sourceUrl, 'a mismatched Bilibili identity must not replace the authoritative source');
  assert.throws(
  () => roomService.addPlaylistItem(roomCode, {
    title: 'Private Network Video',
    pageUrl: 'http://127.0.0.1/private.mp4',
    sourceUrl: 'http://127.0.0.1/private.mp4',
    sourceType: 'video',
    addedBy: 'host-a',
  }),
  /内网|本机/,
  'private video URLs must not enter shared room state',
);
assert.equal(state.playlist.length, 1);

state = roomService.addPlaylistItem(roomCode, {
  title: 'Second Test Video',
  pageUrl: 'https://example.com/watch/2',
  sourceUrl: 'https://cdn.example.com/video-2.mp4',
  refererUrl: 'https://player.example.com/embed/video-1',
  sourceType: 'video',
  addedBy: 'host-a',
});
const secondItemId = state.playlist[1]?.id;
assert.ok(secondItemId, 'second playlist item should have an id');
state = roomService.addPlaylistItem(roomCode, {
  title: 'Overflow Test Video',
  pageUrl: 'https://example.com/watch/overflow',
  sourceUrl: 'https://cdn.example.com/video-overflow.mp4',
  sourceType: 'video',
  addedBy: 'host-a',
});
assert.equal(state.playlist.length, 2, 'playlist growth must stop at the configured room limit');

state = roomService.renamePlaylistItem(roomCode, secondItemId, 'Renamed Test Video');
assert.equal(state.playlist.find((item) => item.id === secondItemId)?.title, 'Renamed Test Video');

state = roomService.movePlaylistItem(roomCode, secondItemId, -1);
assert.equal(state.playlist[0]?.id, secondItemId);

state = roomService.updatePlayback(roomCode, {
  activeSourceId: secondItemId,
  playing: true,
  currentTime: 42.5,
  duration: 120,
  playbackRate: 1.25,
  updatedBy: 'host-a',
});
assert.equal(state.playback.activeSourceId, secondItemId);
assert.equal(state.playback.playing, true);
assert.equal(state.playback.currentTime, 42.5);
assert.equal(state.playback.playbackRate, 1.25);

state = roomService.setControlPolicy(roomCode, 'everyone', { memberId: 'host-a', memberName: 'Alice' });
let sourceRevision = state.playback.revision;
state = roomService.updatePlayback(roomCode, {
  activeSourceId: firstItemId,
  playing: false,
  currentTime: 0,
  updatedBy: 'host-a',
}, {
  memberId: 'host-a',
  action: 'source',
  baseRevision: sourceRevision,
  clientReady: true,
});
assert.equal(state.playback.activeSourceId, firstItemId, 'a source action may switch to an existing playlist item');
assert.equal(state.playback.revision, sourceRevision + 1);

sourceRevision = state.playback.revision;
state = roomService.updatePlayback(roomCode, {
  activeSourceId: secondItemId,
  currentTime: 17,
  updatedBy: 'guest-b',
}, {
  memberId: 'guest-b',
  action: 'seek',
  baseRevision: sourceRevision,
  clientReady: true,
});
assert.equal(state.playback.revision, sourceRevision, 'a seek from a still-loading old source must be rejected');
assert.equal(state.playback.activeSourceId, firstItemId, 'only a source action may change the authoritative playlist item');

state = roomService.updatePlayback(roomCode, {
  activeSourceId: 'missing-playlist-item',
  playing: false,
  currentTime: 0,
  updatedBy: 'guest-b',
}, {
  memberId: 'guest-b',
  action: 'source',
  baseRevision: sourceRevision,
  clientReady: true,
});
assert.equal(state.playback.revision, sourceRevision, 'a source action must reference an existing playlist item');
assert.equal(state.playback.activeSourceId, firstItemId);
state = roomService.setControlPolicy(roomCode, 'host_only', { memberId: 'host-a', memberName: 'Alice' });

state = roomService.addChat(roomCode, {
  senderId: 'guest-b',
  senderName: 'Bob',
  text: 'hello synchronized chat',
});
assert.equal(state.chat.at(-1)?.text, 'hello synchronized chat');
assert.equal(state.chat.at(-1)?.senderId, 'guest-b');
assert.equal(state.chat.at(-1)?.kind, 'user');

const stalePasswordUpdate = roomService.setRoomPassword(
  roomCode,
  'must-not-win-after-admin-recovery',
  { memberId: 'host-a', memberName: 'Alice' },
  { memberId: 'host-a', adminToken },
);
const passwordRaceRecovery = roomService.recoverAdminToken(roomCode, recoveryCode, {
  memberId: 'host-a',
  memberName: 'Alice',
  socketId: 'socket-host-a',
});
assert.ok(passwordRaceRecovery?.adminToken && passwordRaceRecovery.recoveryCode, 'the password race fixture should rotate management credentials');
assert.equal(await stalePasswordUpdate, null, 'an async password update must be rejected after its management token is rotated');
assert.equal(roomService.getRoom(roomCode)?.security.hasPassword, false, 'a stale password hash must not mutate the room after management recovery');
adminToken = passwordRaceRecovery.adminToken;
recoveryCode = passwordRaceRecovery.recoveryCode;

let eventLoopAdvancedDuringPasswordHash = false;
const passwordUpdate = roomService.setRoomPassword(
  roomCode,
  roomPassword,
  { memberId: 'host-a', memberName: 'Alice' },
  { memberId: 'host-a', adminToken },
);
setImmediate(() => { eventLoopAdvancedDuringPasswordHash = true; });
state = await passwordUpdate;
assert.equal(eventLoopAdvancedDuringPasswordHash, true, 'scrypt password hashing must not block the Node.js event loop');
assert.equal(state.security.hasPassword, true);
assert.equal(state.audit.at(-1)?.action, 'password_set');
assert.equal((await roomService.getJoinRejection(roomCode, 'guest-c'))?.code, 'password_required');
assert.equal((await roomService.getJoinRejection(roomCode, 'guest-c', 'wrong-password'))?.code, 'password_invalid');
assert.equal(await roomService.getJoinRejection(roomCode, 'guest-c', roomPassword), null);

state = roomService.setRoomLocked(roomCode, true, { memberId: 'host-a', memberName: 'Alice' });
assert.equal(state.security.locked, true);
assert.equal(state.audit.at(-1)?.action, 'room_locked');
assert.equal((await roomService.getJoinRejection(roomCode, 'guest-d', roomPassword))?.code, 'locked');
assert.equal(
  (await roomService.getJoinRejection(roomCode, 'guest-d', roomPassword, adminToken))?.code,
  'admin_member_mismatch',
  'management credentials must not bypass a lock under an unrelated member id',
);
assert.equal(
  await roomService.getJoinRejection(roomCode, 'host-a', undefined, adminToken, undefined, 'socket-host-a'),
  null,
  'the bound creator socket should retain management access to a locked room',
);

const continuityRoomCode = `CONT${Date.now().toString(36).slice(-6).toUpperCase()}`;
roomService.joinRoom({ roomCode: continuityRoomCode, memberId: 'continuity-host', socketId: 'socket-continuity-host', name: 'Continuity Host' });
const continuityHostToken = roomService.claimPendingMemberReconnectToken(continuityRoomCode, 'continuity-host');
assert.ok(continuityHostToken, 'host should receive a private reconnect token');
const continuityAdminCredentials = roomService.claimPendingAdminCredentials(continuityRoomCode, 'continuity-host');
assert.ok(continuityAdminCredentials?.adminToken && continuityAdminCredentials.recoveryCode, 'continuity host should receive management credentials');
roomService.joinRoom({ roomCode: continuityRoomCode, memberId: 'continuity-guest', socketId: 'socket-continuity-guest', name: 'Continuity Guest' });
const continuityGuestToken = roomService.claimPendingMemberReconnectToken(continuityRoomCode, 'continuity-guest');
assert.ok(continuityGuestToken, 'guest should receive a private reconnect token');
assert.equal(
  (await roomService.getJoinRejection(continuityRoomCode, 'continuity-guest', undefined, undefined, continuityGuestToken, 'socket-continuity-guest-replay'))?.code,
  'member_online_elsewhere',
  'a reconnect token must not replace a member whose original socket is still online',
);
assert.throws(
  () => roomService.joinRoom({ roomCode: continuityRoomCode, memberId: 'continuity-guest', socketId: 'socket-continuity-guest-replay', reconnectToken: continuityGuestToken }),
  /cannot be replaced/i,
  'the service layer must reject online reconnect-token replay',
);
assert.equal(
  await roomService.getJoinRejection(continuityRoomCode, 'continuity-guest', undefined, undefined, continuityGuestToken, 'socket-continuity-guest'),
  null,
  'the original socket should be allowed to repeat an idempotent join',
);
await roomService.setRoomPassword(continuityRoomCode, 'continuity-password');
roomService.setRoomLocked(continuityRoomCode, true);
roomService.leaveBySocket('socket-continuity-guest');
assert.equal((await roomService.getJoinRejection(continuityRoomCode, 'continuity-guest'))?.code, 'reconnect_token_invalid', 'a public member id must not be enough to bypass room security');
assert.equal(await roomService.getJoinRejection(continuityRoomCode, 'continuity-guest', undefined, undefined, continuityGuestToken), null, 'recently disconnected members with a valid secret should bypass lock and password during the reconnect grace period');
roomService.joinRoom({ roomCode: continuityRoomCode, memberId: 'continuity-guest', socketId: 'socket-continuity-guest-2', name: 'Continuity Guest', reconnectToken: continuityGuestToken });
const rotatedContinuityGuestToken = roomService.claimPendingMemberReconnectToken(continuityRoomCode, 'continuity-guest');
assert.ok(rotatedContinuityGuestToken && rotatedContinuityGuestToken !== continuityGuestToken, 'a successful disconnected reconnect must rotate the member token');
roomService.leaveBySocket('socket-continuity-guest-2');
assert.equal(
  (await roomService.getJoinRejection(continuityRoomCode, 'continuity-guest', undefined, undefined, continuityGuestToken))?.code,
  'reconnect_token_invalid',
  'the old member token must be invalid immediately after a successful reconnect',
);
assert.equal(await roomService.getJoinRejection(continuityRoomCode, 'continuity-guest', undefined, undefined, rotatedContinuityGuestToken), null);
roomService.joinRoom({ roomCode: continuityRoomCode, memberId: 'continuity-guest', socketId: 'socket-continuity-guest-3', name: 'Continuity Guest', reconnectToken: rotatedContinuityGuestToken });
assert.ok(roomService.claimPendingMemberReconnectToken(continuityRoomCode, 'continuity-guest'), 'the second disconnected reconnect should rotate the token again');
const hostDisconnect = roomService.leaveBySocket('socket-continuity-host')[0];
assert.equal(hostDisconnect?.departedHostId, 'continuity-host');
assert.equal(hostDisconnect?.state.hostMemberId, 'continuity-host', 'host identity should be reserved during the short reconnect grace period');
assert.equal(await roomService.getJoinRejection(continuityRoomCode, 'continuity-host', undefined, undefined, continuityHostToken), null, 'disconnected host with a valid secret should be allowed back into a locked room');
let continuityState = roomService.joinRoom({ roomCode: continuityRoomCode, memberId: 'continuity-host', socketId: 'socket-continuity-host-2', name: 'Continuity Host', reconnectToken: continuityHostToken });
const rotatedContinuityHostToken = roomService.claimPendingMemberReconnectToken(continuityRoomCode, 'continuity-host');
assert.ok(rotatedContinuityHostToken && rotatedContinuityHostToken !== continuityHostToken, 'host reconnect should rotate its reconnect token');
assert.equal(continuityState.members.find((member) => member.id === 'continuity-host')?.role, 'host', 'returning host should recover the host role');
assert.equal(roomService.isMemberSocket(continuityRoomCode, 'continuity-host', 'socket-continuity-host'), false, 'a superseded socket must not retain the restored member identity');
assert.equal(roomService.isMemberSocket(continuityRoomCode, 'continuity-host', 'socket-continuity-host-2'), true);
roomService.leaveBySocket('socket-continuity-host-2');
continuityState = roomService.finalizeHostDeparture(continuityRoomCode, 'continuity-host', Date.now() + 2000);
assert.equal(continuityState?.hostMemberId, 'continuity-guest', 'host role should fail over after the reconnect grace period expires');
assert.equal(continuityState?.audit.at(-1)?.action, 'host_failed_over', 'automatic host failover should be distinguishable from a manual transfer');
const continuityRecoveredAdmin = roomService.recoverAdminToken(
  continuityRoomCode,
  continuityAdminCredentials.recoveryCode,
  { memberId: 'continuity-host-restored', memberName: 'Continuity Host', socketId: 'socket-continuity-host-restored' },
);
assert.ok(continuityRecoveredAdmin?.adminToken, 'a creator with the recovery code should recover management after identity loss');
assert.equal(continuityRecoveredAdmin.state.hostMemberId, 'continuity-host-restored', 'the recovered creator should reclaim an automatically failed-over host role');
assert.ok(continuityRecoveredAdmin.state.audit.some((entry) => entry.action === 'host_reclaimed'), 'automatic host reclamation should be audited');
continuityState = roomService.joinRoom({
  roomCode: continuityRoomCode,
  memberId: 'continuity-host-restored',
  socketId: 'socket-continuity-host-restored',
  name: 'Continuity Host',
  adminToken: continuityRecoveredAdmin.adminToken,
});
assert.equal(continuityState.hostMemberId, 'continuity-host-restored');
const restoredHostReconnectToken = roomService.claimPendingMemberReconnectToken(continuityRoomCode, 'continuity-host-restored');
assert.ok(restoredHostReconnectToken);
continuityState = roomService.transferHost(
  continuityRoomCode,
  'continuity-guest',
  { memberId: 'continuity-host-restored', memberName: 'Continuity Host' },
);
assert.equal(continuityState.hostMemberId, 'continuity-guest');
roomService.leaveBySocket('socket-continuity-host-restored');
continuityState = roomService.joinRoom({
  roomCode: continuityRoomCode,
  memberId: 'continuity-host-restored',
  socketId: 'socket-continuity-host-restored-2',
  name: 'Continuity Host',
  reconnectToken: restoredHostReconnectToken,
  adminToken: continuityRecoveredAdmin.adminToken,
});
assert.equal(continuityState.hostMemberId, 'continuity-guest', 'creator reconnect must preserve an explicit manual host transfer');

assert.equal(roomService.kickMember(roomCode, 'host-a', undefined, { memberId: 'host-a', memberName: 'Alice' }), null, 'the service must reject kicking the current host');
const kickResult = roomService.kickMember(roomCode, 'guest-b', undefined, { memberId: 'host-a', memberName: 'Alice' });
assert.equal(kickResult?.kickedSocketId, 'socket-guest-b');
assert.equal(kickResult?.state.members.some((member) => member.id === 'guest-b'), false);
assert.equal(kickResult?.state.audit.at(-1)?.action, 'member_kicked');
assert.equal(kickResult?.state.audit.at(-1)?.targetName, 'Bob Renamed');
assert.equal((await roomService.getJoinRejection(roomCode, 'guest-b', roomPassword, adminToken))?.code, 'kicked');
assert.equal(
  (await roomService.getJoinRejection(roomCode, 'guest-b-new-identity', roomPassword, undefined, undefined, undefined, 'device-guest-b'))?.code,
  'kicked',
  'a kicked anonymous client must not bypass the room ban by rotating only its member id',
);
assert.ok(
  kickResult?.state.members.every((member) => !Object.hasOwn(member, 'clientIdentityHash')),
  'anonymous client identity hashes must never be included in public room state',
);

const capacityRoomCode = `CAP${Date.now().toString(36).slice(-6).toUpperCase()}`;
const capacityCreation = roomService.createRoom(capacityRoomCode, 'Capacity Verification');
assert.ok(capacityCreation, 'capacity room should be explicitly created');
roomService.joinRoom({ roomCode: capacityRoomCode, memberId: 'capacity-creator', socketId: 'socket-capacity-creator', name: 'Capacity Creator', adminToken: capacityCreation.credentials.adminToken });
roomService.claimPendingMemberReconnectToken(capacityRoomCode, 'capacity-creator');
const reservedCapacityMembers = [];
for (let index = 1; index < 20; index += 1) {
  const memberId = `capacity-${index}`;
  const socketId = `socket-${memberId}`;
  assert.equal(await roomService.getJoinRejection(capacityRoomCode, memberId), null);
  roomService.joinRoom({ roomCode: capacityRoomCode, memberId, socketId, name: memberId });
  const reconnectToken = roomService.claimPendingMemberReconnectToken(capacityRoomCode, memberId);
  assert.ok(reconnectToken);
  reservedCapacityMembers.push({ memberId, reconnectToken });
  roomService.leaveBySocket(socketId);
}
assert.equal(roomService.getRoom(capacityRoomCode)?.members.length, 1, 'disconnected identities should leave only the creator online');
assert.equal((await roomService.getJoinRejection(capacityRoomCode, 'capacity-overflow'))?.code, 'room_full');
const rotatedCapacityTokens = new Map();
for (const { memberId, reconnectToken } of reservedCapacityMembers) {
  assert.equal(await roomService.getJoinRejection(capacityRoomCode, memberId, undefined, undefined, reconnectToken), null);
  roomService.joinRoom({ roomCode: capacityRoomCode, memberId, socketId: `rejoined-${memberId}`, reconnectToken });
  const rotatedToken = roomService.claimPendingMemberReconnectToken(capacityRoomCode, memberId);
  assert.ok(rotatedToken && rotatedToken !== reconnectToken);
  rotatedCapacityTokens.set(memberId, rotatedToken);
  assert.ok((roomService.getRoom(capacityRoomCode)?.members.length || 0) <= 20, 'concurrent reservation return must never exceed ROOM_MAX_MEMBERS');
}
assert.equal(roomService.getRoom(capacityRoomCode)?.members.length, 20);
assert.ok(roomService.getRoom(capacityRoomCode)?.members.every((member) => !Object.hasOwn(member, 'socketId')));
const replayCandidate = reservedCapacityMembers[0];
roomService.leaveBySocket(`rejoined-${replayCandidate.memberId}`);
assert.equal((await roomService.getJoinRejection(capacityRoomCode, replayCandidate.memberId, undefined, undefined, replayCandidate.reconnectToken))?.code, 'reconnect_token_invalid');
assert.equal(await roomService.getJoinRejection(capacityRoomCode, replayCandidate.memberId, undefined, undefined, rotatedCapacityTokens.get(replayCandidate.memberId)), null);
assert.equal(
  (await roomService.getJoinRejection(capacityRoomCode, 'capacity-admin', undefined, capacityCreation.credentials.adminToken))?.code,
  'admin_member_mismatch',
  'the bound management token must not create an unrelated identity in a full room',
);
assert.equal(await roomService.getJoinRejection(capacityRoomCode, 'capacity-creator', undefined, capacityCreation.credentials.adminToken, undefined, 'socket-capacity-creator'), null, 'the bound creator socket may join idempotently in a full room');

state = roomService.deletePlaylistItem(roomCode, firstItemId);
assert.equal(state.playlist.some((item) => item.id === firstItemId), false);

const expiringRoomCode = `TTL${Date.now().toString(36).slice(-6).toUpperCase()}`;
roomService.joinRoom({
  roomCode: expiringRoomCode,
  memberId: 'ttl-host',
  socketId: 'socket-ttl-host',
  name: 'TTL Host',
});
roomService.addChat(expiringRoomCode, {
  senderId: 'ttl-host',
  senderName: 'TTL Host',
  text: 'this chat must be destroyed with the empty room',
});
const [ttlDeparture] = roomService.leaveBySocket('socket-ttl-host');
assert.ok(roomService.getRoom(expiringRoomCode), 'empty room should remain available during its grace period');
state = roomService.finalizeMemberDeparture(
  expiringRoomCode,
  ttlDeparture.memberId,
  ttlDeparture.memberName,
  ttlDeparture.reconnectUntil,
  ttlDeparture.reconnectUntil + 1,
);
assert.equal(state?.chat.at(-1)?.kind, 'system', 'confirmed departures should be stored as muted system chat');
assert.match(state?.chat.at(-1)?.text || '', /TTL Host.*离开了房间/);
const expiredRooms = roomService.expireEmptyRooms(Date.now() + 120000);
assert.ok(expiredRooms.includes(expiringRoomCode), 'empty room should expire after ROOM_EMPTY_TTL_MS');
assert.equal(roomService.getRoom(expiringRoomCode), null, 'expired room state and chat should be removed together');

await flushRoomPersistence();
const rawStore = fs.readFileSync(process.env.ROOM_STORE_FILE, 'utf8');
const persistedStore = JSON.parse(rawStore);
const persistedVerifiedRoom = persistedStore.rooms.find((room) => room.roomCode === roomCode);
assert.ok(rawStore.includes(roomCode), 'snapshot should contain the verified room');
assert.ok(rawStore.includes('Renamed Test Video'), 'snapshot should contain playlist state');
assert.ok(rawStore.includes('https://player.example.com/embed/video-1'), 'snapshot should preserve the discovered media Referer');
assert.ok(rawStore.includes('hello synchronized chat'), 'snapshot should contain chat state');
assert.ok(rawStore.includes('"audit"'), 'snapshot should contain audit log');
assert.equal(persistedVerifiedRoom?.security?.controlPolicy, 'host_only', 'snapshot should contain room control policy');
assert.ok(rawStore.includes('adminRecoveryHash'), 'snapshot should contain hashed admin recovery code');
assert.ok(rawStore.includes('admin_token_recovered'), 'snapshot should contain admin recovery audit event');
assert.ok(rawStore.includes('control_policy_updated'), 'snapshot should contain control policy audit event');
assert.equal(persistedVerifiedRoom?.autoPlayNext, true, 'snapshot should persist the shared automatic playlist advance setting');
assert.ok(rawStore.includes('autoplay_next_updated'), 'snapshot should contain automatic playlist advance audit events');
assert.ok(rawStore.includes('host_transferred'), 'snapshot should contain transfer audit event');
assert.ok(rawStore.includes('host_failed_over'), 'snapshot should distinguish automatic host failover');
assert.ok(rawStore.includes('host_reclaimed'), 'snapshot should record creator host reclamation');
assert.ok(rawStore.includes('member_kicked'), 'snapshot should contain kick audit event');
assert.ok(rawStore.includes('password_set'), 'snapshot should contain password audit event');
assert.ok(rawStore.includes('adminTokenHash'), 'snapshot should contain hashed admin token');
assert.ok(rawStore.includes('reconnectMembers'), 'snapshot should contain hashed member reconnect grants');
assert.ok(rawStore.includes('hostReconnectUntil'), 'snapshot should contain the host reconnect deadline');
assert.ok(rawStore.includes('hostAssignment'), 'snapshot should preserve whether the current host was assigned manually or automatically');
assert.ok(rawStore.includes('creatorMemberId'), 'snapshot should persist the management identity binding');
assert.ok(rawStore.includes('adminMemberId'), 'snapshot should persist the current room manager independently from the original creator');
assert.ok(rawStore.includes('adminAssignment'), 'snapshot should persist whether management belongs to the creator or an automatic successor');
assert.ok(rawStore.includes('adminReconnectUntil'), 'snapshot should persist the delayed management takeover deadline');
assert.ok(rawStore.includes('passwordHash'), 'snapshot should contain password hash');
assert.ok(rawStore.includes('emptySince'), 'snapshot should contain the empty room lifecycle marker');
assert.ok(!rawStore.includes('this chat must be destroyed with the empty room'), 'expired room chat must not remain in the snapshot');
assert.ok(!rawStore.includes(roomPassword), 'snapshot must not contain the plaintext room password');
assert.ok(!rawStore.includes(adminToken), 'snapshot must not contain the plaintext admin token');
assert.ok(!rawStore.includes(recoveryCode), 'snapshot must not contain the plaintext admin recovery code');
assert.ok(!rawStore.includes(continuityHostToken), 'snapshot must not contain the plaintext host reconnect token');
assert.ok(!rawStore.includes(continuityGuestToken), 'snapshot must not contain the plaintext guest reconnect token');

console.log(`room flow verification passed: ${roomCode}`);
