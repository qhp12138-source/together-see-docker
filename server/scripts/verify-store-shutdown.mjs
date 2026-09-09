import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const serverRoot = process.cwd();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pickTestPort() {
  const base = 43000 + Math.floor(Math.random() * 8000);
  for (let offset = 0; offset < 30; offset += 1) {
    const port = base + offset;
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`);
    } catch {
      return port;
    }
  }
  throw new Error('failed to find a closed local test port');
}

async function startServer(storeFile) {
  const port = await pickTestPort();
  const bootstrap = "process.on('message', message => { if (message === 'shutdown') process.emit('SIGTERM', 'SIGTERM'); }); await import('./dist/server.js');";
  const child = spawn(process.execPath, ['--input-type=module', '--eval', bootstrap], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      PUBLIC_ORIGIN: '*',
      ROOM_STORE_ENABLED: 'true',
      ROOM_STORE_FILE: storeFile,
      ROOM_STORE_WRITE_DELAY_MS: '60000',
      ROOM_STORE_SHUTDOWN_TIMEOUT_MS: '5000',
      ROOM_CREATE_RATE_LIMIT_PER_MINUTE: '20',
      PARSE_RATE_LIMIT_PER_MINUTE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited before health check (${child.exitCode}): ${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return { child, output: () => output, port };
    } catch {
      // Startup is still in progress.
    }
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error(`server did not become healthy: ${output}`);
}

async function createRoom(port, roomCode, adminToken, recoveryCode) {
  const response = await fetch(`http://127.0.0.1:${port}/api/rooms/${roomCode}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName: roomCode, adminToken, recoveryCode }),
  });
  assert.equal(response.status, 201);
}

async function stopServer(child) {
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  if (os.platform() === 'win32') child.send('shutdown');
  else child.kill('SIGTERM');
  const result = await Promise.race([exit, sleep(8000).then(() => null)]);
  if (!result) {
    child.kill('SIGKILL');
    throw new Error('server did not finish graceful shutdown within 8 seconds');
  }
  return result;
}

const successFile = path.join(os.tmpdir(), `together-see-shutdown-${process.pid}-${Date.now()}.json`);
const successRoom = 'SHUTDOWNSUCCESS';
const successAdminToken = 'S'.repeat(32);
const successRecoveryCode = 'ABCDE-FGHIJ-KLMNO-PQRST';
const successServer = await startServer(successFile);
await createRoom(successServer.port, successRoom, successAdminToken, successRecoveryCode);
const successExit = await stopServer(successServer.child);
assert.deepEqual(successExit, { code: 0, signal: null });
const successSnapshot = fs.readFileSync(successFile, 'utf8');
assert.ok(successSnapshot.includes(successRoom), 'SIGTERM must flush the newest room generation before exit');
assert.equal(successSnapshot.includes(successAdminToken), false, 'shutdown snapshot must not contain the admin token plaintext');
assert.equal(successSnapshot.includes(successRecoveryCode), false, 'shutdown snapshot must not contain the recovery code plaintext');
assert.match(successServer.output(), /"event":"server_shutdown_complete"/);
fs.rmSync(successFile, { force: true });

const blockedParent = path.join(os.tmpdir(), `together-see-shutdown-blocked-${process.pid}-${Date.now()}`);
const blockerSecret = 'blocked-parent-secret';
fs.writeFileSync(blockedParent, blockerSecret, 'utf8');
const failedStoreFile = path.join(blockedParent, 'rooms.json');
const failedRoom = 'SHUTDOWNFAILURE';
const failedAdminToken = 'F'.repeat(32);
const failedRecoveryCode = 'UVWXY-Z1234-56789-ABCDE';
const failedServer = await startServer(failedStoreFile);
await createRoom(failedServer.port, failedRoom, failedAdminToken, failedRecoveryCode);
const failedExit = await stopServer(failedServer.child);
assert.notEqual(failedExit.code, 0, 'a failed final persistence generation must use a nonzero exit code');
const failedOutput = failedServer.output();
assert.match(failedOutput, /"event":"server_shutdown_failed","reason":"persistence"/);
for (const secret of [blockerSecret, failedRoom, failedAdminToken, failedRecoveryCode]) {
  assert.equal(failedOutput.includes(secret), false, 'shutdown diagnostics must not expose room or credential data');
}
assert.equal(fs.readFileSync(blockedParent, 'utf8'), blockerSecret);
fs.rmSync(blockedParent, { force: true });

console.log('store shutdown verification passed');
