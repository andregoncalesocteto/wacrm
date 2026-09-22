import { describe, expect, it } from 'vitest';

import {
  connectionChipState,
  hoursToText,
  textToHours,
  validateDraft,
} from './ui';

const base = { name: 'A', address: '', phone: '', hours: '', manager_name: '' };

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
  it('accepts a valid draft', () => {
    expect(validateDraft(base)).toBeNull();
  });
});
