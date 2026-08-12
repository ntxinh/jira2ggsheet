import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // 'cloudflare:workers' only exists inside the Cloudflare runtime; tests use a stub so
      // SyncCoordinator can extend DurableObject without a workerd process.
      'cloudflare:workers': './tests/mock-cloudflare-workers.ts',
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true,
  },
})
