import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Each file mutates process.env and process.cwd(); isolate them so a
    // memoized Settings singleton in one file cannot leak into another.
    fileParallelism: false,
    environment: 'node',
  },
});
