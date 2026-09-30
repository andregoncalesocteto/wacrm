import { beforeEach, describe, expect, it } from 'vitest';

import { db, resetWorld, world } from '@/lib/channels/crm-world.fake';
import {
  applyEventConsent,
  hasConsent,
  recordConsent,
  type ConsentPurpose,
} from './consent';

const ACCT = 'acct-1';
const CT = 'ct-1';
const t = (name: string) => world.tables[name] ?? [];
const at = (iso: string) => new Date(iso);

/** The customer wrote to the CRM (implicit consent). */
function seedInbound(contactId = CT) {
  world.tables.conversations = [
    {
      id: 'cv-1',
      account_id: ACCT,
      contact_id: contactId,
      connection_id: 'c1',
    },
  ];
  world.tables.messages = [
    { id: 'm-1', conversation_id: 'cv-1', sender_type: 'customer' },
  ];
}

const explicit = (
  purpose: ConsentPurpose,
  granted: boolean,
  when = '2026-10-01T10:00:00Z'
) =>
  recordConsent(db, {
    accountId: ACCT,
    contactId: CT,
    purpose,
    granted,
    at: at(when),
    source: granted ? 'menu' : 'chat',
  });

beforeEach(() => resetWorld());

describe('hasConsent', () => {
  it('is false for someone who never wrote and has no explicit consent', async () => {
    expect(await hasConsent(db, ACCT, CT, 'notifications')).toBe(false);
    expect(await hasConsent(db, ACCT, CT, 'marketing')).toBe(false);
  });

  it('is implicit for someone who wrote, and stores nothing', async () => {
    seedInbound();
    expect(await hasConsent(db, ACCT, CT, 'notifications')).toBe(true);
    expect(await hasConsent(db, ACCT, CT, 'marketing')).toBe(true);
    expect(t('contact_consents')).toHaveLength(0);
  });

  it('ignores outbound messages and the conversations of other contacts', async () => {
    seedInbound('someone-else');
    expect(await hasConsent(db, ACCT, CT, 'notifications')).toBe(false);
    world.tables.conversations = [
      { id: 'cv-1', account_id: ACCT, contact_id: CT, connection_id: 'c1' },
    ];
    world.tables.messages = [
      { id: 'm-1', conversation_id: 'cv-1', sender_type: 'agent' },
    ];
    expect(await hasConsent(db, ACCT, CT, 'notifications')).toBe(false);
  });

  it('depends on the explicit consent for someone who never wrote, per purpose', async () => {
    await explicit('notifications', true);
    expect(await hasConsent(db, ACCT, CT, 'notifications')).toBe(true);
    expect(await hasConsent(db, ACCT, CT, 'marketing')).toBe(false);
  });

  it('an explicit revocation beats the implicit consent of having written', async () => {
    seedInbound();
    await explicit('notifications', false);
    expect(await hasConsent(db, ACCT, CT, 'notifications')).toBe(false);
    // only that purpose: marketing is still implicit
    expect(await hasConsent(db, ACCT, CT, 'marketing')).toBe(true);
  });

  it('a NEWER explicit grant reactivates a revoked purpose, an older one does not', async () => {
    seedInbound();
    await explicit('notifications', false, '2026-10-01T10:00:00Z');
    await explicit('notifications', true, '2026-09-01T10:00:00Z');
    expect(await hasConsent(db, ACCT, CT, 'notifications')).toBe(false);
    await explicit('notifications', true, '2026-10-02T10:00:00Z');
    expect(await hasConsent(db, ACCT, CT, 'notifications')).toBe(true);
  });

  it('is scoped by account', async () => {
    await explicit('notifications', true);
    expect(await hasConsent(db, 'acct-2', CT, 'notifications')).toBe(false);
  });
});

describe('recordConsent', () => {
  it('stores the proof of a grant: active, date and source', async () => {
    expect(await explicit('notifications', true)).toBe(true);
    expect(t('contact_consents')).toEqual([
      expect.objectContaining({
        account_id: ACCT,
        contact_id: CT,
        purpose: 'notifications',
        granted: true,
        given_at: '2026-10-01T10:00:00.000Z',
        revoked_at: null,
        source: 'menu',
      }),
    ]);
  });

  it('applies only a STRICTLY newer decision', async () => {
    await explicit('notifications', true, '2026-10-01T10:00:00Z');
    expect(await explicit('notifications', false, '2026-10-01T10:00:00Z')).toBe(
      false
    );
    expect(await explicit('notifications', false, '2026-09-30T10:00:00Z')).toBe(
      false
    );
    expect(t('contact_consents')[0]).toMatchObject({ granted: true });
    expect(await explicit('notifications', false, '2026-10-01T10:00:01Z')).toBe(
      true
    );
  });

  it('a revocation keeps the past given_at and records revoked_at', async () => {
    await explicit('marketing', true, '2026-10-01T10:00:00Z');
    await explicit('marketing', false, '2026-10-05T10:00:00Z');
    expect(t('contact_consents')[0]).toMatchObject({
      granted: false,
      given_at: '2026-10-01T10:00:00.000Z',
      revoked_at: '2026-10-05T10:00:00.000Z',
      source: 'chat',
    });
  });

  it('a revocation with no prior row is stored (and holds)', async () => {
    await explicit('marketing', false);
    expect(t('contact_consents')[0]).toMatchObject({
      granted: false,
      given_at: null,
      revoked_at: '2026-10-01T10:00:00.000Z',
    });
  });

  it('a grant after a revocation clears revoked_at', async () => {
    await explicit('marketing', false, '2026-10-01T10:00:00Z');
    await explicit('marketing', true, '2026-10-03T10:00:00Z');
    expect(t('contact_consents')[0]).toMatchObject({
      granted: true,
      given_at: '2026-10-03T10:00:00.000Z',
      revoked_at: null,
    });
  });
});

describe('applyEventConsent', () => {
  const apply = (consent: Parameters<typeof applyEventConsent>[1]['consent']) =>
    applyEventConsent(db, {
      accountId: ACCT,
      contactId: CT,
      consent,
      source: 'menu',
    });

  it('touches only the purposes present', async () => {
    await explicit('marketing', true, '2026-10-01T10:00:00Z');
    const changed = await apply({
      notifications: true,
      givenAt: at('2026-10-02T10:00:00Z'),
    });
    expect(changed).toEqual(['notifications']);
    expect(
      t('contact_consents').find((r) => r.purpose === 'marketing')
    ).toMatchObject({ granted: true });
  });

  it('does nothing without consent or without any purpose', async () => {
    expect(await apply(null)).toEqual([]);
    expect(await apply({ givenAt: at('2026-10-02T10:00:00Z') })).toEqual([]);
    expect(t('contact_consents')).toHaveLength(0);
  });
});
