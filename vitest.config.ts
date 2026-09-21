import { cpus } from "node:os";
import { defineConfig } from "vitest/config";

/**
 * Twelve of the test files drive a real browser, and a crawl inside one runs
 * up to four pages at once. With unbounded forks (the default is one per core)
 * a full run can ask for dozens of concurrent Chromium pages, which on a busy
 * machine starves them until a test exceeds its timeout: a flake with no bug
 * behind it. Bounding the workers costs wall time and buys determinism.
 */
const workers = Math.max(2, Math.min(4, Math.floor((cpus().length || 4) / 3)));

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: process.env.NAVVI_LIVE ? [] : ["tests/live.test.ts"],
    globalSetup: ["tests/storage-guard.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    maxWorkers: workers,
  },
});
