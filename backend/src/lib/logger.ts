import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Structured logging. Pretty-printed in development, JSON everywhere else so a
 * log shipper can parse it. SMTP passwords and OAuth tokens are redacted at the
 * logger level rather than relying on every call site to remember.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'outbox-scheduler' },
  redact: {
    paths: [
      'smtpPass',
      'smtp_pass',
      'accessToken',
      'access_token',
      'webhookUrl',
      'webhook_url',
      'password',
      'req.headers.cookie',
      'req.headers.authorization',
      '*.smtpPass',
      '*.accessToken',
    ],
    censor: '[redacted]',
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
      : undefined,
});

export type Logger = typeof logger;
