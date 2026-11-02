import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { closeDb, db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { senders, users } from '../db/schema.js';
import { upsertUser } from '../auth/google.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ script: 'create-ethereal-senders' });

/**
 * Provisions N throwaway Ethereal SMTP mailboxes and registers them as senders.
 *
 *   npm run senders:create -- --count 3 --email you@example.com --per-hour 50
 *
 * Ethereal accounts are free, instant, and never deliver to a real inbox -- mail
 * is captured in a web UI instead. The credentials are printed so a reviewer can
 * log in and read the delivered messages.
 *
 * Senders are attached to a user. If no email is given, the first existing user
 * is used, else a local demo user is created -- so this works both before and
 * after a real Google login.
 */

/**
 * Turns an email local-part into a display name, so a sender created from
 * `adyasha.singh@…` shows as "Adyasha Singh" rather than "adyasha.singh".
 */
function prettyName(email: string): string {
  const local = email.split('@')[0] ?? 'Owner';
  return (
    local
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || 'Owner'
  );
}

interface Args {
  count: number;
  email?: string;
  perHour?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { count: 2 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--count' && value) {
      args.count = Math.max(1, Math.min(10, Number(value)));
      i += 1;
    } else if (flag === '--email' && value) {
      args.email = value.toLowerCase();
      i += 1;
    } else if (flag === '--per-hour' && value) {
      args.perHour = Math.max(1, Number(value));
      i += 1;
    }
  }
  return args;
}

async function resolveUserId(email?: string): Promise<{ id: string; name: string }> {
  if (email) {
    const user = await upsertUser({ email, name: prettyName(email) });
    return { id: user.id, name: user.name };
  }
  const [existing] = await db.select().from(users).orderBy(users.createdAt).limit(1);
  if (existing) return { id: existing.id, name: existing.name };
  const created = await upsertUser({
    email: 'adyasha.singh@outbox.local',
    name: 'Adyasha Singh',
  });
  return { id: created.id, name: created.name };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await runMigrations();

  const user = await resolveUserId(args.email);
  const existing = await db.select().from(senders).where(eq(senders.userId, user.id));

  log.info({ userId: user.id, existing: existing.length, creating: args.count }, 'provisioning');

  const created: { fromEmail: string; pass: string; limit: number | null }[] = [];
  const taken = new Set(existing.map((s) => s.fromEmail));

  for (let i = 0; i < args.count; i += 1) {
    // Ethereal hands back the *same* mailbox for rapid back-to-back calls, so
    // ask again (briefly spaced) until we get one we do not already have.
    let account = await nodemailer.createTestAccount();
    for (let retry = 0; retry < 4 && taken.has(account.user); retry += 1) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      account = await nodemailer.createTestAccount();
    }
    if (taken.has(account.user)) {
      log.warn({ user: account.user }, 'ethereal kept returning an existing mailbox; skipping');
      continue;
    }
    taken.add(account.user);

    const [row] = await db
      .insert(senders)
      .values({
        userId: user.id,
        label: `Ethereal ${existing.length + created.length + 1}`,
        fromName: user.name,
        fromEmail: account.user,
        smtpHost: account.smtp.host,
        smtpPort: account.smtp.port,
        smtpSecure: account.smtp.secure,
        smtpUser: account.user,
        smtpPass: account.pass,
        maxEmailsPerHour: args.perHour ?? null,
      })
      // Re-running the script must not fail on a repeat address.
      .onConflictDoNothing({ target: [senders.userId, senders.fromEmail] })
      .returning();

    if (row) {
      created.push({ fromEmail: row.fromEmail, pass: account.pass, limit: row.maxEmailsPerHour });
    }
  }

  // Printed with console.log on purpose: this is the script's output, not a log
  // line, and it must stay readable when LOG_LEVEL hides info logs.
  console.log('\n  Ethereal senders provisioned\n');
  console.log(`  Owner: ${args.email ?? user.id}`);
  for (const s of created) {
    console.log(`\n  ${s.fromEmail}`);
    console.log(`    password:    ${s.pass}`);
    console.log(`    hourly cap:  ${s.limit ?? 'env default'}`);
  }
  console.log('\n  Read delivered mail at https://ethereal.email/login with the above\n');

  await closeDb();
}

main().catch((err) => {
  log.error({ err }, 'failed to provision senders');
  process.exit(1);
});
