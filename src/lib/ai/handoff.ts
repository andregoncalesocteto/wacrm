import type { ChatMessage } from './types';
import { formatCurrency } from '@/lib/currency';
import type { JourneyHandoffState } from '@/lib/journeys';

/** Longest the quoted customer message runs before we ellipsize it —
 *  keeps the internal note to a glanceable one-liner. */
const MAX_QUOTE_LEN = 160;

/**
 * Build the short internal note the auto-reply bot leaves on a
 * conversation when it hands off to a human. Deterministic — composed
 * from context we already have (no extra LLM call / token spend), so it
 * can't fail or add latency to the handoff.
 *
 * Reads as, e.g.:
 *   "🤖 AI agent handed off after 2 replies. Last customer message:
 *    “can I speak to a manager about my refund?”"
 *
 * `replyCount` is the bot's auto-reply tally for the thread (0 when it
 * bailed on the very first inbound without answering).
 *
 * When the contact has an order Journey, its state is added before the
 * customer quote, e.g.:
 *   "🤖 AI agent handed off after 2 replies. Journey: Carrinho (2 items,
 *    $89.80). Order PED-1042: preparing since 40 min. Last event:
 *    AddToCart. Last customer message: …"
 * Without `journey` the note is exactly the one above. The note is stored
 * text in a fixed language (English, like the rest of it), not UI.
 */
export function buildHandoffSummary(args: {
  messages: ChatMessage[];
  replyCount: number;
  journey?: JourneyHandoffState | null;
  now?: Date;
  locale?: string;
}): string {
  const { messages, replyCount, journey } = args;

  const lastCustomer = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && m.content.trim());

  const replies =
    replyCount === 0
      ? 'without replying'
      : `after ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`;

  const base = `🤖 AI agent handed off ${replies}.${
    journey
      ? ` ${describeJourney(journey, args.now ?? new Date(), args.locale)}`
      : ''
  }`;

  if (!lastCustomer) return base;

  const quote = truncate(lastCustomer.content.trim(), MAX_QUOTE_LEN);
  return `${base} Last customer message: “${quote}”`;
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ');
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

function describeJourney(
  j: JourneyHandoffState,
  now: Date,
  locale = 'en'
): string {
  const parts: string[] = [];

  let journey = `Journey: ${j.stageName}`;
  if (j.cart) {
    const items = `${j.cart.itemsCount} ${j.cart.itemsCount === 1 ? 'item' : 'items'}`;
    journey += ` (${items}, ${formatCurrency(j.cart.value, j.cart.currency, locale, 2)})`;
  }
  parts.push(journey);

  if (j.order) {
    const status = j.order.status.replace(/_/g, ' ');
    const elapsed = formatElapsed(now.getTime() - Date.parse(j.order.since));
    parts.push(
      `Order ${j.order.externalOrderId}: ${status}${elapsed ? ` since ${elapsed}` : ''}`
    );
  }
  if (j.lastEventName) parts.push(`Last event: ${j.lastEventName}`);

  return `${parts.join('. ')}.`;
}

/** "40 min", "2 h 5 min", "3 d"; empty when the timestamp is unusable. */
function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return 'under 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  return `${Math.floor(hours / 24)} d`;
}
