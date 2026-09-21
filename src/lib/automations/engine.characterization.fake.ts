/**
 * In-memory stand-in for the service-role supabase-js client, shared by the
 * automations characterization tests (import it from a `vi.mock` factory).
 * Not a test file itself; only used by `*.characterization.test.ts`.
 */
type Row = Record<string, unknown>;

interface Harness {
  db: Record<string, Row[]>;
  seq: number;
  rpcCalls: { name: string; args: unknown }[];
}

export function fakeAdmin(h: Harness) {
  class Query {
    private op: 'select' | 'insert' | 'update' = 'select';
    private payload: Row = {};
    private filters: ((r: Row) => boolean)[] = [];
    private mode: 'many' | 'maybe' | 'single' = 'many';
    private sort: { col: string; asc: boolean } | null = null;
    constructor(private table: string) {}
    select() {
      return this;
    }
    insert(row: Row) {
      this.op = 'insert';
      this.payload = row;
      return this;
    }
    update(patch: Row) {
      this.op = 'update';
      this.payload = patch;
      return this;
    }
    eq(col: string, v: unknown) {
      this.filters.push((r) => r[col] === v);
      return this;
    }
    is(col: string, v: unknown) {
      this.filters.push((r) => (r[col] ?? null) === v);
      return this;
    }
    gte(col: string, v: number) {
      this.filters.push((r) => (r[col] as number) >= v);
      return this;
    }
    in(col: string, vs: unknown[]) {
      this.filters.push((r) => vs.includes(r[col]));
      return this;
    }
    order(col: string, opts?: { ascending?: boolean }) {
      this.sort = { col, asc: opts?.ascending !== false };
      return this;
    }
    limit() {
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
    private run() {
      const rows = (h.db[this.table] ??= []);
      let out: Row[];
      if (this.op === 'insert') {
        const row = { id: `${this.table}-${++h.seq}`, ...this.payload };
        rows.push(row);
        out = [row];
      } else if (this.op === 'update') {
        out = rows.filter((r) => this.filters.every((f) => f(r)));
        for (const r of out) Object.assign(r, this.payload);
      } else {
        out = rows.filter((r) => this.filters.every((f) => f(r)));
      }
      if (this.sort) {
        const { col, asc } = this.sort;
        out = [...out].sort(
          (a, b) => ((a[col] as number) - (b[col] as number)) * (asc ? 1 : -1)
        );
      }
      if (this.mode === 'many') return { data: out, error: null };
      if (this.mode === 'single' && !out[0]) {
        return { data: null, error: { message: 'no rows' } };
      }
      return { data: out[0] ?? null, error: null };
    }
    then<T>(resolve: (v: unknown) => T, reject?: (e: unknown) => T) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }
  }
  return {
    supabaseAdmin: () => ({
      from: (t: string) => new Query(t),
      rpc: (name: string, args: unknown) => {
        h.rpcCalls.push({ name, args });
        return Promise.resolve({ error: null });
      },
    }),
  };
}
