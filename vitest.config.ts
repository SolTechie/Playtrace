import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 15000,
    hookTimeout: 30000,
    pool: 'forks',
    maxWorkers: 1,
  },
});
