import { beforeEach, describe, expect, it, vi } from 'vitest';

// A contact reached on two connections has two conversations, each
// with its own active run (migration 047). A reply must only touch the
// run of the conversation it arrived in.

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  runs: [] as Record<string, unknown>[],
  writes: [] as {
    table: string;
    op: string;
    patch: Row;
    filters: [string, unknown][];
  }[],
}));

vi.mock('./admin-client', () => {
  function builder(table: string) {
    let op = 'select';
    let patch: Row = {};
    const filters: [string, unknown][] = [];
    const matches = (r: Row) => filters.every(([c, v]) => r[c] === v);
    const rows = (): Row[] => {
      if (table === 'flow_runs') return h.runs.filter(matches);
      if (table === 'flow_nodes')
        return [
          {
            id: 'n1',
            flow_id: 'flow-1',
            node_key: 'ask',
            node_type: 'collect_input',
            config: { var_key: 'name', next_node_key: 'done', prompt: 'name?' },
          },
          {
            id: 'n2',
            flow_id: 'flow-1',
            node_key: 'done',
            node_type: 'end',
            config: {},
          },
        ];
      return [];
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => (filters.push([c, v]), b),
      in: () => b,
      is: () => b,
      filter: () => b,
      order: () => b,
      limit: () => b,
      update: (p: Row) => ((op = 'update'), (patch = p), b),
      insert: () => ((op = 'insert'), b),
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (r: unknown) => unknown) => {
        if (op !== 'select')
          h.writes.push({ table, op, patch, filters: [...filters] });
        const data = op === 'update' ? [{ id: 'x' }] : rows();
        return resolve({ data, error: null, count: 0 });
      },
    };
    return b;
  }
  return {
    supabaseAdmin: () => ({
      from: builder,
      rpc: async () => ({ error: null }),
    }),
  };
});

vi.mock('./send', () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'w' })),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: 'w' })),
  engineSendInteractiveButtons: vi.fn(async () => ({
    whatsapp_message_id: 'w',
  })),
  engineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: 'w' })),
}));

import { dispatchInboundToFlows } from './engine';

const run = (id: string, conversation_id: string) => ({
  id,
  account_id: 'acct-1',
  contact_id: 'ct-1',
  conversation_id,
  flow_id: 'flow-1',
  user_id: 'u-1',
  status: 'active',
  current_node_key: 'ask',
  vars: {},
  reprompt_count: 0,
  started_at: '2026-01-01T00:00:00Z',
});

const reply = (conversationId: string) =>
  dispatchInboundToFlows({
    accountId: 'acct-1',
    userId: 'u-1',
    contactId: 'ct-1',
    conversationId,
    message: {
      kind: 'text',
      text: 'Ana',
      meta_message_id: `wamid.${conversationId}`,
    },
    isFirstInboundMessage: false,
  });

beforeEach(() => {
  h.runs = [run('run-A', 'cv-A'), run('run-B', 'cv-B')];
  h.writes = [];
});

describe('flow runs are scoped by conversation', () => {
  it("a reply in conversation A advances only A's run", async () => {
    const res = await reply('cv-A');
    expect(res).toMatchObject({ consumed: true, flow_run_id: 'run-A' });
    const touched = h.writes
      .filter((w) => w.table === 'flow_runs')
      .flatMap((w) => w.filters.filter(([c]) => c === 'id').map(([, v]) => v));
    expect(touched).toContain('run-A');
    expect(touched).not.toContain('run-B');
  });

  it("a reply in conversation B advances only B's run", async () => {
    const res = await reply('cv-B');
    expect(res).toMatchObject({ consumed: true, flow_run_id: 'run-B' });
  });
});
