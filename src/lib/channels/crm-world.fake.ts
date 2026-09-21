import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * ONE stateful in-memory supabase-js client shared by every layer of the
 * Telegram CRM integration test (`providers/telegram/crm.integration.test.ts`):
 * ingest, fan-out, automations engine, flows engine, the channel send core, the
 * inbox/contact writes an agent makes, and the dashboard queries. Not a test file.
 *
 * It models only what that flow needs: the unique indexes that matter
 * (identities, conversation per contact+connection, message per conversation,
 * contact_tags, custom values, one active flow run per conversation),
 * `created_at` stamping, and the two embeds used (`contact:contacts`,
 * `conversations(`).
 */
export type Row = Record<string, unknown>;

export const world = {
  tables: {} as Record<string, Row[]>,
  seq: 0,
};

export function resetWorld(): void {
  world.tables = {};
  world.seq = 0;
}

const UNIQUE: Record<string, string[][]> = {
  contact_identities: [['account_id', 'kind', 'external_id']],
  conversations: [['contact_id', 'connection_id']],
  messages: [['conversation_id', 'message_id']],
  contact_tags: [['contact_id', 'tag_id']],
  contact_custom_values: [['contact_id', 'custom_field_id']],
};

class Query {
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private payload: Row | Row[] = {};
  private filters: ((r: Row) => boolean)[] = [];
  private mode: 'many' | 'maybe' | 'single' = 'many';
  private head = false;
  private embedContact = false;
  private embedConversation = false;
  private sort: { col: string; asc: boolean } | null = null;
  private max: number | null = null;
  private ignoreDup = false;
  private onConflict: string[] = [];
  constructor(private table: string) {}

  private rows() {
    return (world.tables[this.table] ??= []);
  }
  select(cols?: string, opts?: { head?: boolean }) {
    if (opts?.head) this.head = true;
    if (typeof cols === 'string') {
      if (cols.includes('contact:contacts')) this.embedContact = true;
      if (cols.includes('conversations(')) this.embedConversation = true;
    }
    return this;
  }
  insert(p: Row | Row[]) {
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
    o?: { onConflict?: string; ignoreDuplicates?: boolean }
  ) {
    this.op = 'upsert';
    this.payload = p;
    this.ignoreDup = !!o?.ignoreDuplicates;
    this.onConflict = (o?.onConflict ?? '').split(',').filter(Boolean);
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  neq(c: string, v: unknown) {
    this.filters.push((r) => r[c] !== v);
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
  gte(c: string, v: string | number) {
    this.filters.push((r) => (r[c] as string | number) >= v);
    return this;
  }
  lt(c: string, v: string | number) {
    this.filters.push((r) => (r[c] as string | number) < v);
    return this;
  }
  like(c: string, pattern: string) {
    const suffix = pattern.replace(/^%/, '');
    this.filters.push((r) => String(r[c] ?? '').endsWith(suffix));
    return this;
  }
  filter() {
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.sort = { col, asc: opts?.ascending !== false };
    return this;
  }
  limit(n?: number) {
    if (typeof n === 'number') this.max = n;
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

  private conflictsWith(row: Row, keys?: string[]): Row | undefined {
    const groups = keys?.length ? [keys] : (UNIQUE[this.table] ?? []);
    return this.rows().find((r) =>
      groups.some((g) => g.every((k) => r[k] === row[k]))
    );
  }
  private matches(r: Row) {
    return this.filters.every((f) => f(r));
  }
  private insertRow(row: Row): Row {
    const withId: Row = {
      id: `${this.table}-${++world.seq}`,
      created_at: new Date().toISOString(),
      ...(this.table === 'conversations'
        ? { status: 'open', unread_count: 0 }
        : {}),
      ...row,
    };
    this.rows().push(withId);
    return withId;
  }
  private run(): { data: unknown; error: unknown; count?: number } {
    const rows = this.rows();
    let out: Row[] = [];
    if (this.op === 'insert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const row of list) {
        if (this.conflictsWith(row)) {
          return { data: null, error: { code: '23505', message: 'duplicate' } };
        }
        out.push(this.insertRow(row));
      }
    } else if (this.op === 'upsert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const row of list) {
        const hit = this.conflictsWith(row, this.onConflict);
        if (hit) {
          if (!this.ignoreDup) Object.assign(hit, row);
          continue;
        }
        out.push(this.insertRow(row));
      }
    } else if (this.op === 'update') {
      out = rows.filter((r) => this.matches(r));
      for (const r of out) Object.assign(r, this.payload);
    } else if (this.op === 'delete') {
      const gone = rows.filter((r) => this.matches(r));
      world.tables[this.table] = rows.filter((r) => !gone.includes(r));
      return { data: null, error: null };
    } else {
      out = rows.filter((r) => this.matches(r));
      if (this.embedContact) {
        out = out.map((r) => ({
          ...r,
          contact:
            (world.tables.contacts ?? []).find((c) => c.id === r.contact_id) ??
            null,
        }));
      }
      if (this.embedConversation) {
        out = out.map((r) => ({
          ...r,
          conversations:
            (world.tables.conversations ?? []).find(
              (c) => c.id === r.conversation_id
            ) ?? null,
        }));
      }
      if (this.sort) {
        const { col, asc } = this.sort;
        out = [...out].sort(
          (a, b) =>
            String(a[col] ?? '').localeCompare(String(b[col] ?? '')) *
            (asc ? 1 : -1)
        );
      }
      if (this.max !== null) out = out.slice(0, this.max);
      if (this.head) return { data: null, error: null, count: out.length };
    }
    if (this.mode === 'many') return { data: out, error: null };
    if (this.mode === 'single' && !out[0]) {
      return { data: null, error: { message: 'no rows' } };
    }
    return { data: out[0] ?? null, error: null };
  }
  then<T>(res: (v: unknown) => T, rej?: (e: unknown) => T) {
    return Promise.resolve(this.run()).then(res, rej);
  }
}

export const rpcCalls: { name: string; args: Row }[] = [];

export const db = {
  from: (t: string) => new Query(t),
  // Mirrors bump_conversation_on_inbound (migration 037); other RPCs are counters.
  rpc: (name: string, args: Row) => {
    rpcCalls.push({ name, args });
    if (name === 'bump_conversation_on_inbound') {
      const conv = (world.tables.conversations ?? []).find(
        (c) => c.id === args.p_conversation_id
      );
      if (conv) {
        conv.unread_count = ((conv.unread_count as number) ?? 0) + 1;
        conv.last_message_text = args.p_last_message_text;
        conv.last_message_at = new Date().toISOString();
      }
    }
    return Promise.resolve({ data: null, error: null });
  },
} as unknown as SupabaseClient;
