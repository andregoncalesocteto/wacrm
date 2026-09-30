import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('lib/consent and channels/ingest.ts', () => {
  it('never import a channel-specific module (whatsapp, providers, telegram)', () => {
    const files = readdirSync(__dirname)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => join(__dirname, f));
    files.push(join(__dirname, '../channels/ingest.ts'));
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(
        /from ['"](@\/lib\/(whatsapp|channels\/providers|telegram)|\.\/providers)/
      );
    }
  });
});
