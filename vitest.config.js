import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Humo compartido en test/; Persona 2 suma tests/persona2/. El resto puede
    // colocar *.test.js junto a su código.
    include: [
      'test/**/*.test.js',
      'tests/**/*.test.js',
      'src/**/*.test.js',
      'scripts/**/*.test.js',
    ],
    testTimeout: 10_000,
  },
});
