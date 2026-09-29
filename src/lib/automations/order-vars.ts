import { formatCurrency } from '@/lib/currency';

/**
 * The order an automation run is about: the order status change (trigger
 * `order_status_changed`) or the Purchase that placed it (trigger
 * `journey_event`). Stored in the run context, so it survives waits.
 */
export interface AutomationOrderContext {
  /** The menu's own order id (`orders.external_order_id`). */
  external_id: string;
  /** Status the order has now (`placed` for the Purchase itself). */
  status: string;
  /** Status before the change, when there was one. */
  previous_status?: string | null;
  value?: number | null;
  currency?: string | null;
  items?: {
    id?: string;
    name?: string;
    quantity?: number;
    unit_price?: number;
  }[];
}

/**
 * Order variables for message texts: `{{order_id}}`, `{{order_status}}` (the
 * status code, e.g. `out_for_delivery`; the CRM texts are written per status)
 * and `{{order_value}}` (currency-formatted). Empty when the run has no order.
 * `locale` is a parameter: the value is formatted with the app currency helper.
 */
export function orderVariable(
  order: AutomationOrderContext | undefined,
  name: string,
  locale: string
): string {
  if (!order) return '';
  switch (name) {
    case 'order_id':
      return order.external_id;
    case 'order_status':
      return order.status;
    case 'order_value':
      return order.value != null && Number.isFinite(Number(order.value))
        ? formatCurrency(
            Number(order.value),
            order.currency || undefined,
            locale,
            2
          )
        : '';
    default:
      return '';
  }
}
