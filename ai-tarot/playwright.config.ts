import { defineConfig } from '@playwright/test'
import { existsSync } from 'node:fs'

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
  ?? (existsSync('/snap/bin/chromium') ? '/snap/bin/chromium' : undefined)

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    ...(executablePath ? { launchOptions: { executablePath } } : { channel: 'chrome' }),
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    port: 4173,
    reuseExistingServer: false,
    env: {
      VITE_API_BASE_URL: '/api',
      VITE_LOCAL_MOCK_AUTH: 'true',
    },
  },
})
