import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    pool: 'forks',
    // Integration tests serialise so executor spawns don't fight for ports + disk.
    poolOptions: { forks: { singleFork: true } },
    // Give each test up to 2 minutes — executor startup can be slow on cold caches.
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})
