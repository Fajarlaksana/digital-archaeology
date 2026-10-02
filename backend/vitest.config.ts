import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['tests/setup/global-db.ts'],
    hookTimeout: 30_000,
    // Login tests run argon2id (64 MiB) many times; under parallel load 5 s is too tight.
    testTimeout: 30_000,
  },
})
