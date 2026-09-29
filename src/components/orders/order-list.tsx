'use client';

import { ShoppingBag } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { formatCurrency } from '@/lib/currency';

export interface OrderItemData {
  id: string;
  name: string | null;
  quantity: number;
  unit_price: number;
}

export interface OrderSummaryData {
  id: string;
  external_order_id: string;
  status: string;
  value: number;
  currency: string;
  items: OrderItemData[];
  placed_at: string;
}

const KNOWN_STATUSES = new Set([
  'placed',
  'received',
  'preparing',
  'finished',
  'out_for_delivery',
  'ready_for_pickup',
  'delivered',
  'cancelled',
]);

/**
 * Orders placed on the Digital menu: number, status, total and items. Renders
 * nothing when there are none, so contacts and deals without orders are
 * unchanged. Shared by the inbox sidebar and the deal sheet.
 */
export function OrderList({ orders }: { orders: OrderSummaryData[] }) {
  const t = useTranslations('Orders');
  const locale = useLocale();

  if (orders.length === 0) return null;

  return (
    <div>
      <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs font-medium tracking-wider uppercase">
        <ShoppingBag className="h-3 w-3" />
        {t('title')}
      </div>
      <div className="mt-2 space-y-2">
        {orders.map((order) => {
          const items = Array.isArray(order.items) ? order.items : [];
          return (
            <div key={order.id} className="bg-muted rounded-lg px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <p className="text-foreground text-sm font-medium break-all">
                  {t('orderNumber', { id: order.external_order_id })}
                </p>
                <span className="bg-background text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 text-[10px]">
                  {KNOWN_STATUSES.has(order.status)
                    ? t(`status.${order.status}`)
                    : order.status}
                </span>
              </div>
              <p className="text-foreground mt-1 text-xs font-semibold">
                {formatCurrency(order.value, order.currency, locale)}
              </p>
              <ul className="text-muted-foreground mt-1 space-y-0.5 text-xs">
                {items.map((item, i) => (
                  <li key={`${item.id}-${i}`} className="flex gap-1">
                    <span className="shrink-0">
                      {t('itemQuantity', { quantity: item.quantity })}
                    </span>
                    <span className="break-words">{item.name || item.id}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
