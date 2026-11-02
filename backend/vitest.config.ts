import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Config is validated at import time, so these must exist before any module
    // under test loads. DB 15 is used so a test run cannot touch dev data.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://localhost:5432/outbox',
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15',
      JWT_SECRET: 'test-secret-value-that-is-long-enough',
      ELASTICSEARCH_ENABLED: 'false',
      MIN_DELAY_BETWEEN_EMAILS_MS: '2000',
      MAX_EMAILS_PER_HOUR_PER_SENDER: '200',
      MAX_EMAILS_PER_HOUR: '0',
    },
    include: ['tests/**/*.test.ts'],
    // The limiter suite asserts on shared Redis keys, so files must not
    // interleave against the same database.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
