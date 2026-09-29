import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('lib/journeys', () => {
  it('never imports a channel-specific module (whatsapp, providers)', () => {
    const files = readdirSync(__dirname).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src, f).not.toMatch(
        /from ['"]@\/lib\/(whatsapp|channels\/providers|telegram)/
      );
    }
  });
});
