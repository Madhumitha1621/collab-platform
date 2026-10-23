import { defineConfig } from '@playwright/test';

const API_PORT = 4100;
const COLLAB_PORT = 1334;
const WEB_PORT = 5180;

export const E2E = {
  api: `http://localhost:${API_PORT}/graphql`,
  web: `http://localhost:${WEB_PORT}`,
};

/**
 * Browser end-to-end tests. Starts a dedicated API (against the test database) and web dev
 * server on their own ports, so they never interfere with a running dev setup.
 * Uses the locally installed Chrome by default (PW_CHANNEL= to use Playwright's Chromium).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: E2E.web,
    channel: process.env.PW_CHANNEL ?? 'chrome',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  webServer: [
    {
      command: 'npx ts-node --transpile-only src/main.ts',
      cwd: 'apps/server',
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PORT: String(API_PORT),
        COLLAB_PORT: String(COLLAB_PORT),
        DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://collab:collab@localhost:5433/collab_test',
        JWT_SECRET: 'e2e-secret-not-for-production',
        CORS_ORIGIN: E2E.web,
        WEB_URL: E2E.web,
        PERSIST_FLUSH_MS: '200',
        REDIS_URL: '',
      },
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      cwd: 'apps/web',
      url: E2E.web,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_API_URL: E2E.api,
        VITE_COLLAB_URL: `ws://localhost:${COLLAB_PORT}`,
      },
    },
  ],
});
