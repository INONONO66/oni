import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test-e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "/tmp/oni-playwright-results",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  forbidOnly: true,
});
