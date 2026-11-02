import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
// Named import: pino-http is CJS with `module.exports = fn`, so its `default`
// is not callable under NodeNext resolution.
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { attachUser } from './auth/middleware.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { mountBullBoard } from './admin/bullboard.js';
import { attachmentsRouter } from './routes/attachments.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { campaignsRouter } from './routes/campaigns.routes.js';
import { emailsRouter, leadsRouter } from './routes/emails.routes.js';
import { sendersRouter } from './routes/senders.routes.js';
import { slackRouter } from './routes/slack.routes.js';
import { systemRouter } from './routes/system.routes.js';

/**
 * Express app assembly. Kept separate from server.ts so tests can mount the app
 * without binding a port.
 */
export function createApp(): Express {
  const app = express();

  // Behind a proxy/ingress, trust X-Forwarded-* so `secure` cookies and client
  // IPs are correct in production.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // bull-board serves its own inline-styled UI; the default CSP blocks it.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      // The dashboard runs on a different origin and embeds attachment images
      // served from here. Helmet's default `same-origin` policy blocks those
      // with ERR_BLOCKED_BY_RESPONSE.NotSameOrigin. Reads are still gated by
      // the session cookie and scoped to the owning user, so relaxing the
      // embedding policy does not widen who can fetch a file.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      // Explicit origin (not `*`) because the session travels as a cookie and
      // credentialed CORS forbids a wildcard.
      origin: [env.FRONTEND_URL],
      credentials: true,
    }),
  );

  app.use(
    pinoHttp({
      logger,
      // Health checks and the metrics scrape would otherwise drown the log.
      autoLogging: {
        ignore: (req) =>
          req.url === '/health' || req.url === '/metrics' || req.url === '/api/events',
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  // 12 MB: a lead list is posted as a JSON string, and 100k addresses is ~3 MB.
  app.use(express.json({ limit: '12mb' }));
  app.use(cookieParser());
  app.use(attachUser);

  // Health, readiness, metrics, SSE, queue stats.
  app.use(systemRouter);

  app.use('/api/attachments', attachmentsRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/campaigns', campaignsRouter);
  app.use('/api/emails', emailsRouter);
  app.use('/api/leads', leadsRouter);
  app.use('/api/senders', sendersRouter);
  app.use('/api/slack', slackRouter);

  // Live queue dashboard.
  mountBullBoard(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
