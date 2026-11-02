import { Router } from 'express';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { currentUser, requireAuth } from '../auth/middleware.js';
import { db } from '../db/client.js';
import { campaigns, emailJobs, senders, EMAIL_STATUSES, type EmailStatus } from '../db/schema.js';
import { asyncHandler, notFound } from '../lib/errors.js';
import { listCampaignAttachments, serialise as serialiseAttachment } from './attachments.routes.js';
import { parseLeads } from '../lib/leads.js';
import { searchEmails } from '../search/search.js';

export const emailsRouter = Router();
emailsRouter.use(requireAuth);

const listQuery = z.object({
  status: z
    .union([z.enum(EMAIL_STATUSES), z.array(z.enum(EMAIL_STATUSES))])
    .optional(),
  campaignId: z.string().uuid().optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['scheduled_asc', 'scheduled_desc', 'sent_desc']).default('scheduled_asc'),
});

/**
 * GET /api/emails
 *
 * Powers both dashboard tables. `?status=SCHEDULED` for the Scheduled tab,
 * `?status=SENT&status=FAILED` for the Sent tab (a failed send belongs in the
 * sent view -- the assignment's Sent table has a sent/failed status column).
 *
 * With `q` present the request is routed through Elasticsearch; without it this
 * is a plain indexed Postgres read, because paging a table does not need a
 * search engine and should not fail when one is down.
 */
emailsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const query = listQuery.parse(req.query);
    const statuses: EmailStatus[] = query.status
      ? Array.isArray(query.status)
        ? query.status
        : [query.status]
      : [];

    if (query.q) {
      const result = await searchEmails({
        userId: user.id,
        q: query.q,
        status: statuses,
        campaignId: query.campaignId,
        limit: query.limit,
        offset: query.offset,
      });
      // Hydrate from Postgres so search results and table rows are identical in
      // shape -- the UI renders one row component either way.
      const ids = result.hits.map((h) => h.id);
      const rows = ids.length > 0 ? await loadByIds(user.id, ids) : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      res.json({
        emails: result.hits.map((h) => byId.get(h.id)).filter(Boolean),
        total: result.total,
        source: result.source,
        tookMs: result.tookMs,
        limit: query.limit,
        offset: query.offset,
      });
      return;
    }

    const conditions = [eq(emailJobs.userId, user.id)];
    if (statuses.length > 0) conditions.push(inArray(emailJobs.status, statuses));
    if (query.campaignId) conditions.push(eq(emailJobs.campaignId, query.campaignId));
    const where = and(...conditions);

    const orderBy =
      query.sort === 'sent_desc'
        ? [desc(emailJobs.sentAt)]
        : query.sort === 'scheduled_desc'
          ? [desc(emailJobs.scheduledAt)]
          : [asc(emailJobs.scheduledAt), asc(emailJobs.sequence)];

    const [rows, countRows] = await Promise.all([
      db
        .select({ job: emailJobs, senderEmail: senders.fromEmail, senderLabel: senders.label })
        .from(emailJobs)
        .leftJoin(senders, eq(senders.id, emailJobs.senderId))
        .where(where)
        .orderBy(...orderBy)
        .limit(query.limit)
        .offset(query.offset),
      db.select({ count: sql<number>`count(*)` }).from(emailJobs).where(where),
    ]);

    res.json({
      emails: rows.map((r) => serialiseEmail(r.job, r.senderEmail, r.senderLabel)),
      total: Number(countRows[0]?.count ?? 0),
      source: 'postgres' as const,
      limit: query.limit,
      offset: query.offset,
    });
  }),
);

/**
 * GET /api/emails/search -- explicit Elasticsearch endpoint.
 * Reports which engine answered so the UI can show "via Elasticsearch" and a
 * reviewer can confirm indexing actually works.
 */
emailsRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const query = listQuery.parse(req.query);
    const statuses: EmailStatus[] = query.status
      ? Array.isArray(query.status)
        ? query.status
        : [query.status]
      : [];

    const result = await searchEmails({
      userId: user.id,
      q: query.q,
      status: statuses,
      campaignId: query.campaignId,
      limit: query.limit,
      offset: query.offset,
    });

    const ids = result.hits.map((h) => h.id);
    const rows = ids.length > 0 ? await loadByIds(user.id, ids) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));

    res.json({
      emails: result.hits.map((h) => byId.get(h.id)).filter(Boolean),
      total: result.total,
      source: result.source,
      tookMs: result.tookMs,
      limit: query.limit,
      offset: query.offset,
    });
  }),
);

/** GET /api/emails/stats -- header/tab counters. */
emailsRouter.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const [row] = await db
      .select({
        scheduled: sql<number>`count(*) filter (where ${emailJobs.status} = 'SCHEDULED')`,
        sending: sql<number>`count(*) filter (where ${emailJobs.status} = 'SENDING')`,
        sent: sql<number>`count(*) filter (where ${emailJobs.status} = 'SENT')`,
        failed: sql<number>`count(*) filter (where ${emailJobs.status} = 'FAILED')`,
        cancelled: sql<number>`count(*) filter (where ${emailJobs.status} = 'CANCELLED')`,
        starred: sql<number>`count(*) filter (where ${emailJobs.starred} = true)`,
        deferred: sql<number>`count(*) filter (where ${emailJobs.deferCount} > 0 and ${emailJobs.status} = 'SCHEDULED')`,
        nextSendAt: sql<string | null>`min(${emailJobs.scheduledAt}) filter (where ${emailJobs.status} = 'SCHEDULED')`,
      })
      .from(emailJobs)
      .where(eq(emailJobs.userId, user.id));

    res.json({
      stats: {
        scheduled: Number(row?.scheduled ?? 0),
        sending: Number(row?.sending ?? 0),
        sent: Number(row?.sent ?? 0),
        failed: Number(row?.failed ?? 0),
        cancelled: Number(row?.cancelled ?? 0),
        starred: Number(row?.starred ?? 0),
        deferred: Number(row?.deferred ?? 0),
        nextSendAt: row?.nextSendAt ?? null,
      },
    });
  }),
);


/**
 * GET /api/emails/:id -- the detail view.
 *
 * Returns the full body (plain + html) and the campaign's attachments, which
 * the list endpoint deliberately omits: shipping every body and attachment in a
 * 50-row list response would be wasteful when only one row is ever open.
 */
emailsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = z.string().uuid().parse(req.params.id);

    const [row] = await db
      .select({
        job: emailJobs,
        senderEmail: senders.fromEmail,
        senderName: senders.fromName,
        senderLabel: senders.label,
        campaignName: campaigns.name,
      })
      .from(emailJobs)
      .leftJoin(senders, eq(senders.id, emailJobs.senderId))
      .leftJoin(campaigns, eq(campaigns.id, emailJobs.campaignId))
      .where(and(eq(emailJobs.id, id), eq(emailJobs.userId, user.id)))
      .limit(1);

    if (!row) throw notFound('Email not found');

    const files = await listCampaignAttachments(row.job.campaignId);

    res.json({
      email: {
        ...serialiseEmail(row.job, row.senderEmail, row.senderLabel),
        body: row.job.body,
        bodyHtml: row.job.bodyHtml,
        starred: row.job.starred,
        senderName: row.senderName,
        campaignName: row.campaignName,
        providerMessageId: row.job.providerMessageId,
        attachments: files.map(serialiseAttachment),
      },
    });
  }),
);

/** PATCH /api/emails/:id -- star / unstar. */
emailsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = z.string().uuid().parse(req.params.id);
    const body = z.object({ starred: z.boolean() }).parse(req.body ?? {});

    const [row] = await db
      .update(emailJobs)
      .set({ starred: body.starred, updatedAt: new Date() })
      .where(and(eq(emailJobs.id, id), eq(emailJobs.userId, user.id)))
      .returning({ id: emailJobs.id, starred: emailJobs.starred });

    if (!row) throw notFound('Email not found');
    res.json({ email: row });
  }),
);

/**
 * POST /api/leads/parse (mounted at the app level)
 *
 * The dashboard posts the uploaded file here to get its "N addresses detected"
 * count. Using the server's parser for the preview means the number shown is the
 * number that will actually be scheduled.
 */
export const leadsRouter = Router();
leadsRouter.use(requireAuth);

const parseBody = z.object({
  content: z.string().max(10_000_000),
  filename: z.string().max(400).optional(),
});

leadsRouter.post(
  '/parse',
  asyncHandler(async (req, res) => {
    const input = parseBody.parse(req.body);
    const parsed = parseLeads(input.content);
    res.json({
      detected: parsed.leads.length,
      duplicates: parsed.duplicateCount,
      invalid: parsed.invalidCount,
      invalidSamples: parsed.invalid,
      totalRows: parsed.totalRows,
      // Capped: the UI only previews the first rows, and echoing 100k addresses
      // back would make this response pointlessly huge.
      preview: parsed.leads.slice(0, 50),
      recipients: parsed.leads,
    });
  }),
);

async function loadByIds(userId: string, ids: string[]) {
  const rows = await db
    .select({ job: emailJobs, senderEmail: senders.fromEmail, senderLabel: senders.label })
    .from(emailJobs)
    .leftJoin(senders, eq(senders.id, emailJobs.senderId))
    .where(and(eq(emailJobs.userId, userId), inArray(emailJobs.id, ids)));
  return rows.map((r) => serialiseEmail(r.job, r.senderEmail, r.senderLabel));
}

function serialiseEmail(
  job: typeof emailJobs.$inferSelect,
  senderEmail: string | null,
  senderLabel: string | null,
) {
  return {
    id: job.id,
    campaignId: job.campaignId,
    recipientEmail: job.recipientEmail,
    recipientName: job.recipientName,
    subject: job.subject,
    // Short snippet for the list row's grey preview text. The full body is only
    // returned by the detail endpoint -- shipping 60 full bodies per page would
    // be wasteful when at most one is ever read.
    preview: job.body.replace(/\s+/g, ' ').trim().slice(0, 140),
    status: job.status,
    sequence: job.sequence,
    scheduledAt: job.scheduledAt.toISOString(),
    sentAt: job.sentAt ? job.sentAt.toISOString() : null,
    failedAt: job.failedAt ? job.failedAt.toISOString() : null,
    attemptCount: job.attemptCount,
    deferCount: job.deferCount,
    starred: job.starred,
    lastDeferReason: job.lastDeferReason,
    lastError: job.lastError,
    previewUrl: job.previewUrl,
    senderEmail,
    senderLabel,
  };
}
