import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { contactDisplayName, resolveOrCreateContact } from './identity';
import type { IdentityCandidate } from './types';

type Row = Record<string, unknown>;

const state = {
  tables: {} as Record<string, Row[]>,
  seq: 0,
  /** Rows to inject right before the next contacts insert (simulated race). */
  raceRow: null as Row | null,
};

// Minimal stateful fake of the supabase-js builder, with the unique
// indexes that matter: contacts (account, wa_user_id) / (account, phone
// digits when non-empty) and contact_identities (account, kind, external_id).
class Query {
  private op: 'select' | 'insert' | 'update' | 'upsert' = 'select';
  private payload: Row | Row[] = {};
  private filters: ((r: Row) => boolean)[] = [];
  private ignoreDup = false;
  private mode: 'many' | 'maybe' | 'single' = 'many';
  constructor(private table: string) {}
  private rows() {
    return (state.tables[this.table] ??= []);
  }
  select() {
    return this;
  }
  insert(p: Row) {
    this.op = 'insert';
    this.payload = p;
    return this;
  }
  update(p: Row) {
    this.op = 'update';
    this.payload = p;
    return this;
  }
  upsert(p: Row[], o: { ignoreDuplicates?: boolean }) {
    this.op = 'upsert';
    this.payload = p;
    this.ignoreDup = !!o.ignoreDuplicates;
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  in(c: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[c]));
    return this;
  }
  like(c: string, pattern: string) {
    const suffix = pattern.replace(/^%/, '');
    this.filters.push((r) => String(r[c] ?? '').endsWith(suffix));
    return this;
  }
  maybeSingle() {
    this.mode = 'maybe';
    return this;
  }
  single() {
    this.mode = 'single';
    return this;
  }
  private conflict(row: Row): boolean {
    const rows = this.rows();
    if (this.table === 'contact_identities') {
      return rows.some(
        (r) =>
          r.account_id === row.account_id &&
          r.kind === row.kind &&
          r.external_id === row.external_id
      );
    }
    return rows.some(
      (r) =>
        r.account_id === row.account_id &&
        ((row.wa_user_id && r.wa_user_id === row.wa_user_id) ||
          (row.phone && r.phone === row.phone))
    );
  }
  private run(): { data: unknown; error: unknown } {
    const rows = this.rows();
    let out: Row[] = [];
    if (this.op === 'insert') {
      if (this.table === 'contacts' && state.raceRow) {
        rows.push(state.raceRow);
        state.raceRow = null;
      }
      const row = this.payload as Row;
      if (this.conflict(row)) {
        return { data: null, error: { code: '23505', message: 'duplicate' } };
      }
      const withId = { id: `${this.table}-${++state.seq}`, ...row };
      rows.push(withId);
      out = [withId];
    } else if (this.op === 'upsert') {
      for (const row of this.payload as Row[]) {
        if (this.conflict(row) && this.ignoreDup) continue;
        rows.push({ id: `${this.table}-${++state.seq}`, ...row });
      }
    } else if (this.op === 'update') {
      out = rows.filter((r) => this.filters.every((f) => f(r)));
      for (const r of out) Object.assign(r, this.payload);
    } else {
      out = rows.filter((r) => this.filters.every((f) => f(r)));
    }
    if (this.mode === 'many') return { data: out, error: null };
    return { data: out[0] ?? null, error: null };
  }
  then<T>(res: (v: unknown) => T, rej?: (e: unknown) => T) {
    return Promise.resolve(this.run()).then(res, rej);
  }
}

const db = { from: (t: string) => new Query(t) } as unknown as SupabaseClient;

const ACC = 'acct-1';
const base = { accountId: ACC, auditUserId: 'user-1' };
const phone = (n: string): IdentityCandidate => ({
  kind: 'whatsapp:phone',
  externalId: n,
});
const bsuid = (v: string): IdentityCandidate => ({
  kind: 'whatsapp:bsuid',
  externalId: v,
});
const username = (v: string): IdentityCandidate => ({
  kind: 'whatsapp:username',
  externalId: v,
  handle: `@${v}`,
});
const contacts = () => state.tables.contacts ?? [];
const identities = () => state.tables.contact_identities ?? [];

beforeEach(() => {
  state.tables = {};
  state.seq = 0;
  state.raceRow = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('resolveOrCreateContact', () => {
  it('creates a phone contact with its identity', async () => {
    const out = await resolveOrCreateContact(db, {
      ...base,
      candidates: [phone('15551230000')],
      senderName: 'Ada',
    });
    expect(out?.wasCreated).toBe(true);
    expect(out?.contact).toMatchObject({
      phone: '15551230000',
      name: 'Ada',
      user_id: 'user-1',
      wa_user_id: null,
    });
    expect(identities()).toHaveLength(1);
    expect(identities()[0]).toMatchObject({
      contact_id: out?.contact.id,
      kind: 'whatsapp:phone',
      external_id: '15551230000',
    });
  });

  it('creates a BSUID/username-only contact with phone blank', async () => {
    const out = await resolveOrCreateContact(db, {
      ...base,
      candidates: [bsuid('US.13491208655302741918'), username('sheena')],
    });
    expect(out?.contact).toMatchObject({
      phone: '',
      name: 'sheena',
      wa_user_id: 'US.13491208655302741918',
      wa_username: 'sheena',
    });
    expect(
      identities()
        .map((i) => i.kind)
        .sort()
    ).toEqual(['whatsapp:bsuid', 'whatsapp:username']);
    expect(
      identities().find((i) => i.kind === 'whatsapp:username')?.handle
    ).toBe('@sheena');
  });

  it('names a nameless phone/BSUID contact after the identity, never blank', async () => {
    const a = await resolveOrCreateContact(db, {
      ...base,
      candidates: [phone('15551230000')],
    });
    const b = await resolveOrCreateContact(db, {
      ...base,
      candidates: [bsuid('US.99999999')],
    });
    expect(a?.contact.name).toBe('15551230000');
    expect(b?.contact.name).toBe('US.99999999');
  });

  it('refinds the contact by the BSUID identity on the next delivery', async () => {
    const first = await resolveOrCreateContact(db, {
      ...base,
      candidates: [bsuid('US.111111')],
    });
    const second = await resolveOrCreateContact(db, {
      ...base,
      candidates: [bsuid('US.111111')],
    });
    expect(second?.wasCreated).toBe(false);
    expect(second?.contact.id).toBe(first?.contact.id);
    expect(contacts()).toHaveLength(1);
  });

  it('finds by any candidate and adds the new identities to the same contact', async () => {
    const first = await resolveOrCreateContact(db, {
      ...base,
      candidates: [phone('15551230000')],
      senderName: 'Ada',
    });
    const second = await resolveOrCreateContact(db, {
      ...base,
      candidates: [phone('15551230000'), bsuid('US.222222'), username('ada')],
      senderName: 'Ada',
    });
    expect(second?.wasCreated).toBe(false);
    expect(second?.contact.id).toBe(first?.contact.id);
    expect(contacts()).toHaveLength(1);
    expect(identities()).toHaveLength(3);
    // Legacy columns backfilled so old code paths keep working.
    expect(contacts()[0]).toMatchObject({
      wa_user_id: 'US.222222',
      wa_username: 'ada',
      phone: '15551230000',
    });
    // A later BSUID-only delivery lands on the same contact.
    const third = await resolveOrCreateContact(db, {
      ...base,
      candidates: [bsuid('US.222222')],
    });
    expect(third?.contact.id).toBe(first?.contact.id);
  });

  it('fills a blank phone but never overwrites an existing one', async () => {
    const first = await resolveOrCreateContact(db, {
      ...base,
      candidates: [bsuid('US.333333')],
      senderName: 'Bo',
    });
    await resolveOrCreateContact(db, {
      ...base,
      candidates: [bsuid('US.333333'), phone('15550001111')],
    });
    expect(contacts()[0].phone).toBe('15550001111');
    await resolveOrCreateContact(db, {
      ...base,
      candidates: [bsuid('US.333333'), phone('15559990000')],
    });
    expect(contacts()[0].phone).toBe('15550001111');
    expect(contacts()[0].id).toBe(first?.contact.id);
  });

  it('does not clobber a hand-edited name when the channel sent none', async () => {
    await resolveOrCreateContact(db, {
      ...base,
      candidates: [phone('15551230000')],
      senderName: 'Ada',
    });
    contacts()[0].name = 'Ada (VIP)';
    await resolveOrCreateContact(db, {
      ...base,
      candidates: [phone('15551230000')],
    });
    expect(contacts()[0].name).toBe('Ada (VIP)');
  });

  it('falls back to legacy columns when contact_identities is empty', async () => {
    (state.tables.contacts ??= []).push({
      id: 'legacy-1',
      account_id: ACC,
      phone: '15551230000',
      name: 'Old',
      wa_user_id: null,
    });
    const byPhone = await resolveOrCreateContact(db, {
      ...base,
      candidates: [phone('+1 555 123 0000')],
    });
    expect(byPhone?.contact.id).toBe('legacy-1');
    // identity is now recorded
    expect(identities().some((i) => i.contact_id === 'legacy-1')).toBe(true);

    (state.tables.contacts ??= []).push({
      id: 'legacy-2',
      account_id: ACC,
      phone: '',
      name: 'Bsuid only',
      wa_user_id: 'US.444444',
    });
    const byBsuid = await resolveOrCreateContact(db, {
      ...base,
      candidates: [bsuid('US.444444')],
    });
    expect(byBsuid?.contact.id).toBe('legacy-2');
  });

  it('does not mix contacts across accounts', async () => {
    await resolveOrCreateContact(db, {
      ...base,
      candidates: [phone('15551230000')],
    });
    const other = await resolveOrCreateContact(db, {
      accountId: 'acct-2',
      auditUserId: 'user-2',
      candidates: [phone('15551230000')],
    });
    expect(other?.wasCreated).toBe(true);
    expect(contacts()).toHaveLength(2);
  });

  it('recovers from a unique violation race by re-reading the winner', async () => {
    state.raceRow = {
      id: 'winner',
      account_id: ACC,
      phone: '',
      name: 'Winner',
      wa_user_id: 'US.555555',
    };
    const out = await resolveOrCreateContact(db, {
      ...base,
      candidates: [bsuid('US.555555')],
    });
    expect(out?.wasCreated).toBe(false);
    expect(out?.contact.id).toBe('winner');
    expect(contacts()).toHaveLength(1);
  });

  it('handles a Telegram chat id contact', async () => {
    const out = await resolveOrCreateContact(db, {
      ...base,
      candidates: [
        { kind: 'telegram:chat_id', externalId: '99887766' },
        { kind: 'telegram:username', externalId: 'zed', handle: '@zed' },
      ],
      senderName: 'Zed',
    });
    expect(out?.contact).toMatchObject({ phone: '', name: 'Zed' });
    expect(identities()).toHaveLength(2);
  });

  it('returns null with no usable candidate', async () => {
    expect(
      await resolveOrCreateContact(db, {
        ...base,
        candidates: [{ kind: 'whatsapp:phone', externalId: '  ' }],
      })
    ).toBeNull();
  });
});

describe('contactDisplayName', () => {
  it('prefers the name', () => {
    expect(contactDisplayName({ name: ' Ada ' }, [phone('15551230000')])).toBe(
      'Ada'
    );
  });

  it('walks @username -> phone -> BSUID -> channel id', () => {
    expect(
      contactDisplayName({ name: '' }, [
        bsuid('US.1234'),
        phone('15551230000'),
        username('sheena'),
      ])
    ).toBe('@sheena');
    expect(
      contactDisplayName({ name: '' }, [bsuid('US.1234'), phone('15551230000')])
    ).toBe('15551230000');
    expect(contactDisplayName({ name: '' }, [bsuid('US.1234')])).toBe(
      'US.1234'
    );
    expect(
      contactDisplayName({}, [{ kind: 'telegram:chat_id', externalId: '42' }])
    ).toBe('42');
    expect(
      contactDisplayName({}, [
        { kind: 'telegram:chat_id', externalId: '42' },
        { kind: 'telegram:username', externalId: 'zed', handle: '@zed' },
      ])
    ).toBe('@zed');
  });

  it('falls back to the legacy columns when identities are not loaded', () => {
    expect(contactDisplayName({ phone: '15551230000' })).toBe('15551230000');
    expect(contactDisplayName({ wa_username: 'sheena' })).toBe('@sheena');
    expect(contactDisplayName({ wa_user_id: 'US.1234' })).toBe('US.1234');
  });

  it('is empty only when there is no identity at all', () => {
    expect(contactDisplayName({ name: null })).toBe('');
  });
});
