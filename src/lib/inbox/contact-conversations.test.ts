import { describe, expect, it } from 'vitest';

import { contactConversationsSummary } from './contact-conversations';

const conn = (
  id: string,
  storeId: string,
  storeName: string,
  extra: Record<string, unknown> = {}
) => ({
  id,
  channel_type: 'whatsapp_cloud',
  display_name: `Conn ${id}`,
  status: 'connected',
  disabled_at: null,
  store_id: storeId,
  store: { id: storeId, name: storeName },
  ...extra,
});

const row = (id: string, at: string | undefined, connection: unknown) =>
  ({
    id,
    status: 'open',
    last_message_text: `msg ${id}`,
    last_message_at: at,
    unread_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    connection,
  }) as never;

describe('contactConversationsSummary', () => {
  it('orders by last message, newest first', () => {
    const s = contactConversationsSummary([
      row('a', '2026-02-01T00:00:00Z', conn('c1', 's1', 'Alfa')),
      row('b', '2026-03-01T00:00:00Z', conn('c2', 's2', 'Beta')),
      row('c', undefined, conn('c2', 's2', 'Beta')),
    ]);
    expect(s.items.map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });

  it('flags the current conversation', () => {
    const s = contactConversationsSummary(
      [
        row('a', '2026-02-01T00:00:00Z', conn('c1', 's1', 'Alfa')),
        row('b', '2026-03-01T00:00:00Z', conn('c2', 's2', 'Beta')),
      ],
      'a'
    );
    expect(s.items.find((i) => i.id === 'a')?.isCurrent).toBe(true);
    expect(s.items.find((i) => i.id === 'b')?.isCurrent).toBe(false);
  });

  it('is hidden with zero or one conversation', () => {
    expect(contactConversationsSummary([]).visible).toBe(false);
    expect(
      contactConversationsSummary([row('a', undefined, conn('c1', 's1', 'A'))])
        .visible
    ).toBe(false);
  });

  it('is visible with two and carries store, channel, disabled', () => {
    const s = contactConversationsSummary([
      row('a', '2026-02-01T00:00:00Z', conn('c1', 's1', 'Alfa')),
      row(
        'b',
        '2026-03-01T00:00:00Z',
        conn('c2', 's2', 'Beta', { disabled_at: '2026-03-02T00:00:00Z' })
      ),
    ]);
    expect(s.visible).toBe(true);
    expect(s.items[0]).toMatchObject({
      storeName: 'Beta',
      channelType: 'whatsapp_cloud',
      disabled: true,
      connectionName: null,
    });
  });

  it('shows the connection name only when a store has several connections', () => {
    const s = contactConversationsSummary([
      row('a', '2026-02-01T00:00:00Z', conn('c1', 's1', 'Alfa')),
      row('b', '2026-03-01T00:00:00Z', conn('c2', 's1', 'Alfa')),
      row('c', '2026-01-01T00:00:00Z', conn('c3', 's2', 'Beta')),
    ]);
    expect(s.items.map((i) => i.connectionName)).toEqual([
      'Conn c2',
      'Conn c1',
      null,
    ]);
  });

  it('tolerates a conversation without connection', () => {
    const s = contactConversationsSummary([
      row('a', '2026-02-01T00:00:00Z', null),
      row('b', '2026-03-01T00:00:00Z', undefined),
    ]);
    expect(s.items[0]).toMatchObject({ storeName: null, channelType: null });
  });
});
