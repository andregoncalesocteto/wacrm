import { describe, expect, it } from 'vitest';
import {
  buildPayload,
  initialValues,
  validateValues,
} from '../../descriptor-form';
import { capabilityChips } from '../../wizard';
import { telegramProvider } from './index';
import { telegramDescriptor } from './descriptor';

const fields = telegramDescriptor.fields;
const REAL_SHAPE = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_';

describe('telegram descriptor', () => {
  it('is what the provider serves', () => {
    expect(telegramProvider.descriptor).toBe(telegramDescriptor);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      name: 'bot_token',
      type: 'secret',
      required: true,
      target: 'credentials',
    });
  });

  it('requires the token and checks its shape', () => {
    const blank = initialValues(fields);
    expect(validateValues(fields, blank)).toEqual({ bot_token: 'required' });
    for (const bad of [
      'abc',
      '123:short',
      'x:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
      'a b',
    ]) {
      expect(validateValues(fields, { bot_token: bad })).toEqual({
        bot_token: 'pattern',
      });
    }
    expect(validateValues(fields, { bot_token: REAL_SHAPE })).toEqual({});
  });

  it('sends the token as a credential, never as config', () => {
    expect(buildPayload(fields, { bot_token: ` ${REAL_SHAPE} ` })).toEqual({
      config: {},
      credentials: { bot_token: REAL_SHAPE },
    });
  });

  it('shows what the channel cannot do as chips', () => {
    expect(capabilityChips(telegramProvider.capabilities)).toEqual([
      'noTemplates',
      'noList',
      'noReadReceipts',
      'afterInbound',
    ]);
  });
});
