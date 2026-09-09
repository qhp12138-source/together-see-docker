import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config.mjs';

const soakMinutes = Number(process.env.TOGETHER_SEE_SOAK_MINUTES || 30);
const timeout = Math.ceil((soakMinutes * 60_000) + (8 * 60_000));

export default defineConfig({
  ...baseConfig,
  testMatch: 'long-play.gate.mjs',
  timeout,
  expect: { timeout: 60_000 },
  reporter: 'line',
});
