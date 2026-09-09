import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptFile = fileURLToPath(import.meta.url);
const serverRoot = process.cwd();
const mode = process.env.VERIFY_ROOM_RESTART_MODE || '';

async function runCreateWorker() {
  const { flushRoomPersistence, roomService } = await import('../dist/services/room.service.js');
  const roomCode = process.env.VERIFY_ROOM_RESTART_CODE;
  roomService.joinRoom({ roomCode, memberId: 'restart-host', socketId: 'restart-host-socket', name: 'Restart Host' });
  const hostReconnectToken = roomService.claimPendingMemberReconnectToken(roomCode, 'restart-host');
  const adminCredentials = roomService.claimPendingAdminCredentials(roomCode, 'restart-host');
  roomService.joinRoom({ roomCode, memberId: 'restart-guest', socketId: 'restart-guest-socket', name: 'Restart Guest' });
  const guestReconnectToken = roomService.claimPendingMemberReconnectToken(roomCode, 'restart-guest');
  assert.ok(hostReconnectToken && guestReconnectToken && adminCredentials?.adminToken);
  await roomService.setRoomPassword(roomCode, 'restart-password');
  roomService.setRoomLocked(roomCode, true);
  roomService.setAutoPlayNext(roomCode, true, { memberId: 'restart-host', memberName: 'Restart Host' });
  let playbackState = roomService.addPlaylistItem(roomCode, {
    id: 'restart-local-video',
    title: 'Restart Local.mp4',
    pageUrl: 'blob:https://legacy.example/page-token',
    sourceUrl: 'blob:https://legacy.example/source-token',
    sourceType: 'local',
    localFile: {
      name: 'Restart Local.mp4',
      size: 4_200_000,
      type: 'video/mp4',
      lastModified: 1_720_000_000_000,
    },
  });
  let playbackDecision = roomService.updatePlaybackWithDecision(roomCode, {
    activeSourceId: 'restart-local-video',
    playing: true,
    currentTime: 12,
    duration: 120,
    playbackRate: 1,
    updatedBy: 'restart-host',
  }, {
    memberId: 'restart-host',
    action: 'source',
    baseRevision: playbackState.playback.revision,
    clientReady: true,
    clientSeeking: false,
  });
  assert.equal(playbackDecision.accepted, true);
  playbackDecision = roomService.updatePlaybackWithDecision(roomCode, {
    activeSourceId: 'restart-local-video',
    buffering: true,
    currentTime: 12.5,
    updatedBy: 'restart-host',
  }, {
    memberId: 'restart-host',
    action: 'buffering',
    baseRevision: playbackDecision.state.playback.revision,
    clientReady: false,
    clientSeeking: false,
  });
  assert.equal(playbackDecision.accepted, true);
  assert.equal(playbackDecision.state.playback.buffering, true);
  const pendingRoomCode = `${roomCode}-PENDING`;
  const pendingCreation = roomService.createRoom(pendingRoomCode, 'Pending Creator Restart');
  assert.ok(pendingCreation?.credentials.adminToken && pendingCreation?.credentials.recoveryCode);
  await flushRoomPersistence();
  process.stdout.write(`${JSON.stringify({
    hostReconnectToken,
    guestReconnectToken,
    pendingAdminToken: pendingCreation.credentials.adminToken,
    pendingRecoveryCode: pendingCreation.credentials.recoveryCode,
  })}\n`);
}

async function runRestoreWorker() {
  const { flushRoomPersistence, roomService } = await import('../dist/services/room.service.js');
  const roomCode = process.env.VERIFY_ROOM_RESTART_CODE;
  const hostReconnectToken = process.env.VERIFY_ROOM_RESTART_HOST_TOKEN;
  const guestReconnectToken = process.env.VERIFY_ROOM_RESTART_GUEST_TOKEN;
  const pendingRoomCode = `${roomCode}-PENDING`;
  const pendingAdminToken = process.env.VERIFY_ROOM_RESTART_PENDING_ADMIN_TOKEN;
  assert.equal((await roomService.getJoinRejection(roomCode, 'restart-guest'))?.code, 'reconnect_token_invalid');
  assert.equal(await roomService.getJoinRejection(roomCode, 'restart-guest', undefined, undefined, guestReconnectToken), null);
  let state = roomService.joinRoom({
    roomCode,
    memberId: 'restart-guest',
    socketId: 'restart-guest-restored',
    name: 'Restart Guest',
    reconnectToken: guestReconnectToken,
  });
  const rotatedGuestToken = roomService.claimPendingMemberReconnectToken(roomCode, 'restart-guest');
  assert.ok(rotatedGuestToken && rotatedGuestToken !== guestReconnectToken, 'restored guest reconnect should rotate its token');
  assert.equal(state.hostMemberId, 'restart-host', 'the persisted host reservation should survive a process restart');
  assert.equal(state.playback.buffering, false, 'a process restart must clear an ephemeral buffering lock');
  assert.equal(state.playback.playing, false, 'a room restored from a buffering boundary must not extrapolate a phantom timeline');
  assert.equal(state.playback.currentTime, 12.5, 'a room restored from buffering should preserve the last actual media position');
  assert.equal(state.members.find((member) => member.id === 'restart-guest')?.role, 'follower');
  assert.ok(state.members.every((member) => !Object.hasOwn(member, 'socketId')), 'restored public room state must not expose socket ids');
  assert.equal(await roomService.getJoinRejection(roomCode, 'restart-host', undefined, undefined, hostReconnectToken), null);
  state = roomService.joinRoom({
    roomCode,
    memberId: 'restart-host',
    socketId: 'restart-host-restored',
    name: 'Restart Host',
    reconnectToken: hostReconnectToken,
  });
  const rotatedHostToken = roomService.claimPendingMemberReconnectToken(roomCode, 'restart-host');
  assert.ok(rotatedHostToken && rotatedHostToken !== hostReconnectToken, 'restored host reconnect should rotate its token');
  assert.equal(state.members.find((member) => member.id === 'restart-host')?.role, 'host');
  assert.equal(state.autoPlayNext, true, 'the shared automatic playlist advance setting should survive restart');
  const restoredLocalItem = state.playlist.find((item) => item.id === 'restart-local-video');
  assert.equal(restoredLocalItem?.sourceUrl, 'local://together-see/Restart%20Local.mp4?size=4200000', 'restored local sources should use canonical placeholders');
  assert.equal(restoredLocalItem?.pageUrl, restoredLocalItem?.sourceUrl);
  assert.equal(restoredLocalItem?.refererUrl, '');
  assert.equal(restoredLocalItem?.finalUrl, '');
  assert.equal((await roomService.getJoinRejection(pendingRoomCode, 'restart-race-attacker'))?.code, 'creator_pending');
  assert.equal(await roomService.getJoinRejection(pendingRoomCode, 'pending-creator', undefined, pendingAdminToken), null);
  const pendingState = roomService.joinRoom({
    roomCode: pendingRoomCode,
    memberId: 'pending-creator',
    socketId: 'pending-creator-restored',
    name: 'Pending Creator',
    adminToken: pendingAdminToken,
  });
  assert.equal(pendingState.hostMemberId, 'pending-creator', 'the original creator should claim the host role after a restart');
  assert.equal(roomService.isAdmin(pendingRoomCode, pendingAdminToken), true, 'the creation admin token should survive restart as a hash');
  assert.equal(roomService.isCreatorAdmin(pendingRoomCode, 'pending-creator', pendingAdminToken), true, 'pending creator admission should bind the persisted management identity');
  assert.equal(roomService.isCreatorAdmin(pendingRoomCode, 'restart-race-attacker', pendingAdminToken), false, 'management credentials must not bind to a different member after creator admission');
  assert.equal(await roomService.getJoinRejection(pendingRoomCode, 'pending-guest'), null, 'creator admission should open the room to guests');
  await flushRoomPersistence();
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
}

function runWorker(workerMode, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptFile], {
      cwd: serverRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        VERIFY_ROOM_RESTART_MODE: workerMode,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`room restart ${workerMode} worker failed (${code}): ${stderr || stdout}`));
        return;
      }
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}';
      resolve(JSON.parse(line));
    });
  });
}

if (mode === 'create') {
  await runCreateWorker();
} else if (mode === 'restore') {
  await runRestoreWorker();
} else {
  const roomCode = `RESTART${Date.now().toString(36).slice(-6).toUpperCase()}`;
  const storeFile = path.join(serverRoot, 'data', `verify-room-restart-${Date.now()}.json`);
  const sharedEnv = {
    ROOM_STORE_FILE: storeFile,
    ROOM_STORE_WRITE_DELAY_MS: '10',
    ROOM_RECONNECT_GRACE_MS: '60000',
    ROOM_HOST_RECONNECT_GRACE_MS: '30000',
    VERIFY_ROOM_RESTART_CODE: roomCode,
  };
  const credentials = await runWorker('create', sharedEnv);
  const rawStore = fs.readFileSync(storeFile, 'utf8');
  assert.ok(rawStore.includes('reconnectMembers'), 'room snapshot should persist reconnect metadata');
  assert.ok(rawStore.includes('hostReconnectUntil'), 'room snapshot should persist the host reservation deadline');
  assert.ok(rawStore.includes('hostAssignment'), 'room snapshot should persist manual versus automatic host assignment');
  assert.ok(rawStore.includes('"autoPlayNext"'), 'room snapshot should persist automatic playlist advance');
  assert.ok(rawStore.includes('creatorPending'), 'room snapshot should persist pending creator admission');
  assert.ok(rawStore.includes('creatorMemberId'), 'room snapshot should remain compatible while persisting creator identity bindings');
  assert.ok(rawStore.includes('adminMemberId'), 'room snapshot should persist the current room manager');
  assert.ok(rawStore.includes('adminAssignment'), 'room snapshot should persist automatic management takeover state');
  assert.ok(rawStore.includes('adminReconnectUntil'), 'room snapshot should persist management reconnect grace');
  assert.ok(rawStore.includes('scrypt$'), 'new room passwords should use the memory-hard password hash format');
  assert.ok(!rawStore.includes(credentials.hostReconnectToken), 'room snapshot must not contain the host reconnect token plaintext');
  assert.ok(!rawStore.includes(credentials.guestReconnectToken), 'room snapshot must not contain the guest reconnect token plaintext');
  assert.ok(!rawStore.includes(credentials.pendingAdminToken), 'room snapshot must not contain the creator admin token plaintext');
  assert.ok(!rawStore.includes(credentials.pendingRecoveryCode), 'room snapshot must not contain the creator recovery code plaintext');
  const legacyStore = JSON.parse(rawStore);
  const legacyRoom = legacyStore.rooms.find((room) => room.roomCode === roomCode);
  assert.equal(legacyRoom?.autoPlayNext, true, 'the persisted room should retain automatic playlist advance before restart');
  const legacyLocalItem = legacyRoom?.playlist.find((item) => item.id === 'restart-local-video');
  assert.ok(legacyLocalItem, 'restart fixture should contain a local video');
  legacyLocalItem.pageUrl = 'blob:https://legacy.example/stale-page-token';
  legacyLocalItem.sourceUrl = 'blob:https://legacy.example/stale-source-token';
  legacyLocalItem.refererUrl = 'https://legacy.example/private-referer';
  legacyLocalItem.finalUrl = 'https://legacy.example/private-final';
  fs.writeFileSync(storeFile, JSON.stringify(legacyStore), 'utf8');
  await runWorker('restore', {
    ...sharedEnv,
    VERIFY_ROOM_RESTART_HOST_TOKEN: credentials.hostReconnectToken,
    VERIFY_ROOM_RESTART_GUEST_TOKEN: credentials.guestReconnectToken,
    VERIFY_ROOM_RESTART_PENDING_ADMIN_TOKEN: credentials.pendingAdminToken,
  });
  const restoredStore = fs.readFileSync(storeFile, 'utf8');
  assert.ok(restoredStore.includes('pending-creator'), 'creator binding established after restart should be persisted for the next process');
  console.log(`room restart verification passed: ${roomCode}`);
}
