import { createBullBoard } from '@bull-board/api';
// Subpath export declared in @bull-board/api's package exports map -- no `.js`
// suffix here, unlike this project's own relative imports.
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import type { Express, NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { emailQueue } from '../queue/queues.js';
import { verifySession } from '../auth/jwt.js';

const log = logger.child({ mod: 'bullboard' });

/**
 * Live BullMQ dashboard (required by the assignment).
 *
 * Mounted at BULLBOARD_PATH (default /admin/queues) and backed by the same
 * Queue instance the API uses, so it shows real waiting/active/delayed/failed
 * state in real time -- including the delayed set, which is where scheduled
 * emails sit until their send time, and the re-delayed jobs the rate limiter
 * pushed into the next window.
 *
 * Access control: the board exposes job payloads and lets an operator retry or
 * remove jobs, so it is gated on the same session cookie as the API rather than
 * left open. A separate HTTP-basic credential would be the next step if the
 * board needed to be reachable by someone without an app login.
 */
export function mountBullBoard(app: Express): void {
  if (!env.BULLBOARD_ENABLED) {
    log.info('bull-board disabled');
    return;
  }

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(env.BULLBOARD_PATH);

  createBullBoard({
    queues: [new BullMQAdapter(emailQueue)],
    serverAdapter,
    options: {
      uiConfig: {
        boardTitle: 'Outbox Scheduler',
        boardLogo: { path: '' },
      },
    },
  });

  app.use(env.BULLBOARD_PATH, requireSessionForBoard, serverAdapter.getRouter());
  log.info({ path: env.BULLBOARD_PATH }, 'bull-board mounted');
}

/**
 * The board is a browser page, so an unauthenticated visitor is redirected to
 * the login screen instead of receiving a JSON 401 they cannot act on.
 */
async function requireSessionForBoard(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Dev convenience: with the bypass on, the board is open locally so it can be
  // opened in a browser that has never logged in.
  if (env.DEV_AUTH_BYPASS) {
    next();
    return;
  }

  const token = req.cookies?.[env.SESSION_COOKIE_NAME];
  if (!token) {
    res.redirect(`${env.FRONTEND_URL}/login?error=${encodeURIComponent('Sign in to view the queue dashboard')}`);
    return;
  }
  try {
    await verifySession(token);
    next();
  } catch {
    res.redirect(`${env.FRONTEND_URL}/login?error=${encodeURIComponent('Session expired')}`);
  }
}
