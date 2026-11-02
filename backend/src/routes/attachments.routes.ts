import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Router } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import multer from 'multer';
import { z } from 'zod';
import { currentUser, requireAuth } from '../auth/middleware.js';
import { db } from '../db/client.js';
import { attachments } from '../db/schema.js';
import { asyncHandler, badRequest, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ mod: 'routes:attachments' });

/**
 * Attachment upload / download.
 *
 * Files land on local disk under `uploads/`, keyed by a generated UUID rather
 * than the user's filename — which is what stops a crafted name like
 * `../../etc/passwd` from escaping the directory. The original name is kept in
 * the database for display and for the outgoing MIME part.
 *
 * Swapping local disk for S3 means changing `storage_path` and this file; the
 * rest of the system only ever sees attachment ids.
 */

export const UPLOAD_DIR = resolve(process.cwd(), 'uploads');
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB, matched by the UI's copy
const MAX_FILES = 5;

/**
 * Deny-list rather than allow-list on type: these are *outgoing* attachments we
 * ourselves send, not untrusted uploads we execute, so the real risk is a
 * provider rejecting the message. Executables are refused because mail
 * providers bounce them outright.
 */
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.jar', '.vbs', '.js', '.sh', '.ps1',
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      void mkdir(UPLOAD_DIR, { recursive: true })
        .then(() => cb(null, UPLOAD_DIR))
        .catch((err) => cb(err as Error, UPLOAD_DIR));
    },
    // Never trust the client's filename for the path on disk.
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname)}`),
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
  fileFilter: (_req, file, cb) => {
    if (BLOCKED_EXTENSIONS.has(extname(file.originalname).toLowerCase())) {
      cb(new Error(`Attachments of type ${extname(file.originalname)} are not allowed`));
      return;
    }
    cb(null, true);
  },
});

export const attachmentsRouter = Router();
attachmentsRouter.use(requireAuth);

/** POST /api/attachments — multipart upload, one or more files. */
attachmentsRouter.post(
  '/',
  (req, res, next) => {
    upload.array('files', MAX_FILES)(req, res, (err: unknown) => {
      if (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        next(
          badRequest(
            message.includes('File too large')
              ? `Each file must be ${MAX_FILE_BYTES / 1024 / 1024} MB or smaller`
              : message,
          ),
        );
        return;
      }
      next();
    });
  },
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) throw badRequest('No files were uploaded');

    const rows = await db
      .insert(attachments)
      .values(
        files.map((f) => ({
          userId: user.id,
          filename: f.originalname,
          mimeType: f.mimetype,
          sizeBytes: f.size,
          storagePath: f.path,
        })),
      )
      .returning();

    log.info({ userId: user.id, count: rows.length }, 'attachments uploaded');
    res.status(201).json({ attachments: rows.map(serialise) });
  }),
);

/**
 * GET /api/attachments/:id — stream the file back.
 * Scoped by user id, so one tenant cannot read another's uploads.
 */
attachmentsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = z.string().uuid().parse(req.params.id);

    const [row] = await db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, id), eq(attachments.userId, user.id)))
      .limit(1);
    if (!row) throw notFound('Attachment not found');

    // The row could outlive the file (manual cleanup, container restart with no
    // volume), so check before streaming rather than emitting a broken response.
    const exists = await stat(row.storagePath).then(
      () => true,
      () => false,
    );
    if (!exists) throw notFound('Attachment file is no longer on disk');

    res.setHeader('Content-Type', row.mimeType);
    res.setHeader('Content-Length', row.sizeBytes);
    // `inline` so images preview in the browser; the filename is quoted because
    // it is user-supplied and may contain spaces.
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${row.filename.replace(/"/g, '')}"`,
    );
    createReadStream(row.storagePath).pipe(res);
  }),
);

/** DELETE /api/attachments/:id — only while still unlinked from a campaign. */
attachmentsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const id = z.string().uuid().parse(req.params.id);

    const [row] = await db
      .delete(attachments)
      .where(
        and(
          eq(attachments.id, id),
          eq(attachments.userId, user.id),
          // Refuse once scheduled: those rows are part of a campaign's record.
          isNull(attachments.campaignId),
        ),
      )
      .returning();

    if (!row) throw notFound('Attachment not found, or already attached to a campaign');
    await unlink(row.storagePath).catch(() => undefined);
    res.json({ ok: true });
  }),
);

export function serialise(row: typeof attachments.$inferSelect) {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    /** Relative URL the dashboard uses for the thumbnail. */
    url: `/api/attachments/${row.id}`,
    isImage: row.mimeType.startsWith('image/'),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Links pending uploads to a campaign. Called from the scheduler. */
export async function linkAttachmentsToCampaign(
  userId: string,
  campaignId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  for (const id of ids) {
    await db
      .update(attachments)
      .set({ campaignId })
      .where(
        and(
          eq(attachments.id, id),
          eq(attachments.userId, userId),
          isNull(attachments.campaignId),
        ),
      );
  }
}

export async function listCampaignAttachments(campaignId: string) {
  return db.select().from(attachments).where(eq(attachments.campaignId, campaignId));
}

export const uploadLimits = { maxFileBytes: MAX_FILE_BYTES, maxFiles: MAX_FILES };
