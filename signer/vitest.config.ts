import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['tests/setup/global-db.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // The vault is a singleton row: test files must not run against it concurrently.
    fileParallelism: false,
  },
})
