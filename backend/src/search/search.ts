import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { emailJobs, type EmailStatus } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { getClient, probe } from './elastic.js';

const log = logger.child({ mod: 'search' });

export interface SearchParams {
  userId: string;
  q?: string;
  status?: EmailStatus | EmailStatus[];
  campaignId?: string;
  limit: number;
  offset: number;
}

export interface SearchHit {
  id: string;
  recipientEmail: string;
  recipientName: string | null;
  subject: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  campaignId: string;
  senderId: string | null;
  deferCount: number;
}

export interface SearchResponse {
  hits: SearchHit[];
  total: number;
  /** Which engine served this response -- surfaced in the UI for transparency. */
  source: 'elasticsearch' | 'postgres';
  tookMs: number;
}

/**
 * Search across scheduled and sent emails.
 *
 * Elasticsearch is the primary engine (full-text over subject/body/recipient
 * with relevance ranking). If ES is unreachable the same query is answered from
 * Postgres with ILIKE matching, and the response says which engine answered.
 * The dashboard therefore keeps working during an ES outage instead of showing
 * an error -- degraded relevance beats a broken page.
 */
export async function searchEmails(params: SearchParams): Promise<SearchResponse> {
  const started = Date.now();
  const statuses = normaliseStatuses(params.status);

  if (await probe()) {
    try {
      const res = await searchViaElastic(params, statuses);
      return { ...res, tookMs: Date.now() - started };
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'elasticsearch query failed; using postgres');
    }
  }

  const res = await searchViaPostgres(params, statuses);
  return { ...res, tookMs: Date.now() - started };
}

function normaliseStatuses(status?: EmailStatus | EmailStatus[]): EmailStatus[] {
  if (!status) return [];
  return Array.isArray(status) ? status : [status];
}

async function searchViaElastic(
  params: SearchParams,
  statuses: EmailStatus[],
): Promise<Omit<SearchResponse, 'tookMs'>> {
  const c = getClient();
  if (!c) throw new Error('elasticsearch client unavailable');

  // Tenant isolation is a filter clause, never a user-supplied term.
  const filter: Record<string, unknown>[] = [{ term: { user_id: params.userId } }];
  if (statuses.length > 0) filter.push({ terms: { status: statuses } });
  if (params.campaignId) filter.push({ term: { campaign_id: params.campaignId } });

  const must: Record<string, unknown>[] = [];
  if (params.q?.trim()) {
    must.push({
      multi_match: {
        query: params.q.trim(),
        // Recipient matches are the most useful, so they are boosted hardest.
        fields: ['recipient_email^3', 'recipient_name^2', 'subject^2', 'body'],
        type: 'best_fields',
        // Tolerate a typo in longer terms.
        fuzziness: 'AUTO',
      },
    });
  }

  const result = await c.search<Record<string, unknown>>({
    index: env.ELASTICSEARCH_INDEX,
    from: params.offset,
    size: params.limit,
    track_total_hits: true,
    query: { bool: { filter, must: must.length > 0 ? must : [{ match_all: {} }] } },
    // Relevance first when searching, recency first when just browsing.
    sort: params.q?.trim()
      ? [{ _score: { order: 'desc' } }, { scheduled_at: { order: 'desc' } }]
      : [{ scheduled_at: { order: 'desc' } }],
  });

  const total =
    typeof result.hits.total === 'number' ? result.hits.total : (result.hits.total?.value ?? 0);

  return {
    source: 'elasticsearch',
    total,
    hits: result.hits.hits.map((h) => {
      const s = h._source as Record<string, unknown>;
      return {
        id: String(h._id),
        recipientEmail: String(s.recipient_email ?? ''),
        recipientName: (s.recipient_name as string | null) ?? null,
        subject: String(s.subject ?? ''),
        status: String(s.status ?? ''),
        scheduledAt: String(s.scheduled_at ?? ''),
        sentAt: (s.sent_at as string | null) ?? null,
        campaignId: String(s.campaign_id ?? ''),
        senderId: (s.sender_id as string | null) ?? null,
        deferCount: Number(s.defer_count ?? 0),
      };
    }),
  };
}

async function searchViaPostgres(
  params: SearchParams,
  statuses: EmailStatus[],
): Promise<Omit<SearchResponse, 'tookMs'>> {
  const conditions: SQL[] = [eq(emailJobs.userId, params.userId)];

  if (statuses.length > 0) {
    conditions.push(sql`${emailJobs.status} = ANY(${sql.param(statuses)}::text[])`);
  }
  if (params.campaignId) conditions.push(eq(emailJobs.campaignId, params.campaignId));

  const q = params.q?.trim();
  if (q) {
    const term = `%${q}%`;
    const clause = or(
      ilike(emailJobs.recipientEmail, term),
      ilike(emailJobs.subject, term),
      ilike(emailJobs.body, term),
      ilike(emailJobs.recipientName, term),
    );
    if (clause) conditions.push(clause);
  }

  const where = and(...conditions);

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: emailJobs.id,
        recipientEmail: emailJobs.recipientEmail,
        recipientName: emailJobs.recipientName,
        subject: emailJobs.subject,
        status: emailJobs.status,
        scheduledAt: emailJobs.scheduledAt,
        sentAt: emailJobs.sentAt,
        campaignId: emailJobs.campaignId,
        senderId: emailJobs.senderId,
        deferCount: emailJobs.deferCount,
      })
      .from(emailJobs)
      .where(where)
      .orderBy(desc(emailJobs.scheduledAt))
      .limit(params.limit)
      .offset(params.offset),
    db.select({ count: sql<number>`count(*)` }).from(emailJobs).where(where),
  ]);

  return {
    source: 'postgres',
    total: Number(countRows[0]?.count ?? 0),
    hits: rows.map((r) => ({
      id: r.id,
      recipientEmail: r.recipientEmail,
      recipientName: r.recipientName,
      subject: r.subject,
      status: r.status,
      scheduledAt: r.scheduledAt.toISOString(),
      sentAt: r.sentAt ? r.sentAt.toISOString() : null,
      campaignId: r.campaignId,
      senderId: r.senderId,
      deferCount: r.deferCount,
    })),
  };
}
