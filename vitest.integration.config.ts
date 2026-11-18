import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    globalSetup: ['tests/helpers/integration-lifecycle.ts'],
    // Stop after the first failed scenario; cleanup/drains still run.
    bail: 1,
  },
});
