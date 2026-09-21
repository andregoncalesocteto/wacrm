import { describe, expect, it } from 'vitest';
import { buildPayload, initialValues, validateValues } from './descriptor-form';
import type { DescriptorField } from './types';

const fields: DescriptorField[] = [
  { name: 'bot_username', target: 'config', type: 'text', pattern: '^@?\\w+$' },
  { name: 'bot_token', target: 'credentials', type: 'secret', required: true },
  {
    name: 'mode',
    target: 'config',
    type: 'select',
    options: ['a', 'b'],
    required: true,
  },
  { name: 'notify', target: 'config', type: 'switch' },
];

describe('descriptor-form', () => {
  it('starts empty, switches off', () => {
    expect(initialValues(fields)).toEqual({
      bot_username: '',
      bot_token: '',
      mode: '',
      notify: false,
    });
  });

  it('flags required secrets and selects that are blank', () => {
    const errors = validateValues(fields, initialValues(fields));
    expect(errors).toEqual({ bot_token: 'required', mode: 'required' });
  });

  it('treats whitespace as empty', () => {
    const v = { ...initialValues(fields), bot_token: '   ', mode: 'a' };
    expect(validateValues(fields, v)).toEqual({ bot_token: 'required' });
  });

  it('checks the pattern only when filled, and select membership', () => {
    const v = {
      ...initialValues(fields),
      bot_username: 'not ok!',
      bot_token: 'x',
      mode: 'z',
    };
    expect(validateValues(fields, v)).toEqual({
      bot_username: 'pattern',
      mode: 'pattern',
    });
  });

  it('ignores an invalid descriptor pattern', () => {
    const f: DescriptorField[] = [
      { name: 'x', target: 'config', type: 'text', pattern: '(' },
    ];
    expect(validateValues(f, { x: 'v' })).toEqual({});
  });

  it('splits config and credentials, trims, drops empty optionals', () => {
    const v = {
      bot_username: '  @shop ',
      bot_token: ' 123:abc ',
      mode: 'b',
      notify: true,
    };
    expect(buildPayload(fields, v)).toEqual({
      config: { bot_username: '@shop', mode: 'b', notify: true },
      credentials: { bot_token: '123:abc' },
    });
    expect(buildPayload(fields, initialValues(fields))).toEqual({
      config: { notify: false },
      credentials: {},
    });
  });
});
