import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.ROOM_STORE_ENABLED = 'false';
delete process.env.ROOM_MAX_MEMBERS;
// Legacy environment variables and JavaScript callers cannot enable a hidden bypass.
process.env.DEVELOPER_MEDIA_ENABLED = 'true';
process.env.DEVELOPER_MEDIA_KEY = 'public-negative-fixture-'.repeat(3);
process.env.HLS_PROXY_ALLOWED_HOSTS = 'media.example.com';
const { env } = await import('../dist/config/env.js');
const { roomService } = await import('../dist/services/room.service.js');
const { isVerifiedDirectMediaUrl } = await import('../dist/services/parser.service.js');
const { issueMediaProxyGrant, registerMediaProxySession, revokeMediaProxySession, createMediaProxyClientBinding } = await import('../dist/routes/proxy.routes.js');

assert.equal('developerMediaEnabled' in env, false);
assert.equal('developerMediaKey' in env, false);
const root = path.resolve('..');
const forbidden = /devmod|developerMedia|developerKey|DEVELOPER_MEDIA|allowDeveloperPublic|developer_access_denied|developer_public/;
for (const directory of ['assets/js', 'server/src']) {
  for (const entry of fs.readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:js|ts)$/.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), forbidden, `public runtime must not contain bypass code: ${path.relative(root, file)}`);
  }
}
for (const file of ['room.html', 'index.html', '.env.example', 'server/.env.example', 'docker-compose.yml']) {
  assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), forbidden, file);
}
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'assets/interactions/catalog.json'), 'utf8')).items.map(item => item.id),
  ['heart', 'fireworks', 'sakura', 'birthday', 'question']);

registerMediaProxySession('public-boundary-test', 'PUBLIC-TEST', 'creator', createMediaProxyClientBinding('127.0.0.1', 'test'));
try {
  for (const [routeName, url] of [
    ['media', 'https://unlisted.example.org/test.mp4'],
    ['hls', 'https://unlisted.example.org/test.m3u8'],
  ]) {
    assert.equal(isVerifiedDirectMediaUrl(url), false);
    assert.throws(() => issueMediaProxyGrant(routeName, url, '', {
      sessionId: 'public-boundary-test', allowDeveloperPublic: true, allowVerifiedDirect: true,
    }), /白名单/, 'unknown legacy options cannot grant unverified media');
  }
  for (const url of ['http://127.0.0.1/a.mp4', 'http://169.254.169.254/a.mp4', 'https://[::1]/a.mp4', 'https://user:password@example.org/a.mp4', 'https://example.org:8443/a.mp4']) {
    assert.throws(() => issueMediaProxyGrant('media', url, '', { sessionId: 'public-boundary-test', allowDeveloperPublic: true }));
  }
} finally {
  revokeMediaProxySession('public-boundary-test');
}

assert.equal(env.roomMaxMembers, 100);
assert.ok(env.roomMaxReconnectEntries >= 100);
const created = roomService.createRoom('CAPACITY100', 'Capacity 100');
assert.ok(created);
for (let index = 0; index < 100; index++) {
  const adminToken = index === 0 ? created.credentials.adminToken : undefined;
  assert.equal(await roomService.getJoinRejection('CAPACITY100', `member-${index}`, undefined, adminToken), null);
  roomService.joinRoom({ roomCode: 'CAPACITY100', memberId: `member-${index}`, socketId: `socket-${index}`, name: `Member ${index}`, adminToken });
}
assert.equal(roomService.getRoom('CAPACITY100').members.length, 100);
assert.equal((await roomService.getJoinRejection('CAPACITY100', 'overflow')).code, 'room_full');
const reconnectToken = roomService.claimPendingMemberReconnectToken('CAPACITY100', 'member-99');
roomService.leaveBySocket('socket-99');
assert.equal((await roomService.getJoinRejection('CAPACITY100', 'overflow')).code, 'room_full');
assert.equal(await roomService.getJoinRejection('CAPACITY100', 'member-99', undefined, undefined, reconnectToken), null);
roomService.joinRoom({ roomCode: 'CAPACITY100', memberId: 'member-99', socketId: 'socket-rejoined', reconnectToken });
assert.equal(roomService.getRoom('CAPACITY100').members.length, 100);
console.log('Public runtime boundary and 100-member capacity passed');
