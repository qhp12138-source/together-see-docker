import { once } from 'node:events';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    once(child, 'exit').then(() => true),
    sleep(timeoutMs).then(() => false),
  ]);
}

export default async function globalSetup() {
  const port = Number(process.env.PLAYWRIGHT_TEST_PORT || 4173);
  const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['scripts/e2e-server.mjs'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      PLAYWRIGHT_TEST_PORT: String(port),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });

  let startupError;
  child.once('error', (error) => { startupError = error; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Together See E2E server exited before startup (${child.exitCode ?? child.signalCode})`);
    }
    try {
      const response = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) break;
    } catch {
      // Keep polling until the bounded startup deadline.
    }
    await sleep(100);
  }
  try {
    const response = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error(`health returned ${response.status}`);
  } catch (error) {
    child.kill('SIGTERM');
    throw new Error(`Together See E2E server did not become ready: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  return async () => {
    try {
      await fetch(`${baseURL}/api/e2e/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // The server may already have stopped after a test setup failure.
    }
    if (await waitForExit(child, 3000)) return;
    child.kill('SIGTERM');
    if (await waitForExit(child, 3000)) return;
    child.kill('SIGKILL');
    await waitForExit(child, 3000);
  };
}
