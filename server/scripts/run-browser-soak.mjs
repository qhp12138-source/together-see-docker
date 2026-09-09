import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const weakSmoke = process.argv.includes('--weak-smoke');
const smoke = process.argv.includes('--smoke') || weakSmoke;
const configuredMinutes = Number(process.env.TOGETHER_SEE_SOAK_MINUTES || (smoke ? 0.2 : 30));

if (!Number.isFinite(configuredMinutes) || configuredMinutes <= 0) {
  throw new Error('TOGETHER_SEE_SOAK_MINUTES must be a positive number');
}
if (!smoke && configuredMinutes < 30) {
  throw new Error('The release soak gate cannot be shortened below 30 minutes; use --smoke for harness checks');
}

const cliPath = path.join(serverRoot, 'node_modules', '@playwright', 'test', 'cli.js');
const child = spawn(process.execPath, [cliPath, 'test', '--config', 'playwright.soak.config.mjs'], {
  cwd: serverRoot,
  env: {
    ...process.env,
    TOGETHER_SEE_SOAK_MINUTES: String(configuredMinutes),
    TOGETHER_SEE_SOAK_WEAK_GATE: weakSmoke ? '1' : (smoke ? '0' : (process.env.TOGETHER_SEE_SOAK_WEAK_GATE || '1')),
  },
  stdio: 'inherit',
  windowsHide: true,
});

child.once('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`browser soak terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
