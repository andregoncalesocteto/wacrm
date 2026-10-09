import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CONTRACT_STATUS,
  CONTRACT_STATUS_MESSAGE_KEY,
} from './contract-status';

describe('contract status label', () => {
  it('is one of the two known statuses and starts pre-stable (the pilot has not integrated)', () => {
    expect(Object.keys(CONTRACT_STATUS_MESSAGE_KEY)).toContain(CONTRACT_STATUS);
    expect(CONTRACT_STATUS).toBe('pre-stable');
  });

  it.each(['en', 'es', 'pt', 'ko'])(
    'has a text for every status and for the support note in %s',
    (locale) => {
      const messages = JSON.parse(
        readFileSync(
          path.join(process.cwd(), 'messages', `${locale}.json`),
          'utf8'
        )
      ).Developers;
      for (const key of Object.values(CONTRACT_STATUS_MESSAGE_KEY)) {
        expect(messages[key], `${locale}.${key}`).toBeTruthy();
      }
      expect(messages.supportNote).toBeTruthy();
      expect(messages.tryItOutNotice).toBeTruthy();
    }
  );
});
