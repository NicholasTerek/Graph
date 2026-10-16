import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:3101",
    viewport: { width: 1440, height: 1000 },
    headless: true,
    video: process.env.GRAPH_RECORD_DEMO
      ? { mode: "on", size: { width: 1280, height: 900 } }
      : "off",
    launchOptions: { slowMo: process.env.GRAPH_RECORD_DEMO ? 140 : 0 },
  },
  webServer: {
    command: "node --import tsx scripts/browser-server.ts",
    url: "http://127.0.0.1:3101/api/health",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
