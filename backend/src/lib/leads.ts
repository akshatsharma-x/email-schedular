/**
 * Lead-file parsing.
 *
 * Accepts the shapes a real uploaded list actually arrives in:
 *   - CSV with a header row (any column named email / email_address / e-mail ...)
 *   - CSV without a header (the first column that looks like an address wins)
 *   - one address per line
 *   - comma / semicolon / whitespace separated blobs
 *   - RFC-5322 display names: "Adyasha Singh" <adyasha@acme.io>
 *
 * This lives on the backend and is exposed through POST /api/leads/parse so the
 * dashboard's "N addresses detected" preview is produced by the same code that
 * will later create the jobs. A second parser in the frontend would eventually
 * disagree with this one, and the user would be shown a count that is not what
 * gets scheduled.
 */

export interface Lead {
  email: string;
  name: string | null;
}

export interface ParsedLeads {
  leads: Lead[];
  /** Addresses that failed validation, capped for a readable response. */
  invalid: string[];
  invalidCount: number;
  /** Count of addresses removed because they repeated earlier in the file. */
  duplicateCount: number;
  totalRows: number;
}

/**
 * Pragmatic address validation. Full RFC 5322 is famously baroque and matching
 * it exactly would accept addresses no mail provider will take; this covers the
 * deliverable shape (local@label.tld, no spaces, single @, sane TLD).
 */
const EMAIL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

export const isValidEmail = (value: string): boolean =>
  value.length <= 254 && EMAIL_RE.test(value) && !value.includes('..');

const EMAIL_HEADERS = new Set([
  'email',
  'e-mail',
  'email_address',
  'emailaddress',
  'email address',
  'mail',
  'recipient',
  'recipient_email',
  'to',
  'address',
]);

const NAME_HEADERS = new Set([
  'name',
  'full_name',
  'fullname',
  'full name',
  'first_name',
  'firstname',
  'first name',
  'contact',
  'contact_name',
  'lead_name',
]);

/** Splits one CSV line, honouring double quotes and escaped quotes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',' || ch === ';' || ch === '\t') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/** Pulls `Adyasha Singh <adyasha@acme.io>` apart; returns null when there is no address. */
function extractFromToken(token: string): Lead | null {
  const raw = token.trim().replace(/^["']|["']$/g, '');
  if (!raw) return null;

  const angled = /^(.*?)<\s*([^<>\s]+)\s*>$/.exec(raw);
  if (angled) {
    const name = angled[1]!.trim().replace(/^["']|["']$/g, '');
    const email = angled[2]!.toLowerCase();
    return { email, name: name || null };
  }

  const bare = raw.replace(/^mailto:/i, '').toLowerCase();
  // A token may still be a sentence containing an address; grab the address-ish part.
  const found = /[^\s,;<>()[\]]+@[^\s,;<>()[\]]+/.exec(bare);
  if (!found) return null;
  return { email: found[0]!.replace(/[.,;]+$/, ''), name: null };
}

/**
 * A single CSV cell may still hold several whitespace-separated addresses
 * ("a@x.com b@x.com"). More than one `@` means it must be split further; a
 * single `@` is left intact so a display name survives.
 */
function splitLooseCell(cell: string): string[] {
  const atCount = (cell.match(/@/g) ?? []).length;
  return atCount > 1 ? cell.split(/\s+/).filter(Boolean) : [cell];
}

export function parseLeads(content: string, options?: { maxInvalidSamples?: number }): ParsedLeads {
  const maxSamples = options?.maxInvalidSamples ?? 20;
  // Normalise newlines and strip a UTF-8 BOM (Excel exports include one).
  const text = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);

  const seen = new Set<string>();
  const leads: Lead[] = [];
  const invalid: string[] = [];
  let invalidCount = 0;
  let duplicateCount = 0;
  let totalRows = 0;

  // Header detection: a first row that names an email column but contains no
  // address itself. Guards against treating a real lead as a header.
  let emailIdx = -1;
  let nameIdx = -1;
  let startLine = 0;

  const firstLine = lines[0];
  if (firstLine) {
    const cells = splitCsvLine(firstLine);
    const lowered = cells.map((c) => c.toLowerCase());
    const headerHasEmail = lowered.some((c) => EMAIL_HEADERS.has(c));
    const rowContainsAddress = cells.some((c) => c.includes('@'));
    if (headerHasEmail && !rowContainsAddress) {
      emailIdx = lowered.findIndex((c) => EMAIL_HEADERS.has(c));
      nameIdx = lowered.findIndex((c) => NAME_HEADERS.has(c));
      startLine = 1;
    }
  }

  const push = (candidate: Lead | null, rawToken: string): void => {
    totalRows += 1;
    if (!candidate || !isValidEmail(candidate.email)) {
      invalidCount += 1;
      if (invalid.length < maxSamples) invalid.push(rawToken.slice(0, 120));
      return;
    }
    if (seen.has(candidate.email)) {
      duplicateCount += 1;
      return;
    }
    seen.add(candidate.email);
    leads.push(candidate);
  };

  for (let i = startLine; i < lines.length; i += 1) {
    const line = lines[i]!;
    const cells = splitCsvLine(line);

    if (emailIdx >= 0) {
      const rawEmail = cells[emailIdx] ?? '';
      let candidate = extractFromToken(rawEmail);
      let salvagedRow = false;

      // Real lead files are rarely uniform: a row may not follow the header's
      // column layout at all (an exported `"Adyasha" <adyasha@acme.io>` line lands in
      // a single cell). Rather than discard it as invalid, fall back to scanning
      // the row for anything address-shaped.
      if (!candidate || !isValidEmail(candidate.email)) {
        const salvaged = cells
          .filter((c) => c.includes('@'))
          .map((c) => extractFromToken(c))
          .find((c): c is Lead => c !== null && isValidEmail(c.email));
        if (salvaged) {
          candidate = salvaged;
          salvagedRow = true;
        }
      }

      // A salvaged row did not follow the column layout, so the header's name
      // column cannot be trusted for it either -- that cell is most likely the
      // whole unsplit row. Use the name parsed out of the address instead.
      const name = !salvagedRow && nameIdx >= 0 ? (cells[nameIdx] ?? '').trim() : '';
      push(
        candidate ? { email: candidate.email, name: name || candidate.name } : null,
        rawEmail || line,
      );
      continue;
    }

    // No header: every token on the line is a potential address, which also
    // handles "a@x.com, b@y.com, c@z.com" all on one line.
    //
    // The single-cell case must reuse the *parsed* cell rather than re-splitting
    // the raw line: splitting `"Adyasha Singh" <adyasha@acme.io>` on whitespace would
    // discard the quote handling and lose the display name.
    const tokens = cells.length > 1 ? cells : splitLooseCell(cells[0] ?? line);
    const addressish = tokens.filter((t) => t.includes('@'));
    if (addressish.length === 0) {
      push(null, line);
      continue;
    }
    for (const token of addressish) push(extractFromToken(token), token);
  }

  return { leads, invalid, invalidCount, duplicateCount, totalRows };
}
