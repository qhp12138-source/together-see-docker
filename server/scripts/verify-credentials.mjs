import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const projectRoot = path.resolve(process.cwd(), '..');
const source = fs.readFileSync(path.join(projectRoot, 'assets/js/site.js'), 'utf8');
const credentialSource = fs.readFileSync(path.join(projectRoot, 'assets/js/credentials.js'), 'utf8');
const instrumented = source.replace(
  /\n\}\)\(\);\s*$/,
  '\n  window.__credentialTest = { randomRecoveryCode, randomUrlSafeToken };\n})();',
);
assert.notEqual(instrumented, source, 'site credential helpers should be instrumentable for contract testing');
assert.match(source, /function saveRoomPassword\(roomName, password\)[\s\S]*sessionStorage\.removeItem\(ROOM_PASSWORD_PREFIX \+ roomName\)/, 'creating an unprotected replacement room should clear a stale tab password');
assert.match(source, /function saveRoomAdminCredentials[\s\S]*stageCreated\(adminToken, recoveryCode\)/, 'HTTP creation success should stage credentials without deleting the pending fallback');

class MemoryStorage {
  constructor(options = {}) {
    this.values = new Map();
    this.failWrites = options.failWrites === true;
  }

  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) {
    if (this.failWrites) throw new Error('storage write blocked');
    this.values.set(key, String(value));
  }
  removeItem(key) { this.values.delete(key); }
}

const sharedLocalStorage = new MemoryStorage();
const homeSessionStorage = new MemoryStorage();

const window = {
  crypto: webcrypto,
  btoa(value) { return Buffer.from(value, 'binary').toString('base64'); },
  localStorage: sharedLocalStorage,
  sessionStorage: homeSessionStorage,
};
const document = {
  querySelector() { return null; },
  querySelectorAll() { return []; },
  addEventListener() {},
};
const context = vm.createContext({
  AbortController,
  Array,
  Buffer,
  Date,
  Error,
  Math,
  Object,
  String,
  Uint8Array,
  URLSearchParams,
  document,
  window,
});
vm.runInContext(credentialSource, context, { filename: 'credentials.js' });
vm.runInContext(instrumented, context, { filename: 'site.js' });

const helpers = window.__credentialTest;
assert.ok(helpers, 'credential helpers should be available in the verification context');

const recoveryCodes = new Set();
for (let index = 0; index < 4096; index += 1) {
  const recoveryCode = helpers.randomRecoveryCode();
  const cleanCode = recoveryCode.replace(/-/g, '');
  assert.match(recoveryCode, /^(?:[A-HJ-NP-Z2-9]{5}-){4}[A-HJ-NP-Z2-9]{5}$/);
  assert.match(cleanCode, /^[A-Z0-9_]{20,80}$/, 'generated recovery code must satisfy the room creation route');
  recoveryCodes.add(recoveryCode);
}
assert.ok(recoveryCodes.size > 4000, 'recovery codes should have high sample diversity');

for (let index = 0; index < 512; index += 1) {
  assert.match(helpers.randomUrlSafeToken(24), /^[A-Za-z0-9_-]{32,120}$/);
}

const credentials = window.TogetherSeeCredentials;
assert.ok(credentials?.createRoomCredentialStore, 'shared credential storage helpers should load before page code');
let now = 1_000_000;
const roomCode = '20260729';
const adminToken = 'A'.repeat(32);
const recoveryCode = 'ABCDE-FGHIJ-KLMNO-PQRST-UVWXY';
const pendingTokenKey = `together-see:room-creation-token:${roomCode}`;
const pendingRecoveryKey = `together-see:room-creation-recovery:${roomCode}`;
const pendingExpiresKey = `together-see:room-creation-expires:${roomCode}`;
const activeTokenKey = `together-see:room-admin:${roomCode}`;
const activeRecoveryKey = `together-see:room-admin-recovery:${roomCode}`;

const homeStore = credentials.createRoomCredentialStore(roomCode, {
  localStorage: sharedLocalStorage,
  sessionStorage: homeSessionStorage,
  now: () => now,
});
homeStore.savePending(adminToken, recoveryCode);
const staged = homeStore.stageCreated(adminToken, recoveryCode);
assert.equal(staged.sessionVerified, true, 'the home page should verify its sessionStorage write immediately');
assert.equal(sharedLocalStorage.getItem(pendingTokenKey), adminToken, 'HTTP 201 must not clear the durable pending token before Socket admission');
assert.equal(sharedLocalStorage.getItem(pendingRecoveryKey), recoveryCode);
assert.ok(Number(sharedLocalStorage.getItem(pendingExpiresKey)) > now, 'pending credentials should have a bounded lifetime');

const mobileNavigationSession = new MemoryStorage();
const mobileRoomStore = credentials.createRoomCredentialStore(roomCode, {
  localStorage: sharedLocalStorage,
  sessionStorage: mobileNavigationSession,
  now: () => now,
});
assert.equal(mobileRoomStore.loadAdminToken(), adminToken, 'a mobile navigation that loses sessionStorage should recover from pending localStorage');
assert.equal(mobileNavigationSession.getItem(activeTokenKey), adminToken, 'recovered pending credentials should be promoted into the new page session');
assert.equal(sharedLocalStorage.getItem(pendingTokenKey), adminToken, 'navigation alone must not consume the pending credential');

const preAdmissionRefreshSession = new MemoryStorage();
const refreshedRoomStore = credentials.createRoomCredentialStore(roomCode, {
  localStorage: sharedLocalStorage,
  sessionStorage: preAdmissionRefreshSession,
  now: () => now,
});
assert.equal(refreshedRoomStore.loadAdminToken(), adminToken, 'refresh before first Socket admission should remain recoverable');

const finalized = mobileRoomStore.finalizeCreated(adminToken, recoveryCode);
assert.equal(finalized.cleared, true, 'the first admitted room page should commit and clear matching pending credentials');
assert.equal(sharedLocalStorage.getItem(pendingTokenKey), null);
assert.equal(sharedLocalStorage.getItem(pendingRecoveryKey), null);
assert.equal(sharedLocalStorage.getItem(pendingExpiresKey), null);
assert.equal(mobileNavigationSession.getItem(activeTokenKey), adminToken, 'the admitted tab should retain its active management token');
assert.equal(sharedLocalStorage.getItem(activeRecoveryKey), recoveryCode, 'the recovery code should remain available after pending cleanup');

const fallbackRoom = 'android-webview-fallback';
const blockedSession = new MemoryStorage({ failWrites: true });
const fallbackHomeStore = credentials.createRoomCredentialStore(fallbackRoom, {
  localStorage: sharedLocalStorage,
  sessionStorage: blockedSession,
  now: () => now,
});
const fallbackStage = fallbackHomeStore.stageCreated('B'.repeat(32), recoveryCode);
assert.equal(fallbackStage.sessionVerified, false, 'a blocked sessionStorage write should not destroy the durable pending fallback');
const replacementSession = new MemoryStorage();
const fallbackRoomStore = credentials.createRoomCredentialStore(fallbackRoom, {
  localStorage: sharedLocalStorage,
  sessionStorage: replacementSession,
  now: () => now,
});
assert.equal(fallbackRoomStore.loadAdminToken(), 'B'.repeat(32), 'a new Android WebView context should recover after the original session write failed');

const expiringRoom = 'expired-pending-room';
const expiringStore = credentials.createRoomCredentialStore(expiringRoom, {
  localStorage: sharedLocalStorage,
  sessionStorage: new MemoryStorage(),
  now: () => now,
  pendingTtlMs: 1000,
});
expiringStore.savePending('C'.repeat(32), recoveryCode);
now += 1001;
assert.equal(expiringStore.getPending(), null, 'expired pending credentials must not remain usable');

console.log('credential verification passed');
