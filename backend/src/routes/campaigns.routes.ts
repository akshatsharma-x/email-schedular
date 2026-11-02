import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { currentUser, requireAuth } from '../auth/middleware.js';
import { db } from '../db/client.js';
import { campaigns, emailJobs } from '../db/schema.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { parseLeads } from '../lib/leads.js';
import { cancelCampaign, scheduleCampaign } from '../queue/scheduler.js';

export const campaignsRouter = Router();
campaignsRouter.use(requireAuth);

/**
 * Schedule payload.
 *
 * Recipients arrive either as a parsed array (the normal path -- the client has
 * already called /api/leads/parse for its preview) or as the raw file contents,
 * which are then parsed here. Accepting both means the server never has to trust
 * a client-side parse, while the UI still gets to show a count before submitting.
 */
const scheduleBody = z
  .object({
    subject: z.string().trim().min(1, 'Subject is required').max(500),
    body: z.string().trim().min(1, 'Body is required').max(100_000),
    /** Rich-text body produced by the composer's editor. */
    bodyHtml: z.string().max(200_000).optional(),
    name: z.string().trim().max(200).optional(),
    /** Explicit From sender; omit to round-robin across all active senders. */
    senderId: z.string().uuid().optional(),
    attachmentIds: z.array(z.string().uuid()).max(5).optional(),

    recipients: z
      .array(
        z.object({
          email: z.string().email(),
          name: z.string().nullable().optional(),
        }),
      )
      .optional(),
    /** Raw CSV / text file contents, parsed server-side. */
    recipientsFile: z.string().max(10_000_000).optional(),

    /** When sending begins. Defaults to now. */
    startAt: z.coerce.date().optional(),
    /** Minimum gap between sends, ms. Falls back to the env default. */
    minDelayMs: z.coerce.number().int().min(0).max(3_600_000).optional(),
    /** Per-sender hourly cap for this campaign. Falls back to the env default. */
    maxPerHour: z.coerce.number().int().min(1).max(100_000).optional(),

    idempotencyKey: z.string().trim().min(8).max(200).optional(),
  })
  .refine((v) => v.recipients?.length || v.recipientsFile, {
    message: 'Provide either `recipients` or `recipientsFile`',
    path: ['recipients'],
  });

/** POST /api/campaigns -- the schedule API. */
campaignsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const input = scheduleBody.parse(req.body);

    // Server-side parse is authoritative, whichever shape arrived.
    const parsed = input.recipientsFile
      ? parseLeads(input.recipientsFile)
      : {
          leads: (input.recipients ?? []).map((r) => ({
            email: r.email.toLowerCase(),
            name: r.name ?? null,
          })),
          invalid: [],
          invalidCount: 0,
          duplicateCount: 0,
          totalRows: input.recipients?.length ?? 0,
        };

    if (parsed.leads.length === 0) {
      throw badRequest('No valid email addresses found in the recipient list', {
        invalidSamples: parsed.invalid,
        invalidCount: parsed.invalidCount,
      });
    }

    // A start time in the past is clamped to now rather than rejected -- the
    // user's intent is clearly "send immediately".
    const startAt =
      input.startAt && input.startAt.getTime() > Date.now() ? input.startAt : new Date();

    const result = await scheduleCampaign({
      userId: user.id,
      subject: input.subject,
      body: input.body,
      name: input.name ?? null,
      bodyHtml: input.bodyHtml ?? null,
      senderId: input.senderId ?? null,
      attachmentIds: input.attachmentIds ?? [],
      leads: parsed.leads,
      startAt,
      minDelayMs: input.minDelayMs ?? null,
      maxPerHour: input.maxPerHour ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    res.status(result.deduplicated ? 200 : 201).json({
      campaign: serialiseCampaign(result.campaign),
      plan: result.plan,
      enqueued: result.enqueued,
      deduplicated: result.deduplicated,
      recipients: {
        scheduled: parsed.leads.length,
        invalid: parsed.invalidCount,
        duplicates: parsed.duplicateCount,
        invalidSamples: parsed.invalid,
      },
    });
  }),
);

/** GET /api/campaigns -- list with per-campaign progress counters. */
campaignsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const rows = await db
      .select({
        campaign: campaigns,
        scheduled: sql<number>`count(*) filter (where ${emailJobs.status} = 'SCHEDULED')`,
        sent: sql<number>`count(*) filter (where ${emailJobs.status} = 'SENT')`,
        failed: sql<number>`count(*) filter (where ${emailJobs.status} = 'FAILED')`,
        sending: sql<number>`count(*) filter (where ${emailJobs.status} = 'SENDING')`,
      })
      .from(campaigns)
      .leftJoin(emailJobs, eq(emailJobs.campaignId, campaigns.id))
      .where(eq(campaigns.userId, user.id))
      .groupBy(campaigns.id)
      .orderBy(desc(campaigns.createdAt))
      .limit(100);

    res.json({
      campaigns: rows.map((r) => ({
        ...serialiseCampaign(r.campaign),
        counts: {
          scheduled: Number(r.scheduled),
          sending: Number(r.sending),
          sent: Number(r.sent),
          failed: Number(r.failed),
        },
      })),
    });
  }),
);

/** GET /api/campaigns/:id */
campaignsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = z.string().uuid().parse(req.params.id);
    const [row] = await db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.userId, user.id)))
      .limit(1);
    if (!row) throw notFound('Campaign not found');
    res.json({ campaign: serialiseCampaign(row) });
  }),
);

/** POST /api/campaigns/:id/cancel -- stops everything not yet sent. */
campaignsRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = z.string().uuid().parse(req.params.id);
    const cancelled = await cancelCampaign(user.id, id);
    res.json({ cancelled });
  }),
);

function serialiseCampaign(c: typeof campaigns.$inferSelect) {
  return {
    id: c.id,
    name: c.name,
    subject: c.subject,
    body: c.body,
    startAt: c.startAt.toISOString(),
    minDelayMs: c.minDelayMs,
    maxPerHour: c.maxPerHour,
    totalRecipients: c.totalRecipients,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
  };
}
