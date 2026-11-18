import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/ui/**/*.test.tsx', 'src/**/*.test.{ts,tsx}'],
    clearMocks: true,
    restoreMocks: true,
    // Large-file boundaries and jsdom share a finite local/CI memory budget.
    // Keep default 5s case deadlines; do not overlap files or build processes.
    fileParallelism: false,
  },
});
