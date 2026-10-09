// Guard for the Inbox going empty after migration 063.
//
// `channel_connections` and `stores` are linked by TWO foreign keys:
//   channel_connections.store_id               -> stores.id          (the connection's store)
//   stores.notification_connection_id          -> channel_connections.id (the store's notice connection, 063)
// A PostgREST embed that names only the table (`store:stores(…)`) is therefore
// ambiguous: the API answers HTTP 300 / PGRST201 and the page shows no
// conversations and "no channel connected". The embed must name the key.
// The fake database of the other tests does not model this, so pin it here.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CONVERSATION_SELECT } from './conversations';

const HINT = 'stores!channel_connections_store_id_fkey';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)
      ? [full]
      : [];
  });
}

describe('stores embed (two FKs between channel_connections and stores)', () => {
  it('the Inbox conversation select names the foreign key', () => {
    expect(CONVERSATION_SELECT).toContain(`store:${HINT}(`);
    expect(CONVERSATION_SELECT).not.toMatch(/:stores\(/);
  });

  it('no source file embeds `stores` by table name alone', () => {
    const offenders = sourceFiles(path.join(process.cwd(), 'src')).filter(
      (file) => /:stores\(/.test(readFileSync(file, 'utf8'))
    );
    expect(offenders.map((f) => path.relative(process.cwd(), f))).toEqual([]);
  });

  it('the Inbox connection list uses the same hinted embed', () => {
    const page = readFileSync(
      path.join(
        process.cwd(),
        'src',
        'app',
        '(dashboard)',
        'inbox',
        'page.tsx'
      ),
      'utf8'
    );
    expect(page).toContain(`store:${HINT}(name)`);
  });

  it('the migration that created the second key is still the reason for the hint', () => {
    const migration = readFileSync(
      path.join(
        process.cwd(),
        'supabase',
        'migrations',
        '063_store_key_and_notification_connection.sql'
      ),
      'utf8'
    );
    expect(migration).toMatch(
      /notification_connection_id[\s\S]*REFERENCES[\s\S]*channel_connections/i
    );
  });
});
