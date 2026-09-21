import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: vi.fn() }));

import {
  contactFieldSubjectValue,
  evaluateConditionPredicate,
} from '@/lib/flows/engine';
import { contactFieldMatches } from '@/lib/automations/engine';
import {
  previewFieldValue,
  resolveVariables,
} from '@/hooks/use-broadcast-sending';
import type { Contact } from '@/types';

const operators = ['present', 'absent', 'equals', 'contains'] as const;

describe('flows: phone condition for contacts without a phone', () => {
  const expected = {
    present: false,
    absent: true,
    equals: false,
    contains: false,
  };
  for (const raw of ['', null, undefined]) {
    for (const operator of operators) {
      it(`phone ${JSON.stringify(raw)} / ${operator}`, () => {
        const subjectValue = contactFieldSubjectValue(raw);
        expect(subjectValue).toBeUndefined();
        expect(
          evaluateConditionPredicate({
            operator,
            subjectValue,
            configValue: '+5511999990000',
          })
        ).toBe(expected[operator]);
      });
    }
  }

  it('equals with an empty comparison value is still false', () => {
    expect(
      evaluateConditionPredicate({
        operator: 'equals',
        subjectValue: contactFieldSubjectValue(''),
        configValue: '',
      })
    ).toBe(false);
  });

  it('a normal phone is unchanged', () => {
    const subjectValue = contactFieldSubjectValue('+5511999990000');
    expect(subjectValue).toBe('+5511999990000');
    const run = (operator: (typeof operators)[number], configValue: string) =>
      evaluateConditionPredicate({ operator, subjectValue, configValue });
    expect(run('present', '')).toBe(true);
    expect(run('absent', '')).toBe(false);
    expect(run('equals', '+5511999990000')).toBe(true);
    expect(run('equals', '+5511')).toBe(false);
    expect(run('contains', '9999')).toBe(true);
  });
});

describe('automations: contact_field on phone', () => {
  for (const raw of ['', null, undefined]) {
    it(`phone ${JSON.stringify(raw)} never matches`, () => {
      expect(contactFieldMatches('phone', raw, '+5511999990000')).toBe(false);
      expect(contactFieldMatches('phone', raw, '')).toBe(false);
      expect(contactFieldMatches('phone', raw, undefined)).toBe(false);
    });
  }

  it('a normal phone is unchanged', () => {
    expect(
      contactFieldMatches('phone', '+5511999990000', '+5511999990000')
    ).toBe(true);
    expect(contactFieldMatches('phone', '+5511999990000', '+5511')).toBe(false);
  });

  it('other fields keep the plain comparison', () => {
    expect(contactFieldMatches('name', 'Ana', 'Ana')).toBe(true);
    expect(contactFieldMatches('name', '', '')).toBe(true);
    expect(contactFieldMatches('email', null, '')).toBe(false);
  });
});

describe('broadcast personalization: {{phone}} without a phone', () => {
  const base = { id: 'c', name: 'Ana', email: 'a@x.com' } as Contact;
  const vars = { '1': { type: 'field' as const, value: 'phone' } };

  for (const phone of ['', null, undefined]) {
    it(`resolveVariables with phone ${JSON.stringify(phone)} is empty`, () => {
      const out = resolveVariables(vars, {
        ...base,
        phone,
      } as unknown as Contact);
      expect(out).toEqual(['']);
    });

    it(`preview with phone ${JSON.stringify(phone)} is empty, no placeholder`, () => {
      const out = previewFieldValue(
        { phone: phone as string },
        'phone',
        '{{1}}'
      );
      expect(out).toBe('');
    });
  }

  it('a normal phone is unchanged', () => {
    expect(
      resolveVariables(vars, { ...base, phone: '+5511999990000' } as Contact)
    ).toEqual(['+5511999990000']);
    expect(previewFieldValue({ phone: '+55' }, 'phone', '{{1}}')).toBe('+55');
  });

  it('other fields keep the placeholder fallback in the preview', () => {
    expect(previewFieldValue({ email: undefined }, 'email', '{{2}}')).toBe(
      '{{2}}'
    );
  });
});
