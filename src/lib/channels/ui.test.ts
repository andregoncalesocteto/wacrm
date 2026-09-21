import { describe, expect, it } from 'vitest';
import {
  canDeleteConnection,
  canRunConnectionActions,
  defaultConnectionId,
  emptyStateKind,
  errorSuggestion,
  groupConnectionsByStore,
  moveTargets,
  parseLastError,
  reasonFixKey,
  summarizeChannels,
  templatesForConnection,
  type ChannelConnectionRow,
} from './ui';

const conn = (id: string, store_id: string): ChannelConnectionRow => ({
  id,
  store_id,
  channel_type: 'whatsapp_cloud',
  display_name: id,
  status: 'connected',
  disabled_at: null,
  last_inbound_at: null,
  has_conversations: false,
});

describe('groupConnectionsByStore', () => {
  const stores = [
    { id: 's1', name: 'Centro' },
    { id: 's2', name: 'Norte' },
    { id: 's3', name: 'Vazia' },
  ];

  it('groups in store order and skips stores without connections', () => {
    const groups = groupConnectionsByStore(stores, [
      conn('c1', 's2'),
      conn('c2', 's1'),
      conn('c3', 's2'),
    ]);
    expect(groups.map((g) => g.store.id)).toEqual(['s1', 's2']);
    expect(groups[1].connections.map((c) => c.id)).toEqual(['c1', 'c3']);
  });

  it('drops connections of an unknown store', () => {
    expect(groupConnectionsByStore(stores, [conn('c1', 'zz')])).toEqual([]);
  });
});

describe('canDeleteConnection', () => {
  it('only without conversations', () => {
    expect(canDeleteConnection({ has_conversations: false })).toBe(true);
    expect(canDeleteConnection({ has_conversations: true })).toBe(false);
  });
});

describe('emptyStateKind', () => {
  it('distinguishes the three states', () => {
    expect(emptyStateKind(0, 0)).toBe('no-stores');
    expect(emptyStateKind(2, 0)).toBe('no-connections');
    expect(emptyStateKind(2, 1)).toBe('has-connections');
  });
});

describe('reasonFixKey', () => {
  it('maps the https guard reason, ignores anything else', () => {
    expect(reasonFixKey('public_https_required')).toBe('publicHttps');
    expect(reasonFixKey('other')).toBeUndefined();
    expect(reasonFixKey(undefined)).toBeUndefined();
    expect(
      parseLastError({ code: 'invalid', message: 'm', reason: 'r' })
    ).toEqual({ code: 'invalid', message: 'm', reason: 'r' });
  });
});

describe('parseLastError', () => {
  it('normalizes null, partial and odd shapes', () => {
    expect(parseLastError(null)).toBeNull();
    expect(parseLastError('x')).toBeNull();
    expect(parseLastError({})).toBeNull();
    expect(parseLastError({ code: 'auth', message: 'bad token' })).toEqual({
      code: 'auth',
      message: 'bad token',
    });
    expect(parseLastError({ message: 'boom' })).toEqual({
      code: null,
      message: 'boom',
    });
    expect(parseLastError({ code: 5, message: 7 })).toBeNull();
  });
});

describe('errorSuggestion', () => {
  it('maps by error type with a generic fallback', () => {
    expect(errorSuggestion('auth')).toBe('auth');
    expect(errorSuggestion('needs_action')).toBe('auth');
    expect(errorSuggestion('rate_limited')).toBe('rate_limited');
    expect(errorSuggestion('recipient_unreachable')).toBe('generic');
    expect(errorSuggestion('invalid')).toBe('generic');
    expect(errorSuggestion(null)).toBe('generic');
  });
});

describe('canRunConnectionActions / moveTargets', () => {
  it('blocks actions on a disabled connection', () => {
    expect(canRunConnectionActions({ disabled_at: null })).toBe(true);
    expect(canRunConnectionActions({ disabled_at: '2026-01-01' })).toBe(false);
  });
  it('excludes the current store from move targets', () => {
    const stores = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    expect(moveTargets(stores, 'a')).toEqual([{ id: 'b', name: 'B' }]);
  });
});

describe('summarizeChannels', () => {
  const c = (status: string, disabled = false) => ({
    status,
    disabled_at: disabled ? '2026-01-01' : null,
  });
  it('is empty without connections', () => {
    expect(summarizeChannels([])).toEqual({
      connected: 0,
      total: 0,
      disabled: 0,
      worst: null,
    });
  });
  it('counts connected of enabled and picks the worst state', () => {
    const s = summarizeChannels([
      c('connected'),
      c('degraded'),
      c('needs_action'),
      c('disconnected'),
    ]);
    expect(s).toMatchObject({ connected: 1, total: 4, worst: 'needs_action' });
  });
  it('orders disconnected above degraded', () => {
    expect(summarizeChannels([c('degraded'), c('disconnected')]).worst).toBe(
      'disconnected'
    );
  });
  it('reports all-connected as connected', () => {
    expect(summarizeChannels([c('connected'), c('connected')])).toMatchObject({
      connected: 2,
      total: 2,
      worst: 'connected',
    });
  });
  it('keeps disabled connections out of Y and out of the worst state', () => {
    const s = summarizeChannels([c('connected'), c('needs_action', true)]);
    expect(s).toEqual({
      connected: 1,
      total: 1,
      disabled: 1,
      worst: 'connected',
    });
  });
  it('only disabled connections leaves worst null', () => {
    expect(summarizeChannels([c('connected', true)])).toMatchObject({
      total: 0,
      disabled: 1,
      worst: null,
    });
  });
});

describe('templatesForConnection / defaultConnectionId', () => {
  it('default is the enabled connection first, else the first', () => {
    expect(
      defaultConnectionId([
        { id: 'a', disabled_at: 'x' },
        { id: 'b', disabled_at: null },
      ])
    ).toBe('b');
    expect(defaultConnectionId([{ id: 'a', disabled_at: 'x' }])).toBe('a');
    expect(defaultConnectionId([])).toBeNull();
  });
  it('filters by connection_id and gives NULL rows to the default', () => {
    const rows = [
      { id: 't1', connection_id: 'a' },
      { id: 't2', connection_id: 'b' },
      { id: 't3', connection_id: null },
      { id: 't4' },
    ];
    expect(templatesForConnection(rows, 'a', 'a').map((r) => r.id)).toEqual([
      't1',
      't3',
      't4',
    ]);
    expect(templatesForConnection(rows, 'b', 'a').map((r) => r.id)).toEqual([
      't2',
    ]);
  });
});
