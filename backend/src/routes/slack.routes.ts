import { Router } from 'express';
import { z } from 'zod';
import { env, slackOAuthConfigured } from '../config/env.js';
import { currentUser, requireAuth } from '../auth/middleware.js';
import { asyncHandler } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { slackNotifications } from '../lib/metrics.js';
import { buildInstallUrl, completeInstall, disconnect, getIntegration } from '../integrations/slack/oauth.js';
import { sendTestMessage } from '../integrations/slack/notify.js';

const log = logger.child({ mod: 'routes:slack' });

export const slackRouter = Router();

/**
 * GET /api/slack/status
 *
 * Drives the dashboard's Connect/Disconnect button. Public-safe: returns the
 * workspace and channel name but never the token or webhook URL.
 */
slackRouter.get(
  '/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const integration = await getIntegration(user.id);
    const connected = Boolean(integration && !integration.revokedAt && integration.webhookUrl);
    res.json({
      configured: slackOAuthConfigured,
      connected,
      teamName: connected ? integration?.teamName : null,
      channel: connected ? integration?.channel : null,
      connectedAt: connected ? integration?.connectedAt.toISOString() : null,
      lastNotifiedAt: integration?.lastNotifiedAt?.toISOString() ?? null,
      // Surfaced so a user can tell "never connected" from "webhook revoked".
      revokedAt: integration?.revokedAt?.toISOString() ?? null,
    });
  }),
);

/** GET /api/slack/install -- begins the real Slack OAuth v2 flow. */
slackRouter.get(
  '/install',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.redirect(await buildInstallUrl(user.id));
  }),
);

const callbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

/**
 * GET /api/slack/callback
 *
 * Note this route is intentionally *not* behind requireAuth: the user arrives by
 * redirect from slack.com, and the signed `state` parameter carries (and proves)
 * their identity. Requiring the session cookie here would break the flow in any
 * browser that does not send cookies on a cross-site navigation.
 */
slackRouter.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const parsed = callbackQuery.parse(req.query);
    const back = (status: string, detail?: string) =>
      `${env.FRONTEND_URL}/dashboard?slack=${status}${
        detail ? `&detail=${encodeURIComponent(detail)}` : ''
      }`;

    if (parsed.error) {
      res.redirect(back('error', parsed.error));
      return;
    }
    if (!parsed.code || !parsed.state) {
      res.redirect(back('error', 'missing_code'));
      return;
    }

    try {
      const integration = await completeInstall(parsed.code, parsed.state);
      res.redirect(back('connected', integration.channel ?? undefined));
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'slack install failed');
      res.redirect(back('error', (err as Error).message));
    }
  }),
);

/** POST /api/slack/test -- proves the wiring without waiting for a real limit hit. */
slackRouter.post(
  '/test',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const outcome = await sendTestMessage(user.id);
    slackNotifications.inc({ outcome });
    res.status(outcome === 'sent' ? 200 : 409).json({ outcome });
  }),
);

/** POST /api/slack/disconnect */
slackRouter.post(
  '/disconnect',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    await disconnect(user.id);
    res.json({ ok: true });
  }),
);
