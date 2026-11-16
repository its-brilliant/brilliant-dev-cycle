import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The suite must never reach the real Herdr app or the person's hc (v1 opened real tabs).
    env: { BDC_HOME: '.test-home', HC_SOCKET: '/nonexistent/bdc-test-hc.sock' },
    testTimeout: 20_000,
  },
});
