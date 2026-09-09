import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_TEST_PORT || 4173);
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${port}`;

function findChromiumExecutable() {
  const configured = String(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '').trim();
  if (configured) {
    if (!fs.existsSync(configured)) {
      throw new Error(`PLAYWRIGHT_CHROMIUM_EXECUTABLE does not exist: ${configured}`);
    }
    return configured;
  }

  if (process.platform !== 'win32') return undefined;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

const executablePath = findChromiumExecutable();

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.mjs',
  globalSetup: './e2e/global-setup.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 12_000 },
  reporter: 'line',
  outputDir: path.join(os.tmpdir(), 'together-see-playwright-results'),
  use: {
    baseURL,
    headless: process.env.PLAYWRIGHT_HEADED !== '1',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ['--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
