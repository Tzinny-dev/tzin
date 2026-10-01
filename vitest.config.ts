import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Agent tooling (kilo/kilocode) leaves git worktrees inside the repo; they
    // hold stale copies of the suite and get picked up by the default glob.
    exclude: ['**/node_modules/**', '**/dist/**', '.kilo/**', '.kilocode/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 70,
      },
    },
  },
})