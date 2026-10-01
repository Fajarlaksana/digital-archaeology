import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['tests/setup/global-db.ts'],
    hookTimeout: 30_000,
  },
})
