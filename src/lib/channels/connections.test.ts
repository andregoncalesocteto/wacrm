import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  updates: [] as { table: string; values: Row; filters: Row }[],
  failUpdate: false,
  admin: null as unknown,
}));

function makeClient(label: string) {
  const touched: string[] = [];
  const client = {
    label,
    touched,
    from(table: string) {
      touched.push(table);
      const filters: Row = {};
      let updateValues: Row | null = null;
      const q = {
        select: () => q,
        update: (v: Row) => ((updateValues = v), q),
        eq: (k: string, v: unknown) => ((filters[k] = v), q),
        order: () => q,
        maybeSingle: async () => {
          const r = (h.tables[table] ?? []).filter((x) =>
            Object.entries(filters).every(([k, v]) => x[k] === v)
          );
          return { data: r[0] ?? null, error: null };
        },
        then(
          resolve: (v: unknown) => unknown,
          reject?: (e: unknown) => unknown
        ) {
          const run = async () => {
            if (updateValues) {
              if (h.failUpdate) throw new Error('boom');
              h.updates.push({ table, values: updateValues, filters });
              for (const x of h.tables[table] ?? []) {
                if (Object.entries(filters).every(([k, v]) => x[k] === v)) {
                  Object.assign(x, updateValues);
                }
              }
              return { data: null, error: null };
            }
            const r = (h.tables[table] ?? []).filter((x) =>
              Object.entries(filters).every(([k, v]) => x[k] === v)
            );
            return { data: r, error: null };
          };
          return run().then(resolve, reject);
        },
      };
      return q;
    },
  };
  return client;
}

vi.mock('./admin-client', () => ({ supabaseAdmin: () => h.admin }));

import {
  getConnectionById,
  getConnectionByExternalId,
  listConnectionsByAccount,
  listConnectionsByStore,
  getConnectionCredentials,
} from './connections';

const conn = (o: Row): Row => ({
  id: 'c1',
  account_id: 'a1',
  store_id: 's1',
  channel_type: 'whatsapp_cloud',
  external_id: 'pn1',
  ...o,
});

let admin: ReturnType<typeof makeClient>;

beforeEach(() => {
  h.updates = [];
  h.failUpdate = false;
  h.tables = {
    channel_connections: [
      conn({}),
      conn({
        id: 'c2',
        store_id: 's2',
        channel_type: 'telegram',
        external_id: 'bot1',
      }),
      conn({ id: 'c3', account_id: 'a2', store_id: 's3', external_id: 'pn3' }),
    ],
    channel_connection_credentials: [],
  };
  admin = makeClient('admin');
  h.admin = admin;
});

describe('connection reads', () => {
  it('finds by id and returns null when missing', async () => {
    expect((await getConnectionById('c1'))?.id).toBe('c1');
    expect(await getConnectionById('nope')).toBeNull();
  });

  it('finds by (channel_type, external_id)', async () => {
    expect((await getConnectionByExternalId('telegram', 'bot1'))?.id).toBe(
      'c2'
    );
    expect(await getConnectionByExternalId('telegram', 'pn1')).toBeNull();
  });

  it('lists by account and by store', async () => {
    expect((await listConnectionsByAccount('a1')).map((c) => c.id)).toEqual([
      'c1',
      'c2',
    ]);
    expect((await listConnectionsByStore('s2')).map((c) => c.id)).toEqual([
      'c2',
    ]);
    expect(await listConnectionsByStore('none')).toEqual([]);
  });
});

describe('credentials', () => {
  it('returns null when the connection has no credentials', async () => {
    expect(await getConnectionCredentials('missing')).toBeNull();
  });

  it('reads wa_token_v0 as { access_token } and rewrites it as json_v1', async () => {
    h.tables.channel_connection_credentials = [
      {
        connection_id: 'c1',
        secrets_encrypted: encrypt('EAAtoken'),
        secrets_format: 'wa_token_v0',
      },
    ];
    expect(await getConnectionCredentials('c1')).toEqual({
      access_token: 'EAAtoken',
    });
    expect(h.updates).toHaveLength(1);
    const row = h.tables.channel_connection_credentials[0];
    expect(row.secrets_format).toBe('json_v1');
    expect(JSON.parse(decrypt(row.secrets_encrypted as string))).toEqual({
      access_token: 'EAAtoken',
    });
    // second read is a plain json_v1 read: no further write
    expect(await getConnectionCredentials('c1')).toEqual({
      access_token: 'EAAtoken',
    });
    expect(h.updates).toHaveLength(1);
  });

  it('reads json_v1 without rewriting', async () => {
    h.tables.channel_connection_credentials = [
      {
        connection_id: 'c2',
        secrets_encrypted: encrypt(
          JSON.stringify({ access_token: 'x', secret_token: 'y' })
        ),
        secrets_format: 'json_v1',
      },
    ];
    expect(await getConnectionCredentials('c2')).toEqual({
      access_token: 'x',
      secret_token: 'y',
    });
    expect(h.updates).toHaveLength(0);
  });

  it('upgrades a legacy CBC ciphertext inside json_v1 to GCM', async () => {
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv(
      'aes-256-cbc',
      Buffer.from(process.env.ENCRYPTION_KEY!, 'hex'),
      iv
    );
    const cbc = `${iv.toString('hex')}:${c.update('{"a":1}', 'utf8', 'hex') + c.final('hex')}`;
    h.tables.channel_connection_credentials = [
      {
        connection_id: 'c1',
        secrets_encrypted: cbc,
        secrets_format: 'json_v1',
      },
    ];
    expect(await getConnectionCredentials('c1')).toEqual({ a: 1 });
    expect(
      (
        h.tables.channel_connection_credentials[0].secrets_encrypted as string
      ).split(':')
    ).toHaveLength(3);
  });

  it('does not throw when the upgrade write fails, and still returns the token', async () => {
    h.failUpdate = true;
    h.tables.channel_connection_credentials = [
      {
        connection_id: 'c1',
        secrets_encrypted: encrypt('tok'),
        secrets_format: 'wa_token_v0',
      },
    ];
    expect(await getConnectionCredentials('c1')).toEqual({
      access_token: 'tok',
    });
    expect(h.tables.channel_connection_credentials[0].secrets_format).toBe(
      'wa_token_v0'
    );
  });

  it('rejects an unknown secrets_format', async () => {
    h.tables.channel_connection_credentials = [
      {
        connection_id: 'c1',
        secrets_encrypted: encrypt('t'),
        secrets_format: 'weird',
      },
    ];
    await expect(getConnectionCredentials('c1')).rejects.toThrow(
      /secrets_format/
    );
  });
});

describe('user-scoped clients never yield credentials', () => {
  it('reads with a user client never touch the credentials table nor expose secrets', async () => {
    h.tables.channel_connection_credentials = [
      {
        connection_id: 'c1',
        secrets_encrypted: encrypt('SECRET'),
        secrets_format: 'wa_token_v0',
      },
    ];
    const user = makeClient('user');
    const results = [
      await getConnectionById('c1', user as never),
      await getConnectionByExternalId('whatsapp_cloud', 'pn1', user as never),
      await listConnectionsByAccount('a1', user as never),
      await listConnectionsByStore('s1', user as never),
    ];
    expect(user.touched.every((t) => t === 'channel_connections')).toBe(true);
    expect(JSON.stringify(results)).not.toMatch(
      /SECRET|secrets_encrypted|access_token/
    );
  });

  it('getConnectionCredentials accepts no client and only uses the service-role client', async () => {
    expect(getConnectionCredentials.length).toBe(1);
    h.tables.channel_connection_credentials = [
      {
        connection_id: 'c1',
        secrets_encrypted: encrypt('t'),
        secrets_format: 'wa_token_v0',
      },
    ];
    const user = makeClient('user');
    // extra argument (a user client) is ignored at runtime
    await (
      getConnectionCredentials as (id: string, c?: unknown) => Promise<unknown>
    )('c1', user);
    expect(user.touched).toEqual([]);
    expect(admin.touched).toContain('channel_connection_credentials');
  });
});
