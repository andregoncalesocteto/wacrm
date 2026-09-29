/**
 * Order-journey domain constants (ticket #3). Channel-agnostic: nothing in
 * `lib/journeys` imports a channel-specific module.
 */

/** `contact_identities.kind` of a Tracking token. CRM-owned, not a channel's. */
export const IDTRACK_KIND = 'idtrack';

/** Query parameter the Digital menu echoes back to wacrm. */
export const IDTRACK_PARAM = 'idtrack';

/** Message variable that expands to the store's menu link (`{{menu_link}}`). */
export const MENU_LINK_VARIABLE = 'menu_link';

/** A Tracking token stays valid this long, renewed by every new link sent. */
export const TRACKING_TOKEN_TTL_DAYS = 30;

/** `pipelines.system_key` of the CRM-managed pipeline. */
export const JOURNEY_PIPELINE_KEY = 'order_journey';
export const JOURNEY_PIPELINE_NAME = 'Jornada de Pedido';

export type JourneyStage =
  'link_sent' | 'browsing' | 'cart' | 'checkout' | 'won' | 'lost';

/** Funnel order (`position`); `won`/`lost` are terminal. */
export const JOURNEY_STAGES: readonly {
  key: JourneyStage;
  name: string;
  color: string;
}[] = [
  { key: 'link_sent', name: 'Link enviado', color: '#3b82f6' },
  { key: 'browsing', name: 'Navegando', color: '#8b5cf6' },
  { key: 'cart', name: 'Carrinho', color: '#f59e0b' },
  { key: 'checkout', name: 'Checkout', color: '#f97316' },
  { key: 'won', name: 'Comprou', color: '#22c55e' },
  { key: 'lost', name: 'Perdido', color: '#ef4444' },
];

export type JourneyState = 'open' | 'won' | 'lost';
