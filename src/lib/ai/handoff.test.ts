import { describe, it, expect } from 'vitest';
import { buildHandoffSummary } from './handoff';

describe('buildHandoffSummary', () => {
  it('notes the reply count and quotes the last customer message', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello! How can I help?' },
        { role: 'user', content: 'I want a refund' },
      ],
      replyCount: 2,
    });
    expect(summary).toBe(
      '🤖 AI agent handed off after 2 replies. Last customer message: “I want a refund”'
    );
  });

  it('uses the singular "reply" for a count of one', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: 'help' }],
      replyCount: 1,
    });
    expect(summary).toContain('after 1 reply.');
  });

  it('says "without replying" when the bot bailed on the first inbound', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: 'agent please' }],
      replyCount: 0,
    });
    expect(summary).toContain('handed off without replying.');
    expect(summary).toContain('“agent please”');
  });

  it('picks the most recent customer turn, ignoring assistant turns', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'a reply' },
      ],
      replyCount: 1,
    });
    expect(summary).toContain('“second”');
  });

  it('collapses whitespace and truncates a long message', () => {
    const long = 'x'.repeat(300);
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: long }],
      replyCount: 0,
    });
    expect(summary).toContain('…');
    // 160-char cap on the quote; the whole note stays well under 250.
    expect(summary.length).toBeLessThan(250);
  });

  it('degrades gracefully when there is no customer message', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'assistant', content: 'greeting' }],
      replyCount: 0,
    });
    expect(summary).toBe('🤖 AI agent handed off without replying.');
  });

  describe('with Journey state', () => {
    const now = new Date('2026-05-01T12:00:00Z');
    const messages = [{ role: 'user' as const, content: 'where is it?' }];
    const minutesAgo = (m: number) =>
      new Date(now.getTime() - m * 60_000).toISOString();

    it('shows stage, cart, order status with elapsed time and last event', () => {
      const summary = buildHandoffSummary({
        messages,
        replyCount: 2,
        now,
        journey: {
          stageName: 'Carrinho',
          state: 'open',
          cart: { itemsCount: 2, value: 89.8, currency: 'BRL' },
          order: {
            externalOrderId: 'PED-1042',
            status: 'preparing',
            since: minutesAgo(40),
          },
          lastEventName: 'AddToCart',
        },
      });
      expect(summary).toBe(
        '🤖 AI agent handed off after 2 replies. Journey: Carrinho (2 items, R$89.80). Order PED-1042: preparing since 40 min. Last event: AddToCart. Last customer message: “where is it?”'
      );
    });

    it('formats hours and days, and underscores in statuses', () => {
      const build = (m: number) =>
        buildHandoffSummary({
          messages,
          replyCount: 1,
          now,
          journey: {
            stageName: 'Comprou',
            state: 'won',
            cart: null,
            order: {
              externalOrderId: 'A1',
              status: 'out_for_delivery',
              since: minutesAgo(m),
            },
            lastEventName: null,
          },
        });
      expect(build(125)).toContain('out for delivery since 2 h 5 min');
      expect(build(60 * 24 * 3)).toContain('since 3 d');
      expect(build(0)).toContain('since under 1 min');
      expect(build(125)).not.toContain('Last event');
    });

    it('uses the singular for a one-item cart', () => {
      const summary = buildHandoffSummary({
        messages,
        replyCount: 1,
        now,
        journey: {
          stageName: 'Carrinho',
          state: 'open',
          cart: { itemsCount: 1, value: 10, currency: 'USD' },
          order: null,
          lastEventName: null,
        },
      });
      expect(summary).toContain('(1 item, $10.00)');
    });

    it('is identical to the plain note when journey is null or absent', () => {
      const plain = buildHandoffSummary({ messages, replyCount: 2 });
      expect(
        buildHandoffSummary({ messages, replyCount: 2, journey: null })
      ).toBe(plain);
    });
  });
});
