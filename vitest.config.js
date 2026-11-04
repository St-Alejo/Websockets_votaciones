import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Humo compartido en test/; cada persona coloca sus tests junto a su código (*.test.js).
    include: ['test/**/*.test.js', 'src/**/*.test.js', 'scripts/**/*.test.js'],
    testTimeout: 10_000,
  },
});
