import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Only this repository's suites; local host/history junctions are reference material.
    include: ['tests/**/*.spec.{ts,tsx}', 'adapters/**/*.spec.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
  },
})
