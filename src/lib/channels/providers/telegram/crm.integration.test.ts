/**
 * US-059: the CRM does not depend on the channel. A Telegram contact is born
 * from a simulated Bot API update (real provider parse, real ingest, real
 * fan-out), then goes through the CRM: deal from the conversation, tag, note,
 * custom field, an automation, a flow, and the dashboard totals. Everything
 * runs against ONE in-memory database (`crm-world.fake`); only the Telegram
 * HTTP call (`fetch`), the credentials lookup and the outbound webhooks are
 * stubbed. Nothing here has a phone number or a `wamid`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = '123456:BOT-token_XYZ';
const ACCOUNT = 'acct-1';
const OWNER = 'owner-1';
const CONN_ID = '11111111-2222-4333-8444-555555555555';
const fetchMock = vi.fn();

vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn() }));
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: vi.fn(async () => undefined),
}));
vi.mock('@/lib/channels/connections', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConnectionCredentials: async () => ({ bot_token: TOKEN }),
}));
const { fakeAdmin } = vi.hoisted(() => ({
  fakeAdmin: async () => {
    const { db } = await import('@/lib/channels/crm-world.fake');
    return { supabaseAdmin: () => db };
  },
}));
vi.mock('@/lib/channels/admin-client', fakeAdmin);
vi.mock('@/lib/automations/admin-client', fakeAdmin);
vi.mock('@/lib/flows/admin-client', fakeAdmin);

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMetrics, loadPipelineDonut } from '@/lib/dashboard/queries';
import { conversationCreatedHook, fanoutHook } from '../../fanout';
import { ingestInbound } from '../../ingest';
import { db, resetWorld, world, type Row } from '../../crm-world.fake';
import type { Connection } from '../../types';
import { telegramProvider } from './index';

const CONN = {
  id: CONN_ID,
  account_id: ACCOUNT,
  channel_type: 'telegram',
  external_id: 'bot-1',
  status: 'connected',
  disabled_at: null,
  config: {},
} as unknown as Connection;

const t = (name: string): Row[] => world.tables[name] ?? [];
const fixture = () =>
  readFileSync(join(__dirname, '__fixtures__', 'text.json'), 'utf8');

function seed() {
  resetWorld();
  world.tables = {
    channel_connections: [{ ...CONN }],
    tags: ['tag-auto', 'tag-flow', 'tag-manual'].map((id) => ({
      id,
      account_id: ACCOUNT,
    })),
    custom_fields: ['cf-origin', 'cf-interest'].map((id) => ({
      id,
      account_id: ACCOUNT,
    })),
    pipelines: [{ id: 'pipe-1', account_id: ACCOUNT }],
    pipeline_stages: [
      {
        id: 'stage-1',
        pipeline_id: 'pipe-1',
        name: 'Novo',
        color: '#123456',
        position: 0,
      },
    ],
    automations: [
      {
        id: 'auto-1',
        account_id: ACCOUNT,
        user_id: OWNER,
        trigger_type: 'new_contact_created',
        trigger_config: {},
        is_active: true,
      },
    ],
    automation_steps: [
      {
        id: 'step-1',
        automation_id: 'auto-1',
        position: 0,
        parent_step_id: null,
        branch: null,
        step_type: 'add_tag',
        step_config: { tag_id: 'tag-auto' },
      },
      {
        id: 'step-2',
        automation_id: 'auto-1',
        position: 1,
        parent_step_id: null,
        branch: null,
        step_type: 'update_contact_field',
        step_config: { field: 'custom:cf-origin', value: 'telegram' },
      },
    ],
    flows: [
      {
        id: 'flow-1',
        account_id: ACCOUNT,
        user_id: OWNER,
        status: 'active',
        trigger_type: 'keyword',
        trigger_config: { keywords: ['estoque'] },
        entry_node_id: 'start',
        created_at: '2020-01-01T00:00:00Z',
      },
    ],
    flow_nodes: [
      {
        id: 'n0',
        flow_id: 'flow-1',
        node_key: 'start',
        node_type: 'start',
        config: { next_node_key: 'hello' },
      },
      {
        id: 'n1',
        flow_id: 'flow-1',
        node_key: 'hello',
        node_type: 'send_message',
        config: { text: 'Temos sim!', next_node_key: 'tag' },
      },
      {
        id: 'n2',
        flow_id: 'flow-1',
        node_key: 'tag',
        node_type: 'set_tag',
        config: { mode: 'add', tag_id: 'tag-flow', next_node_key: 'end' },
      },
      {
        id: 'n3',
        flow_id: 'flow-1',
        node_key: 'end',
        node_type: 'end',
        config: {},
      },
    ],
  };
}

async function receiveTelegramMessage() {
  const events = await telegramProvider.parse(
    new Request('https://x', { method: 'POST', body: fixture() }),
    CONN
  );
  return ingestInbound(db, CONN, events, {
    auditUserId: OWNER,
    hooks: {
      onConversationCreated: conversationCreatedHook,
      onMessageStored: fanoutHook({ configOwnerUserId: OWNER }),
    },
  });
}

const contact = () => t('contacts')[0];
const conversation = () => t('conversations')[0];
const tagIds = () => t('contact_tags').map((r) => r.tag_id);

beforeEach(async () => {
  seed();
  fetchMock.mockReset();
  let sentId = 100;
  fetchMock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: ++sentId, chat: { id: 555000111 } },
        })
      )
  );
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});

  const outcome = await receiveTelegramMessage();
  expect(outcome[0].status).toBe('stored');
});

describe('a Telegram contact born from a simulated message', () => {
  it('has a contact, a conversation on the Telegram connection and an inbound message, without phone', () => {
    expect(t('contacts')).toHaveLength(1);
    expect(contact().phone ?? '').toBe('');
    expect(conversation()).toMatchObject({
      contact_id: contact().id,
      connection_id: CONN_ID,
      status: 'open',
    });
    expect(
      t('messages').find((m) => m.sender_type === 'customer')
    ).toMatchObject({
      message_id: '555000111:10',
      content_text: 'Olá, tem estoque?',
    });
  });

  it('is reachable only through Telegram identities', () => {
    expect(t('contact_identities').map((r) => r.kind)).toEqual([
      'telegram:chat_id',
      'telegram:username',
    ]);
  });
});

describe('automation and flow triggered by the message', () => {
  it('the automation tags the contact and fills a custom field', () => {
    expect(tagIds()).toContain('tag-auto');
    expect(t('contact_custom_values')).toEqual([
      expect.objectContaining({
        contact_id: contact().id,
        custom_field_id: 'cf-origin',
        value: 'telegram',
      }),
    ]);
    expect(t('automation_logs')[0]).toMatchObject({
      contact_id: contact().id,
      trigger_event: 'new_contact_created',
      status: 'success',
    });
  });

  it('the flow answers through Telegram, tags the contact and ends', () => {
    expect(t('flow_runs')).toEqual([
      expect.objectContaining({
        flow_id: 'flow-1',
        contact_id: contact().id,
        conversation_id: conversation().id,
        status: 'completed',
      }),
    ]);
    expect(tagIds()).toContain('tag-flow');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: '555000111',
      text: 'Temos sim!',
    });
    expect(t('messages').find((m) => m.sender_type === 'bot')).toMatchObject({
      message_id: '555000111:101',
      content_text: 'Temos sim!',
      status: 'sent',
    });
  });
});

describe('what the agent does in the CRM', () => {
  async function agentWorks() {
    // Deal from the conversation (same payload as the deal form).
    const deal = await db
      .from('deals')
      .insert({
        title: 'Pedido Maria',
        value: 2500,
        currency: 'BRL',
        contact_id: contact().id,
        pipeline_id: 'pipe-1',
        stage_id: 'stage-1',
        user_id: OWNER,
        account_id: ACCOUNT,
        status: 'open',
      })
      .select()
      .single();
    expect(deal.error).toBeNull();

    // Tag, note and custom field (same writes as the contact panel).
    const tag = await db
      .from('contact_tags')
      .insert({ contact_id: contact().id, tag_id: 'tag-manual' });
    const note = await db.from('contact_notes').insert({
      contact_id: contact().id,
      user_id: OWNER,
      note_text: 'Quer retirar na loja',
    });
    const field = await db.from('contact_custom_values').upsert(
      {
        contact_id: contact().id,
        custom_field_id: 'cf-interest',
        value: 'Sapatos',
      },
      { onConflict: 'contact_id,custom_field_id' }
    );
    expect(tag.error).toBeNull();
    expect(note.error).toBeNull();
    expect(field.error).toBeNull();
  }

  it('creates a deal, tags, notes and fills a custom field on the Telegram contact', async () => {
    await agentWorks();

    expect(t('deals')).toEqual([
      expect.objectContaining({ contact_id: contact().id, status: 'open' }),
    ]);
    expect(tagIds()).toEqual(
      expect.arrayContaining(['tag-auto', 'tag-flow', 'tag-manual'])
    );
    expect(t('contact_notes')).toHaveLength(1);
    expect(
      Object.fromEntries(
        t('contact_custom_values').map((r) => [r.custom_field_id, r.value])
      )
    ).toEqual({ 'cf-origin': 'telegram', 'cf-interest': 'Sapatos' });
  });

  it('shows up in the dashboard totals', async () => {
    await agentWorks();

    const metrics = await loadMetrics(db);
    expect(metrics.activeConversations.current).toBe(1);
    expect(metrics.newContactsToday.current).toBe(1);
    expect(metrics.openDealsCount).toBe(1);
    expect(metrics.openDealsValue).toBe(2500);

    const donut = await loadPipelineDonut(db);
    expect(donut.totalValue).toBe(2500);
    expect(donut.stages).toEqual([
      expect.objectContaining({ name: 'Novo', dealCount: 1, totalValue: 2500 }),
    ]);
  });
});

describe('nothing requires a phone number or a wamid', () => {
  it('no phone, no WhatsApp identity, no wamid and no Meta call anywhere', () => {
    expect(contact().phone ?? '').toBe('');
    expect(
      t('contact_identities').every(
        (r) => !String(r.kind).startsWith('whatsapp:')
      )
    ).toBe(true);

    const ids = t('messages').map((m) => String(m.message_id));
    expect(ids.length).toBeGreaterThan(1);
    expect(ids.every((id) => /^\d+:\d+$/.test(id))).toBe(true);
    expect(JSON.stringify(world.tables)).not.toContain('wamid');

    const hosts = fetchMock.mock.calls.map((c) => new URL(c[0] as string).host);
    expect(new Set(hosts)).toEqual(new Set(['api.telegram.org']));
  });
});
