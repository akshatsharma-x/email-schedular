import { describe, expect, it } from 'vitest';
import { isValidEmail, parseLeads, splitCsvLine } from '../src/lib/leads.js';

describe('splitCsvLine', () => {
  it('splits on commas, semicolons and tabs', () => {
    expect(splitCsvLine('a,b;c\td')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('respects quoted fields containing the delimiter', () => {
    expect(splitCsvLine('"Singh, Adyasha",adyasha@acme.io')).toEqual(['Singh, Adyasha', 'adyasha@acme.io']);
  });

  it('unescapes doubled quotes', () => {
    expect(splitCsvLine('"say ""hi""",x@y.com')).toEqual(['say "hi"', 'x@y.com']);
  });
});

describe('isValidEmail', () => {
  it.each([
    ['a@b.co', true],
    ['first.last+tag@sub.domain.io', true],
    ['no-at-sign.com', false],
    ['two@@at.com', false],
    ['trailing@dot.', false],
    ['double..dot@x.com', false],
    ['spaced @x.com', false],
  ])('%s -> %s', (input, expected) => {
    expect(isValidEmail(input)).toBe(expected);
  });
});

describe('parseLeads', () => {
  it('parses a CSV with a header row and a name column', () => {
    const result = parseLeads('name,email\nAdyasha Singh,adyasha@acme.io\nRohan Mehta,rohan@acme.io');
    expect(result.leads).toEqual([
      { email: 'adyasha@acme.io', name: 'Adyasha Singh' },
      { email: 'rohan@acme.io', name: 'Rohan Mehta' },
    ]);
  });

  it('handles a header row in any column order with alternate naming', () => {
    const result = parseLeads('Email_Address,Full Name\nx@y.com,Rohan Mehta');
    expect(result.leads).toEqual([{ email: 'x@y.com', name: 'Rohan Mehta' }]);
  });

  it('does not mistake a first data row for a header', () => {
    const result = parseLeads('adyasha@acme.io\nrohan@acme.io');
    expect(result.leads).toHaveLength(2);
  });

  it('parses one address per line', () => {
    const result = parseLeads('a@x.com\nb@x.com\n\nc@x.com\n');
    expect(result.leads.map((l) => l.email)).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });

  it('parses several addresses on one line', () => {
    const result = parseLeads('a@x.com, b@x.com; c@x.com');
    expect(result.leads).toHaveLength(3);
  });

  it('extracts display-name form', () => {
    const result = parseLeads('"Adyasha Singh" <adyasha@acme.io>');
    expect(result.leads).toEqual([{ email: 'adyasha@acme.io', name: 'Adyasha Singh' }]);
  });

  it('lowercases addresses and removes duplicates', () => {
    const result = parseLeads('A@X.com\na@x.com\nb@x.com');
    expect(result.leads.map((l) => l.email)).toEqual(['a@x.com', 'b@x.com']);
    expect(result.duplicateCount).toBe(1);
  });

  it('reports invalid rows without discarding the valid ones', () => {
    const result = parseLeads('good@x.com\nnot-an-email\nalso bad\nfine@y.com');
    expect(result.leads.map((l) => l.email)).toEqual(['good@x.com', 'fine@y.com']);
    expect(result.invalidCount).toBe(2);
    expect(result.invalid).toContain('not-an-email');
  });

  it('strips a UTF-8 BOM and CRLF line endings from an Excel export', () => {
    const result = parseLeads('﻿email\r\nadyasha@acme.io\r\nrohan@acme.io\r\n');
    expect(result.leads.map((l) => l.email)).toEqual(['adyasha@acme.io', 'rohan@acme.io']);
  });

  it('strips a mailto: prefix', () => {
    expect(parseLeads('mailto:adyasha@acme.io').leads[0]?.email).toBe('adyasha@acme.io');
  });

  it('returns an empty result for an empty file rather than throwing', () => {
    expect(parseLeads('').leads).toEqual([]);
    expect(parseLeads('   \n  \n').leads).toEqual([]);
  });
});

describe('parseLeads -- mixed-format files', () => {
  it('salvages a row that ignores the header column layout', () => {
    // Row 3 is a single cell in display-name form, not the declared 2 columns.
    const result = parseLeads(
      'name,email\nAdyasha Singh,adyasha@example.com\n"Priya Nair" <priya@example.com>',
    );
    expect(result.leads).toEqual([
      { email: 'adyasha@example.com', name: 'Adyasha Singh' },
      { email: 'priya@example.com', name: 'Priya Nair' },
    ]);
    expect(result.invalidCount).toBe(0);
  });

  it('still reports a row with no address at all as invalid', () => {
    const result = parseLeads('name,email\nAdyasha Singh,adyasha@example.com\nbroken-row');
    expect(result.leads).toHaveLength(1);
    expect(result.invalidCount).toBe(1);
  });
});
