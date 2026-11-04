import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'test/**/*.test.js',
      'tests/**/*.test.js',
      'src/**/*.test.js',
      'scripts/**/*.test.js',
    ],
    testTimeout: 10_000,
  },
});
