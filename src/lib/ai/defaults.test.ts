import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from './defaults';

describe('buildSystemPrompt — menu link', () => {
  it('teaches the auto-reply model to use the {{menu_link}} placeholder', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' });
    expect(prompt).toContain('{{menu_link}}');
    expect(prompt).toContain('Never write a menu URL yourself');
  });

  it('does not mention it in draft mode (a human sends those)', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'draft' });
    expect(prompt).not.toContain('{{menu_link}}');
  });
});
