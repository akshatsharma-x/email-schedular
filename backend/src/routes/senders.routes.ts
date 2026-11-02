import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { env } from '../config/env.js';
import { currentUser, requireAuth } from '../auth/middleware.js';
import { db } from '../db/client.js';
import { senders } from '../db/schema.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { effectiveHourlyLimit, listAllSenders } from '../mailer/senderPool.js';
import { peek } from '../ratelimit/limiter.js';

const log = logger.child({ mod: 'routes:senders' });

export const sendersRouter = Router();
sendersRouter.use(requireAuth);

/**
 * GET /api/senders
 *
 * Returns each sender with its *live* hourly usage read straight from the Redis
 * counters the limiter uses. This is the panel that makes rate limiting
 * demonstrable: you can watch `used` climb and `remaining` fall as a campaign
 * runs, and see exactly when the window resets.
 */
sendersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const rows = await listAllSenders(user.id);

    const withUsage = await Promise.all(
      rows.map(async (s) => {
        const usage = await peek(user.id, s.id);
        const limit = effectiveHourlyLimit(s, null);
        return {
          id: s.id,
          label: s.label,
          fromName: s.fromName,
          fromEmail: s.fromEmail,
          smtpHost: s.smtpHost,
          smtpPort: s.smtpPort,
          isActive: s.isActive,
          disabledUntil: s.disabledUntil?.toISOString() ?? null,
          consecutiveFailures: s.consecutiveFailures,
          hourlyLimit: limit,
          hourlyUsed: usage.senderUsed,
          hourlyRemaining: Math.max(0, limit - usage.senderUsed),
          nextSendAllowedAt:
            usage.nextSendAllowedAt > Date.now()
              ? new Date(usage.nextSendAllowedAt).toISOString()
              : null,
          createdAt: s.createdAt.toISOString(),
        };
      }),
    );

    res.json({
      senders: withUsage,
      limits: {
        perSenderHourlyDefault: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
        tenantHourly: env.MAX_EMAILS_PER_HOUR,
        minDelayMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
        workerConcurrency: env.WORKER_CONCURRENCY,
      },
    });
  }),
);

/**
 * POST /api/senders/ethereal
 *
 * Provisions a throwaway Ethereal mailbox and stores it as a sender. Having this
 * in the API (not just the CLI script) means a reviewer can add senders from the
 * dashboard during the demo without touching a terminal.
 */
sendersRouter.post(
  '/ethereal',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const body = z
      .object({
        label: z.string().trim().min(1).max(100).optional(),
        maxEmailsPerHour: z.coerce.number().int().min(1).max(100_000).optional(),
      })
      .parse(req.body ?? {});

    const account = await nodemailer.createTestAccount();
    const existing = await listAllSenders(user.id);

    const [row] = await db
      .insert(senders)
      .values({
        userId: user.id,
        label: body.label ?? `Ethereal sender ${existing.length + 1}`,
        fromName: user.name,
        fromEmail: account.user,
        smtpHost: account.smtp.host,
        smtpPort: account.smtp.port,
        smtpSecure: account.smtp.secure,
        smtpUser: account.user,
        smtpPass: account.pass,
        maxEmailsPerHour: body.maxEmailsPerHour ?? null,
      })
      .returning();

    if (!row) throw badRequest('Could not create sender');
    log.info({ senderId: row.id, fromEmail: row.fromEmail }, 'ethereal sender provisioned');

    res.status(201).json({
      sender: {
        id: row.id,
        label: row.label,
        fromEmail: row.fromEmail,
        smtpHost: row.smtpHost,
        isActive: row.isActive,
      },
      // Shown once so the reviewer can log into Ethereal's web UI and read the
      // actual delivered mail.
      etherealLogin: { user: account.user, pass: account.pass, url: 'https://ethereal.email/login' },
    });
  }),
);

const patchBody = z.object({
  isActive: z.boolean().optional(),
  maxEmailsPerHour: z.coerce.number().int().min(1).max(100_000).nullable().optional(),
  label: z.string().trim().min(1).max(100).optional(),
});

/** PATCH /api/senders/:id -- toggle active, change the per-sender hourly cap. */
sendersRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = z.string().uuid().parse(req.params.id);
    const patch = patchBody.parse(req.body ?? {});

    const [row] = await db
      .update(senders)
      .set({
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.maxEmailsPerHour !== undefined
          ? { maxEmailsPerHour: patch.maxEmailsPerHour }
          : {}),
        // Re-enabling a sender clears its tripped breaker.
        ...(patch.isActive === true ? { disabledUntil: null, consecutiveFailures: 0 } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(senders.id, id), eq(senders.userId, user.id)))
      .returning();

    if (!row) throw notFound('Sender not found');
    res.json({ sender: { id: row.id, label: row.label, isActive: row.isActive, maxEmailsPerHour: row.maxEmailsPerHour } });
  }),
);
