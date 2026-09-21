import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guard for migration 049 (merge_contacts): every table that carries a
// contact_id column must be handled by the merge, otherwise a merge would
// lose (ON DELETE CASCADE) or orphan (SET NULL) its rows. The tables are
// discovered from the migrations' DDL, not from a hand-kept list; the same
// check runs against the real schema in supabase/ci/verify-schema.sql.

const dir = join(process.cwd(), 'supabase', 'migrations');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const sql = new Map(files.map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

function tablesWithContactId(): string[] {
  const found = new Set<string>();
  for (const [file, text] of sql) {
    if (file.startsWith('049_')) continue;
    // CREATE TABLE ... ( ... contact_id UUID ... );
    for (const m of text.matchAll(
      /CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi
    )) {
      if (/^\s*contact_id\s+UUID/im.test(m[2])) found.add(m[1]);
    }
    // ALTER TABLE x ADD COLUMN [IF NOT EXISTS] contact_id UUID
    for (const m of text.matchAll(
      /ALTER TABLE\s+(?:public\.)?(\w+)\s+ADD COLUMN(?: IF NOT EXISTS)?\s+contact_id\s+UUID/gi
    )) {
      found.add(m[1]);
    }
  }
  return [...found].sort();
}

describe('merge_contacts covers every table with contact_id', () => {
  const merge = sql.get('049_merge_contacts.sql')!;

  it('finds the known tables (sanity check on the discovery)', () => {
    expect(tablesWithContactId()).toEqual(
      expect.arrayContaining([
        'automation_logs',
        'automation_pending_executions',
        'broadcast_recipients',
        'contact_custom_values',
        'contact_identities',
        'contact_notes',
        'contact_tags',
        'conversations',
        'deals',
        'flow_runs',
        'notifications',
      ])
    );
  });

  it.each(tablesWithContactId())('handles %s', (table) => {
    // conversations are re-pointed or folded via their own branch.
    const pattern =
      table === 'conversations'
        ? /UPDATE conversations SET contact_id = p_survivor_id/
        : new RegExp(
            `UPDATE ${table}(\\s+\\w+)?\\s+SET contact_id = p_survivor_id`
          );
    expect(merge).toMatch(pattern);
  });

  it('folds conversations of the same connection instead of colliding on the unique index', () => {
    expect(merge).toMatch(/connection_id = v_conv\.connection_id/);
    expect(merge).toMatch(/UPDATE messages SET conversation_id = v_target/);
  });

  it('is callable by service_role only', () => {
    expect(merge).toMatch(
      /REVOKE ALL ON FUNCTION public\.merge_contacts\(UUID, UUID, UUID\) FROM PUBLIC, anon, authenticated/
    );
    expect(merge).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.merge_contacts\(UUID, UUID, UUID\) TO service_role/
    );
  });
});
