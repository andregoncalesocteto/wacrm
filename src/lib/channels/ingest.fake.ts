import type { SupabaseClient } from '@supabase/supabase-js';

/** Stateful in-memory supabase-js fake for ingest tests (copy of ingest.test.ts's, plus delete, embedded conversations join and message_reactions upsert). */
export type Row = Record<string, unknown>;

export const state = {
  tables: {} as Record<string, Row[]>,
  seq: 0,
  rpcCalls: [] as { name: string; args: Row }[],
};

// Stateful fake of the supabase-js builder with the unique indexes that matter
// here: conversations (account, contact) [the pre-US-032 index], messages
// (conversation, message_id), contacts (account, wa_user_id / phone) and
// contact_identities (account, kind, external_id).
class Query {
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private joined = false;
  private payload: Row | Row[] = {};
  private filters: ((r: Row) => boolean)[] = [];
  private ignoreDup = false;
  private onConflict = '';
  private head = false;
  private mode: 'many' | 'maybe' | 'single' = 'many';
  constructor(private table: string) {}
  private rows() {
    return (state.tables[this.table] ??= []);
  }
  select(c?: string, o?: { head?: boolean }) {
    if (o?.head) this.head = true;
    if (c?.includes('conversations(')) this.joined = true;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  limit() {
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
  upsert(
    p: Row | Row[],
    o: { onConflict?: string; ignoreDuplicates?: boolean }
  ) {
    this.op = 'upsert';
    this.payload = p;
    this.ignoreDup = !!o.ignoreDuplicates;
    this.onConflict = o.onConflict ?? '';
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  is(c: string, v: unknown) {
    this.filters.push((r) => (r[c] ?? null) === v);
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
  order() {
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
    switch (this.table) {
      case 'contact_identities':
        return rows.some(
          (r) =>
            r.account_id === row.account_id &&
            r.kind === row.kind &&
            r.external_id === row.external_id
        );
      case 'conversations':
        return rows.some(
          (r) =>
            r.account_id === row.account_id && r.contact_id === row.contact_id
        );
      case 'message_reactions':
        return rows.some(
          (r) =>
            r.message_id === row.message_id &&
            r.actor_type === row.actor_type &&
            r.actor_id === row.actor_id
        );
      case 'messages':
        return rows.some(
          (r) =>
            r.conversation_id === row.conversation_id &&
            r.message_id === row.message_id
        );
      default:
        return rows.some(
          (r) =>
            r.account_id === row.account_id &&
            ((row.wa_user_id && r.wa_user_id === row.wa_user_id) ||
              (row.phone && r.phone === row.phone))
        );
    }
  }
  private run(): { data: unknown; error: unknown; count?: number } {
    const rows = this.rows();
    let out: Row[] = [];
    const insertRow = (row: Row) => {
      const withId = {
        id: `${this.table}-${++state.seq}`,
        status: this.table === 'conversations' ? 'open' : undefined,
        unread_count: this.table === 'conversations' ? 0 : undefined,
        ...row,
      };
      rows.push(withId);
      return withId;
    };
    if (this.op === 'insert') {
      const row = this.payload as Row;
      if (this.conflict(row)) {
        return { data: null, error: { code: '23505', message: 'duplicate' } };
      }
      out = [insertRow(row)];
    } else if (this.op === 'upsert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const row of list) {
        if (this.conflict(row)) {
          if (!this.ignoreDup) {
            const hit = rows.find(
              (r) =>
                r.message_id === row.message_id &&
                r.actor_type === row.actor_type &&
                r.actor_id === row.actor_id
            )!;
            Object.assign(hit, row);
            continue;
          }
          continue;
        }
        out.push(insertRow(row));
      }
    } else if (this.op === 'delete') {
      const gone = rows.filter((r) => this.filters.every((f) => f(r)));
      state.tables[this.table] = rows.filter((r) => !gone.includes(r));
      return { data: null, error: null };
    } else if (this.op === 'update') {
      out = rows.filter((r) => this.filters.every((f) => f(r)));
      for (const r of out) Object.assign(r, this.payload);
    } else {
      out = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.joined) {
        out = out.map((r) => ({
          ...r,
          conversations:
            (state.tables.conversations ?? []).find(
              (c) => c.id === r.conversation_id
            ) ?? null,
        }));
      }
      if (this.head) return { data: null, error: null, count: out.length };
    }
    if (this.mode === 'many') return { data: out, error: null };
    return { data: out[0] ?? null, error: null };
  }
  then<T>(res: (v: unknown) => T, rej?: (e: unknown) => T) {
    return Promise.resolve(this.run()).then(res, rej);
  }
}

export const db = {
  from: (t: string) => new Query(t),
  // Mirrors bump_conversation_on_inbound (migration 037).
  rpc: (name: string, args: Row) => {
    state.rpcCalls.push({ name, args });
    const conv = (state.tables.conversations ?? []).find(
      (c) => c.id === args.p_conversation_id
    );
    if (conv) {
      conv.unread_count = ((conv.unread_count as number) ?? 0) + 1;
      conv.last_message_text = args.p_last_message_text;
      conv.last_message_at = 'now';
      conv.updated_at = 'now';
    }
    return Promise.resolve({ data: null, error: null });
  },
} as unknown as SupabaseClient;
