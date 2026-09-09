import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const serverRoot = process.cwd();

async function isPortClosed(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`);
    return false;
  } catch (error) {
    return true;
  }
}

async function pickTestPort() {
  const base = 45980;
  for (let offset = 0; offset < 80; offset += 1) {
    const port = base + offset;
    if (await isPortClosed(port)) return port;
  }
  throw new Error('failed to find a closed local test port');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(baseUrl, getExitCode) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const exitCode = getExitCode();
    if (exitCode !== null) throw new Error(`server process exited before health check passed: ${exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const body = await response.json();
      if (response.ok && body.ok === true) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw lastError || new Error('server health check did not become ready');
}

const port = await pickTestPort();
const baseUrl = `http://127.0.0.1:${port}`;
const storeFile = path.join(serverRoot, 'data', `verify-origin-policy-${Date.now()}.json`);
const allowedOrigin = 'https://watch.example.com';
const secondAllowedOrigin = 'https://admin.example.com';
const deniedOrigin = 'https://evil.example.net';
const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: serverRoot,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    PUBLIC_ORIGIN: `${allowedOrigin}, ${secondAllowedOrigin}/`,
    ROOM_STORE_FILE: storeFile,
    ROOM_STORE_WRITE_DELAY_MS: '10',
    PARSE_RATE_LIMIT_PER_MINUTE: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let childExitCode = null;
child.stdout.on('data', (chunk) => { output += chunk.toString(); });
child.stderr.on('data', (chunk) => { output += chunk.toString(); });
child.once('exit', (code, signal) => {
  childExitCode = signal || code;
});

try {
  await waitForHealth(baseUrl, () => childExitCode);

  const allowedApi = await fetch(`${baseUrl}/api/health`, { headers: { origin: allowedOrigin } });
  assert.equal(allowedApi.status, 200);
  assert.equal(allowedApi.headers.get('access-control-allow-origin'), allowedOrigin);

  const secondAllowedApi = await fetch(`${baseUrl}/api/health`, { headers: { origin: secondAllowedOrigin } });
  assert.equal(secondAllowedApi.status, 200);
  assert.equal(secondAllowedApi.headers.get('access-control-allow-origin'), secondAllowedOrigin);

  const deniedApi = await fetch(`${baseUrl}/api/health`, { headers: { origin: deniedOrigin } });
  assert.equal(deniedApi.status, 200);
  assert.equal(deniedApi.headers.get('access-control-allow-origin'), null);

  const noOriginApi = await fetch(`${baseUrl}/api/health`);
  assert.equal(noOriginApi.status, 200);

  const allowedSocket = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&t=origin-allowed`, { headers: { origin: allowedOrigin } });
  assert.equal(allowedSocket.status, 200);

  const deniedSocket = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&t=origin-denied`, { headers: { origin: deniedOrigin } });
  assert.notEqual(deniedSocket.status, 200);

  console.log('origin policy verification passed');
} catch (error) {
  console.error(output);
  throw error;
} finally {
  if (childExitCode === null) child.kill('SIGTERM');
}
