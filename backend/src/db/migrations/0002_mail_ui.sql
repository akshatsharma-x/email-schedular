-- ============================================================================
-- 0002_mail_ui: fields the mail-client UI needs
-- ============================================================================
-- The dashboard was rebuilt as a mail client (sidebar + list + detail), which
-- needs three things the scheduler core did not: a star flag, a rich-text body
-- alongside the plain-text one, and attachments.

-- Star / favourite, shown on every list row.
ALTER TABLE email_jobs ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT false;

-- Partial index: the starred set is small, so only index rows that are starred.
CREATE INDEX IF NOT EXISTS email_jobs_starred_idx
  ON email_jobs (user_id, starred)
  WHERE starred = true;

-- Rich-text body. `body` stays the authoritative plain-text part (and the
-- text/plain MIME alternative); this is the text/html part when the composer
-- produced formatting.
ALTER TABLE campaigns  ADD COLUMN IF NOT EXISTS body_html TEXT;
ALTER TABLE email_jobs ADD COLUMN IF NOT EXISTS body_html TEXT;

-- ------------------------------------------------------------ attachments ----
-- Uploaded first (before the campaign exists) so the composer can show a
-- thumbnail immediately, then linked to a campaign on schedule. `campaign_id`
-- is therefore nullable, and an orphaned upload is harmless.
CREATE TABLE IF NOT EXISTS attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id   UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  -- Path on local disk. Swapping this for an S3 key is the only change needed
  -- to move storage off the box.
  storage_path  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attachments_campaign_idx ON attachments (campaign_id);
CREATE INDEX IF NOT EXISTS attachments_user_idx ON attachments (user_id, created_at DESC);
