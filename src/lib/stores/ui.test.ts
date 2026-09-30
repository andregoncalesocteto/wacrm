import { describe, expect, it } from 'vitest';

import {
  connectionChipState,
  hoursToText,
  notificationCandidates,
  textToHours,
  validateDraft,
} from './ui';

const base = {
  name: 'A',
  address: '',
  phone: '',
  hours: '',
  store_code: '',
  store_acronym: '',
  business_acronym: '',
  notification_connection_id: '',
  manager_name: '',
  menu_url: '',
};

describe('connectionChipState', () => {
  it('maps known statuses', () => {
    for (const s of ['connected', 'degraded', 'needs_action'] as const) {
      expect(connectionChipState({ status: s, disabled_at: null })).toBe(s);
    }
  });
  it('falls back to disconnected', () => {
    expect(connectionChipState({ status: 'weird', disabled_at: null })).toBe(
      'disconnected'
    );
  });
  it('disabled_at wins', () => {
    expect(
      connectionChipState({ status: 'connected', disabled_at: '2026-01-01' })
    ).toBe('disabled');
  });
});

describe('hours', () => {
  it('round-trips text and blank to null', () => {
    expect(textToHours('  9h-18h ')).toEqual({ text: '9h-18h' });
    expect(textToHours('   ')).toBeNull();
    expect(hoursToText({ text: 'x' })).toBe('x');
    expect(hoursToText(null)).toBe('');
    expect(hoursToText({ mon: 1 })).toBe('');
  });
});

describe('validateDraft', () => {
  it('requires a name', () => {
    expect(validateDraft({ ...base, name: '  ' })).toBe('nameRequired');
  });
  it('limits lengths', () => {
    expect(validateDraft({ ...base, name: 'x'.repeat(121) })).toBe(
      'nameTooLong'
    );
    expect(validateDraft({ ...base, phone: '1'.repeat(41) })).toBe(
      'fieldTooLong'
    );
  });
  it('accepts blank or https menu url, rejects the rest', () => {
    expect(validateDraft({ ...base, menu_url: '  ' })).toBeNull();
    expect(validateDraft({ ...base, menu_url: 'https://a.com/m' })).toBeNull();
    for (const bad of ['http://a.com', 'a.com', 'ftp://a.com', 'https://']) {
      expect(validateDraft({ ...base, menu_url: bad })).toBe('menuUrlInvalid');
    }
  });
  it('accepts a valid draft', () => {
    expect(validateDraft(base)).toBeNull();
  });
  it('validates the store key parts', () => {
    expect(
      validateDraft({ ...base, store_code: '89', store_acronym: 'RPA' })
    ).toBeNull();
    expect(validateDraft({ ...base, store_code: '8/9' })).toBe('keyPartInvalid');
    expect(validateDraft({ ...base, business_acronym: 'x'.repeat(41) })).toBe(
      'fieldTooLong'
    );
  });
});

describe('notificationCandidates', () => {
  it('offers only enabled WhatsApp connections', () => {
    const c = (id: string, channel_type: string, disabled_at: string | null) => ({
      id,
      channel_type,
      disabled_at,
    });
    expect(
      notificationCandidates([
        c('a', 'whatsapp_cloud', null),
        c('b', 'whatsapp_cloud', '2026-01-01'),
        c('c', 'telegram', null),
      ]).map((x) => x.id)
    ).toEqual(['a']);
  });
});
