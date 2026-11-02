import { env } from '../config/env.js';
import type { EmailJob } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { getClient, isAvailable } from './elastic.js';

const log = logger.child({ mod: 'indexer' });

export interface IndexedEmail {
  user_id: string;
  campaign_id: string;
  sender_id: string | null;
  recipient_email: string;
  recipient_name: string | null;
  subject: string;
  body: string;
  status: string;
  scheduled_at: string;
  sent_at: string | null;
  defer_count: number;
  created_at: string;
}

export const toDocument = (job: EmailJob): IndexedEmail => ({
  user_id: job.userId,
  campaign_id: job.campaignId,
  sender_id: job.senderId,
  recipient_email: job.recipientEmail,
  recipient_name: job.recipientName,
  subject: job.subject,
  // Truncated: the body is searchable but the index should not become a
  // second copy of the whole dataset.
  body: job.body.slice(0, 4000),
  status: job.status,
  scheduled_at: job.scheduledAt.toISOString(),
  sent_at: job.sentAt ? job.sentAt.toISOString() : null,
  defer_count: job.deferCount,
  created_at: job.createdAt.toISOString(),
});

/**
 * Index a single email. Never throws and never blocks the caller's outcome:
 * a send that succeeded must not be reported as failed because ES hiccuped.
 * The row's `indexed_at` stays null on failure, and `npm run search:reindex`
 * sweeps up anything that was missed.
 */
export async function indexEmail(job: EmailJob): Promise<boolean> {
  const c = getClient();
  if (!c || !isAvailable()) return false;
  try {
    await c.index({
      index: env.ELASTICSEARCH_INDEX,
      id: job.id,
      document: toDocument(job),
      // Keep the dashboard's search results fresh enough to feel live without
      // paying for refresh-on-every-write.
      refresh: false,
    });
    return true;
  } catch (err) {
    log.debug({ err: (err as Error).message, emailJobId: job.id }, 'index failed (non-fatal)');
    return false;
  }
}

/** Bulk path used when scheduling a campaign and by the reindex script. */
export async function indexEmailsBulk(jobs: EmailJob[]): Promise<number> {
  const c = getClient();
  if (!c || !isAvailable() || jobs.length === 0) return 0;

  let indexed = 0;
  // Chunked so a 100k-recipient reindex does not build one enormous request.
  const CHUNK = 500;
  for (let i = 0; i < jobs.length; i += CHUNK) {
    const slice = jobs.slice(i, i + CHUNK);
    const operations = slice.flatMap((job) => [
      { index: { _index: env.ELASTICSEARCH_INDEX, _id: job.id } },
      toDocument(job),
    ]);
    try {
      const res = await c.bulk({ operations, refresh: false });
      if (res.errors) {
        const firstError = res.items.find((it) => it.index?.error)?.index?.error;
        log.warn({ firstError }, 'bulk index completed with errors');
      }
      indexed += slice.length - (res.items.filter((it) => it.index?.error).length ?? 0);
    } catch (err) {
      log.warn({ err: (err as Error).message, chunk: i }, 'bulk index chunk failed (non-fatal)');
    }
  }
  return indexed;
}

export async function deleteCampaignFromIndex(campaignId: string): Promise<void> {
  const c = getClient();
  if (!c || !isAvailable()) return;
  try {
    await c.deleteByQuery({
      index: env.ELASTICSEARCH_INDEX,
      query: { term: { campaign_id: campaignId } },
      refresh: true,
    });
  } catch (err) {
    log.debug({ err: (err as Error).message }, 'deleteByQuery failed (non-fatal)');
  }
}
