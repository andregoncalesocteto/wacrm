import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guard for migration 051 (final contract): the app code must never read or
// write `whatsapp_config` or the `contacts.wa_user_id` / `wa_parent_user_id`
// / `wa_username` columns again — migration 051 drops them, so a reference
// that survives would fail at runtime against the real schema.
//
// Scans this repo's `src/` and the MCP server's `src/` (application code
// only; SQL migrations are shipped history and legitimately mention these
// names — 001/013/015 create `whatsapp_config`, and
// `supabase/ci/verify-schema.sql` asserts it and the columns are GONE).
// This file is excluded from its own scan (it necessarily names the
// patterns it looks for).

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: 'whatsapp_config', pattern: /\bwhatsapp_config\b/ },
  { name: 'contacts.wa_user_id', pattern: /\bwa_user_id\b/ },
  { name: 'contacts.wa_parent_user_id', pattern: /\bwa_parent_user_id\b/ },
  { name: 'contacts.wa_username', pattern: /\bwa_username\b/ },
];

const SELF = relative(process.cwd(), __filename);
const SCAN_ROOTS = ['src', join('mcp-server', 'src')];
const EXTENSIONS = new Set(['.ts', '.tsx']);

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full));
    } else if (EXTENSIONS.has(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

const files = SCAN_ROOTS.flatMap((root) => listFiles(join(process.cwd(), root)))
  .map((f) => relative(process.cwd(), f))
  .filter((f) => f !== SELF);

describe('no code references the columns/table migration 051 dropped', () => {
  it('scans a non-trivial number of files (sanity check on discovery)', () => {
    expect(files.length).toBeGreaterThan(400);
  });

  it.each(FORBIDDEN)('no reference to $name', ({ pattern }) => {
    const offenders = files.filter((f) =>
      pattern.test(readFileSync(join(process.cwd(), f), 'utf8'))
    );
    expect(offenders).toEqual([]);
  });
});
